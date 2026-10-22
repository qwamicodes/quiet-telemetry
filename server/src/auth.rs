//! The HTTP side of accounts: the session gate in front of `/api/*`, the
//! session cookie, CSRF checks and login backoff. Accounts themselves live in
//! `accounts.rs`; the routes in `auth_api.rs`.
//!
//! - Every `/api/*` route except the public auth routes (`/api/auth/state`,
//!   setup, sign in, invite and reset links) needs a session cookie. `/health`
//!   and `/ready` stay open, and ingest endpoints use `qi_` tokens instead.
//! - `GET /api/export` with `Authorization: Bearer qx_…` skips the session (the
//!   export handler checks the token), so a copied curl works on its own.
//! - Cookie: `quiet_session`, HttpOnly, SameSite=Lax, Path=/, Secure when the
//!   request came over https (`X-Forwarded-Proto: https` from the proxy), or
//!   always / never with `QUIET_COOKIE_SECURE=on|off`.
//! - CSRF: unsafe methods (anything but GET/HEAD/OPTIONS) and WebSocket
//!   upgrades must be same-origin (`Origin`, else `Referer`, must match `Host`
//!   or `X-Forwarded-Host`; `Sec-Fetch-Site: cross-site` is refused), and
//!   cookie-authenticated unsafe requests must also send the session's CSRF
//!   token in `X-Quiet-Csrf`.
//! - Login backoff: per email and per client address, a few free failures,
//!   then an exponentially growing lockout (429 + `Retry-After`).
//! - `QUIET_AUTH=off` (local development, loopback only) treats every request
//!   as a local owner and skips all of the above.

// Handlers return early with a ready `Response`; boxing it buys nothing here.
#![allow(clippy::result_large_err)]

use crate::accounts::{Role, SessionUser, User};
use crate::api::AppState;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use clap::ValueEnum;
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

pub const COOKIE: &str = "quiet_session";
pub const CSRF_HEADER: &str = "x-quiet-csrf";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AuthMode {
    /// Accounts and sessions (the default).
    On,
    /// No sign-in: every request is a local owner. Loopback only.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CookieSecure {
    /// Secure when the request arrived over https (via `X-Forwarded-Proto`).
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub mode: AuthMode,
    pub cookie_secure: CookieSecure,
    /// Take the client address from `X-Forwarded-For` (rightmost hop) / `X-Real-IP`.
    pub trust_proxy: bool,
}

impl Default for AuthConfig {
    fn default() -> Self {
        AuthConfig {
            mode: AuthMode::On,
            cookie_secure: CookieSecure::Auto,
            trust_proxy: false,
        }
    }
}

impl AuthConfig {
    #[cfg(test)]
    pub fn off() -> Self {
        AuthConfig {
            mode: AuthMode::Off,
            ..Default::default()
        }
    }
    pub fn enabled(&self) -> bool {
        self.mode == AuthMode::On
    }
}

/// Who is making a request, put into the request by [`gate`].
#[derive(Debug, Clone)]
pub struct Viewer {
    pub user: User,
    /// `None` with `QUIET_AUTH=off`.
    pub session_id: Option<i64>,
}

impl Viewer {
    pub fn is_owner(&self) -> bool {
        self.user.role == Role::Owner
    }

    /// The stand-in user when auth is off.
    pub fn local() -> Self {
        Viewer {
            user: User {
                id: 0,
                email: "local@quiet".into(),
                name: "local".into(),
                role: Role::Owner,
                created: 0,
                password_changed: 0,
            },
            session_id: None,
        }
    }
}

pub fn error(status: StatusCode, code: &str, msg: &str) -> Response {
    (status, Json(json!({ "error": msg, "code": code }))).into_response()
}

/// 403 unless the viewer is an owner.
pub fn require_owner(v: &Viewer) -> Result<(), Response> {
    if v.is_owner() {
        Ok(())
    } else {
        Err(error(
            StatusCode::FORBIDDEN,
            "owner_only",
            "only an owner can do this",
        ))
    }
}

// ---- cookies ------------------------------------------------------------------

pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim().to_string())
}

fn is_https(cfg: &AuthConfig, headers: &HeaderMap) -> bool {
    match cfg.cookie_secure {
        CookieSecure::On => true,
        CookieSecure::Off => false,
        CookieSecure::Auto => headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').next().unwrap_or("").trim() == "https"),
    }
}

/// `Set-Cookie` for a new session. Browser-session cookie unless `max_age_s`.
pub fn session_cookie(
    cfg: &AuthConfig,
    headers: &HeaderMap,
    secret: &str,
    max_age_s: Option<i64>,
) -> HeaderValue {
    let mut c = format!("{COOKIE}={secret}; Path=/; HttpOnly; SameSite=Lax");
    if let Some(s) = max_age_s {
        c.push_str(&format!("; Max-Age={s}"));
    }
    if is_https(cfg, headers) {
        c.push_str("; Secure");
    }
    HeaderValue::from_str(&c).expect("cookie is ascii")
}

pub fn clear_cookie(cfg: &AuthConfig, headers: &HeaderMap) -> HeaderValue {
    let mut c = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    if is_https(cfg, headers) {
        c.push_str("; Secure");
    }
    HeaderValue::from_str(&c).expect("cookie is ascii")
}

// ---- client address -----------------------------------------------------------

pub fn client_ip(
    cfg: &AuthConfig,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Option<String> {
    if cfg.trust_proxy {
        let fwd = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .or_else(|| headers.get("x-real-ip").and_then(|v| v.to_str().ok()))
            .and_then(|v| v.trim().parse::<IpAddr>().ok());
        if let Some(ip) = fwd {
            return Some(ip.to_string());
        }
    }
    peer.map(|p| p.ip().to_string())
}

// ---- CSRF -----------------------------------------------------------------------

fn host_of_url(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then_some(host)
}

/// The request's own host (`Host`, or `X-Forwarded-Host` when a proxy rewrote it).
fn own_hosts(headers: &HeaderMap) -> Vec<String> {
    ["x-forwarded-host", "host"]
        .iter()
        .filter_map(|h| headers.get(*h)?.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Same-origin check for unsafe requests. A request with neither `Origin` nor
/// `Referer` (curl, scripts) passes: browsers always send one on these
/// requests, and cookie-authenticated ones still need the CSRF token.
pub fn same_origin(headers: &HeaderMap) -> bool {
    if headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("cross-site"))
    {
        return false;
    }
    let claimed = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|v| *v != "null")
        .or_else(|| headers.get(header::REFERER).and_then(|v| v.to_str().ok()));
    let Some(claimed) = claimed else {
        // `Origin: null` (sandboxed frames, some redirects) is never same-origin.
        return headers.get(header::ORIGIN).is_none();
    };
    let Some(host) = host_of_url(claimed) else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    own_hosts(headers).contains(&host)
}

fn is_unsafe(m: &Method) -> bool {
    !matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn is_ws_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn cross_site() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "cross_site",
        "cross-site request refused",
    )
}

/// For the public auth routes: same-origin unsafe requests only (login CSRF).
pub async fn origin_gate(State(s): State<AppState>, req: Request, next: Next) -> Response {
    if s.auth.enabled() && is_unsafe(req.method()) && !same_origin(req.headers()) {
        return cross_site();
    }
    next.run(req).await
}

/// The session gate in front of every protected `/api` route.
pub async fn gate(State(s): State<AppState>, mut req: Request, next: Next) -> Response {
    if !s.auth.enabled() {
        req.extensions_mut().insert(Viewer::local());
        return next.run(req).await;
    }
    let unsafe_method = is_unsafe(req.method());
    if (unsafe_method || is_ws_upgrade(req.headers())) && !same_origin(req.headers()) {
        return cross_site();
    }
    // A copied export curl carries its own read-only token.
    if req.uri().path() == "/api/export" && req.headers().contains_key(header::AUTHORIZATION) {
        return next.run(req).await;
    }
    let Some(secret) = read_cookie(req.headers(), COOKIE) else {
        return error(
            StatusCode::UNAUTHORIZED,
            "session_required",
            "sign in first",
        );
    };
    let now = chrono::Utc::now().timestamp_millis();
    let found = {
        let accounts = s.accounts.clone();
        tokio::task::spawn_blocking(move || accounts.session(&secret, now))
            .await
            .unwrap_or_else(|e| Err(crate::accounts::AccountError::Store(e.to_string())))
    };
    let su: SessionUser = match found {
        Ok(Some(su)) => su,
        Ok(None) => {
            let mut res = error(
                StatusCode::UNAUTHORIZED,
                "session_expired",
                "your session expired; sign in again",
            );
            res.headers_mut()
                .insert(header::SET_COOKIE, clear_cookie(&s.auth, req.headers()));
            return res;
        }
        Err(e) => {
            tracing::error!(error = ?e, "session lookup failed");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "account store unavailable",
            );
        }
    };
    if unsafe_method {
        let sent = req
            .headers()
            .get(CSRF_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !constant_eq(sent.as_bytes(), su.csrf.as_bytes()) {
            return error(
                StatusCode::FORBIDDEN,
                "csrf",
                "missing or stale CSRF token; reload the page",
            );
        }
    }
    req.extensions_mut().insert(Viewer {
        user: su.user,
        session_id: Some(su.session_id),
    });
    next.run(req).await
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---- login backoff --------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Failures {
    count: u32,
    last: i64,
}

/// Failed sign-ins per key (`email:…`, `ip:…`). After `free` failures inside
/// the window each further one doubles the wait (1 s, 2 s, 4 s … 15 min).
pub struct LoginLimiter {
    map: Mutex<HashMap<String, Failures>>,
}

pub const EMAIL_FREE: u32 = 5;
pub const IP_FREE: u32 = 20;
const WINDOW_MS: i64 = 15 * 60_000;
const MAX_LOCK_MS: i64 = 15 * 60_000;

impl Default for LoginLimiter {
    fn default() -> Self {
        LoginLimiter {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl LoginLimiter {
    fn lock_ms(count: u32, free: u32) -> i64 {
        if count < free {
            return 0;
        }
        let n = (count - free).min(20);
        (1000i64 << n).min(MAX_LOCK_MS)
    }

    /// `Err(seconds)` while any of the keys is locked.
    pub fn check(&self, keys: &[(&str, u32)], now: i64) -> Result<(), u64> {
        let map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        let mut wait = 0i64;
        for (k, free) in keys {
            if let Some(f) = map.get(*k) {
                if now - f.last > WINDOW_MS {
                    continue;
                }
                let until = f.last + Self::lock_ms(f.count, *free);
                wait = wait.max(until - now);
            }
        }
        if wait > 0 {
            Err(((wait + 999) / 1000) as u64)
        } else {
            Ok(())
        }
    }

    pub fn fail(&self, keys: &[(&str, u32)], now: i64) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 10_000 {
            map.retain(|_, f| now - f.last <= WINDOW_MS);
        }
        for (k, _) in keys {
            let f = map.entry(k.to_string()).or_insert(Failures {
                count: 0,
                last: now,
            });
            if now - f.last > WINDOW_MS {
                f.count = 0;
            }
            f.count += 1;
            f.last = now;
        }
    }

    pub fn clear(&self, key: &str) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn origin_checks() {
        assert!(same_origin(&h(&[("host", "q.example.com")])));
        assert!(same_origin(&h(&[
            ("host", "q.example.com"),
            ("origin", "https://q.example.com")
        ])));
        assert!(same_origin(&h(&[
            ("host", "127.0.0.1:5173"),
            ("origin", "http://127.0.0.1:5173")
        ])));
        assert!(!same_origin(&h(&[
            ("host", "q.example.com"),
            ("origin", "https://evil.example")
        ])));
        assert!(!same_origin(&h(&[
            ("host", "q.example.com"),
            ("origin", "null")
        ])));
        assert!(same_origin(&h(&[
            ("host", "quiet:7070"),
            ("x-forwarded-host", "q.example.com"),
            ("origin", "https://q.example.com")
        ])));
        assert!(same_origin(&h(&[
            ("host", "q.example.com"),
            ("referer", "https://q.example.com/settings")
        ])));
        assert!(!same_origin(&h(&[
            ("host", "q.example.com"),
            ("sec-fetch-site", "cross-site")
        ])));
    }

    #[test]
    fn cookies_parse_and_secure_follows_proto() {
        let m = h(&[("cookie", "a=1; quiet_session=abc ; b=2")]);
        assert_eq!(read_cookie(&m, COOKIE).as_deref(), Some("abc"));
        let cfg = AuthConfig::default();
        let c = session_cookie(&cfg, &h(&[("x-forwarded-proto", "https")]), "s", Some(60));
        let c = c.to_str().unwrap();
        assert!(c.contains("HttpOnly") && c.contains("SameSite=Lax") && c.ends_with("Secure"));
        assert!(c.contains("Max-Age=60"));
        let c = session_cookie(&cfg, &HeaderMap::new(), "s", None);
        assert!(!c.to_str().unwrap().contains("Secure"));
        assert!(!c.to_str().unwrap().contains("Max-Age"));
    }

    #[test]
    fn forwarded_ip_only_when_trusted() {
        let m = h(&[("x-forwarded-for", "1.1.1.1, 2.2.2.2")]);
        let peer: SocketAddr = "10.0.0.1:5000".parse().unwrap();
        let mut cfg = AuthConfig::default();
        assert_eq!(client_ip(&cfg, &m, Some(peer)).as_deref(), Some("10.0.0.1"));
        cfg.trust_proxy = true;
        assert_eq!(client_ip(&cfg, &m, Some(peer)).as_deref(), Some("2.2.2.2"));
    }

    #[test]
    fn backoff_grows_and_resets() {
        let l = LoginLimiter::default();
        let keys = [("email:a", EMAIL_FREE)];
        for i in 0..4 {
            l.fail(&keys, i);
            assert!(l.check(&keys, i).is_ok());
        }
        l.fail(&keys, 10); // 5th failure: 1 s lock
        assert_eq!(l.check(&keys, 10), Err(1));
        assert!(l.check(&keys, 1010).is_ok());
        l.fail(&keys, 1010); // 6th: 2 s
        assert_eq!(l.check(&keys, 1010), Err(2));
        // Quiet for longer than the window: forgiven.
        assert!(l.check(&keys, 1010 + WINDOW_MS + 1).is_ok());
        l.clear("email:a");
        assert!(l.check(&keys, 1011).is_ok());
        assert_eq!(LoginLimiter::lock_ms(100, 5), MAX_LOCK_MS);
    }
}
