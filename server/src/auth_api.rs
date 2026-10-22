//! Account routes.
//!
//! Public (same-origin checked, no session):
//!   GET  /api/auth/state             { auth, setup_required, user, csrf, version, host }
//!   POST /api/auth/setup             first run only → owner + session      (201)
//!   POST /api/auth/login             { email, password, remember }         (429 when backing off)
//!   POST /api/auth/invite            { token } → the invite (410 expired/used/revoked)
//!   POST /api/auth/invite/accept     { token, name, email?, password } → member + session
//!   POST /api/auth/reset             { token } → who the reset link is for
//!   POST /api/auth/reset/accept      { token, password } → signs out everywhere
//!
//! Session (any role):
//!   POST   /api/auth/logout
//!   GET    /api/account · PATCH /api/account { name, email, password? }
//!   POST   /api/account/password     { current, password } → other sessions signed out
//!   GET    /api/account/sessions · DELETE /api/account/sessions/:id
//!   POST   /api/account/sessions/sign-out-others
//!   GET    /api/members              members (+ pending invites for owners)
//!
//! Owner only:
//!   PATCH  /api/members/:id { role } · DELETE /api/members/:id
//!   POST   /api/members/:id/reset-link → one-time link, 24 h
//!   POST   /api/invites { email?, role } → copy link, 7 days · DELETE /api/invites/:id

// Handlers return early with a ready `Response`; boxing it buys nothing here.
#![allow(clippy::result_large_err)]

use crate::accounts::{
    self, check_password, clean_name, normalize_email, AccountError, Accounts, Invite, Member,
    Role, SessionInfo, User, RESET_TTL_MS, SESSION_LONG_MS,
};
use crate::api::AppState;
use crate::auth::{self, client_ip, error, require_owner, Viewer};
use crate::receiver::DockerStatus;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use ts_rs::TS;

pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/state", get(state))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/invite", post(invite_lookup))
        .route("/api/auth/invite/accept", post(invite_accept))
        .route("/api/auth/reset", post(reset_lookup))
        .route("/api/auth/reset/accept", post(reset_accept))
}

pub fn session_routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/logout", post(logout))
        .route("/api/account", get(account).patch(update_profile))
        .route("/api/account/password", post(change_password))
        .route("/api/account/sessions", get(sessions))
        .route("/api/account/sessions/:id", delete(sign_out_session))
        .route(
            "/api/account/sessions/sign-out-others",
            post(sign_out_others),
        )
        .route("/api/members", get(members))
        .route(
            "/api/members/:id",
            patch(update_member).delete(remove_member),
        )
        .route("/api/members/:id/reset-link", post(reset_link))
        .route("/api/invites", post(create_invite))
        .route("/api/invites/:id", delete(revoke_invite))
}

// ---- wire types -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename = "AuthMode")]
pub enum AuthModeWire {
    On,
    Off,
}

/// What the first-run setup page shows about this host.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SetupHost {
    pub docker: DockerStatus,
    pub store: String,
    pub data_dir: Option<String>,
    pub data_dir_writable: bool,
    pub retention_ms: i64,
    pub max_disk: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct AuthState {
    pub auth: AuthModeWire,
    /// No users yet: the UI shows owner setup.
    pub setup_required: bool,
    /// The signed-in user (the local owner when auth is off).
    pub user: Option<User>,
    /// Send back as `X-Quiet-Csrf` on every non-GET request.
    pub csrf: Option<String>,
    pub version: String,
    /// Only while setup is required.
    pub host: Option<SetupHost>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct SetupRequest {
    pub name: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    /// Keep me signed in for 30 days (default true).
    #[ts(optional)]
    pub remember: Option<bool>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SignedIn {
    pub user: User,
    pub csrf: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct TokenRequest {
    pub token: String,
}

/// An invite link that can't be used, with what the page can say about it.
#[derive(Debug, Clone, Serialize, TS)]
pub struct InviteProblem {
    pub error: String,
    /// `unknown`, `expired`, `used` or `revoked`.
    pub code: String,
    pub invite: Option<Invite>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct AcceptInvite {
    pub token: String,
    pub name: String,
    /// Ignored when the invite names an address.
    #[ts(optional)]
    pub email: Option<String>,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ResetInfo {
    pub email: String,
    pub name: String,
    pub expires: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CompleteReset {
    pub token: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateProfile {
    pub name: String,
    pub email: String,
    /// Needed when the email changes.
    #[ts(optional)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ChangePassword {
    pub current: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct PasswordChanged {
    pub user: User,
    /// Other sessions that were signed out.
    pub signed_out: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionsResponse {
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SignedOutOthers {
    pub signed_out: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct MembersResponse {
    pub members: Vec<Member>,
    /// Pending and expired invites; empty for members.
    pub invites: Vec<Invite>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateMember {
    pub role: Role,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CreateInvite {
    #[ts(optional)]
    pub email: Option<String>,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct CreatedInvite {
    pub invite: Invite,
    /// The `inv_…` secret. Shown once; only its hash is kept.
    pub token: String,
    /// `/invite/<token>`; the UI puts its origin in front.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ResetLink {
    pub token: String,
    /// `/reset/<token>`.
    pub path: String,
    pub expires: i64,
}

// ---- helpers -------------------------------------------------------------------------

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn fail(e: AccountError) -> Response {
    let (status, code) = match &e {
        AccountError::AlreadySetUp => (StatusCode::CONFLICT, "already_set_up"),
        AccountError::EmailTaken => (StatusCode::CONFLICT, "email_taken"),
        AccountError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid"),
        AccountError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        AccountError::WrongPassword => (StatusCode::BAD_REQUEST, "wrong_password"),
        AccountError::LastOwner => (StatusCode::CONFLICT, "last_owner"),
        AccountError::TokenUnknown => (StatusCode::NOT_FOUND, "unknown"),
        AccountError::TokenExpired => (StatusCode::GONE, "expired"),
        AccountError::TokenUsed => (StatusCode::GONE, "used"),
        AccountError::TokenRevoked => (StatusCode::GONE, "revoked"),
        AccountError::Store(m) => {
            tracing::error!(error = %m, "account store failed");
            (StatusCode::SERVICE_UNAVAILABLE, "store")
        }
    };
    error(status, code, &e.message())
}

/// Run account work (argon2, SQLite) off the async runtime.
async fn blocking<T: Send + 'static>(
    accounts: &Arc<Accounts>,
    f: impl FnOnce(&Accounts) -> accounts::Result<T> + Send + 'static,
) -> accounts::Result<T> {
    let a = accounts.clone();
    tokio::task::spawn_blocking(move || f(&a))
        .await
        .unwrap_or_else(|e| Err(AccountError::Store(e.to_string())))
}

fn auth_off() -> Response {
    error(
        StatusCode::CONFLICT,
        "auth_off",
        "auth is off on this server (QUIET_AUTH=off)",
    )
}

fn bad_json(what: &str) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "invalid",
        &format!("expected JSON {what}"),
    )
}

/// Create a session and answer with the user, the CSRF token and the cookie.
async fn sign_in(
    s: &AppState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    user: User,
    persistent: bool,
    status: StatusCode,
) -> Response {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let ip = client_ip(&s.auth, headers, peer);
    let uid = user.id;
    let t = now();
    let created = blocking(&s.accounts, move |a| {
        a.create_session(uid, persistent, ua.as_deref(), ip.as_deref(), t)
    })
    .await;
    let session = match created {
        Ok(ns) => ns,
        Err(e) => return fail(e),
    };
    let max_age = persistent.then_some(SESSION_LONG_MS / 1000);
    let cookie = auth::session_cookie(&s.auth, headers, &session.secret, max_age);
    let mut res = (
        status,
        Json(SignedIn {
            user,
            csrf: session.csrf,
        }),
    )
        .into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn data_dir_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(format!(".quiet-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

// ---- public ----------------------------------------------------------------------------

async fn state(State(s): State<AppState>, headers: HeaderMap) -> Response {
    let version = env!("CARGO_PKG_VERSION").to_string();
    if !s.auth.enabled() {
        return Json(AuthState {
            auth: AuthModeWire::Off,
            setup_required: false,
            user: Some(Viewer::local().user),
            csrf: None,
            version,
            host: None,
        })
        .into_response();
    }
    let cookie = auth::read_cookie(&headers, auth::COOKIE);
    let t = now();
    let looked = blocking(&s.accounts, move |a| {
        let setup = a.setup_required()?;
        let su = match cookie {
            Some(c) if !setup => a.session(&c, t)?,
            _ => None,
        };
        Ok((setup, su))
    })
    .await;
    let (setup_required, su) = match looked {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let host = setup_required.then(|| SetupHost {
        docker: s.docker.lock().unwrap().clone(),
        store: s.pipeline.store().kind().to_string(),
        data_dir: s.host.data_dir.as_ref().map(|d| d.display().to_string()),
        data_dir_writable: s.host.data_dir.as_deref().is_some_and(data_dir_writable),
        retention_ms: s.retention_ms,
        max_disk: s.host.max_disk,
    });
    let mut res = Json(AuthState {
        auth: AuthModeWire::On,
        setup_required,
        user: su.as_ref().map(|x| x.user.clone()),
        csrf: su.map(|x| x.csrf),
        version,
        host,
    })
    .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn setup(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<SetupRequest>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ name, email, password }");
    };
    let checked = (|| {
        let email = normalize_email(&req.email)?;
        let name = clean_name(&req.name)?;
        check_password(&req.password)?;
        Ok::<_, AccountError>((email, name))
    })();
    let (email, name) = match checked {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let t = now();
    let password = req.password;
    let created = blocking(&s.accounts, move |a| {
        // Cheap check first so a second setup doesn't pay for argon2.
        if !a.setup_required()? {
            return Err(AccountError::AlreadySetUp);
        }
        let phc = accounts::hash_password(&password)?;
        a.setup_owner(&email, &name, &phc, t)
    })
    .await;
    match created {
        Ok(user) => {
            tracing::info!(user = user.id, email = %user.email, "owner created at first-run setup");
            sign_in(
                &s,
                &headers,
                peer.map(|p| p.0),
                user,
                true,
                StatusCode::CREATED,
            )
            .await
        }
        Err(e) => fail(e),
    }
}

async fn login(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<LoginRequest>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ email, password }");
    };
    let email = req.email.trim().to_lowercase();
    let peer = peer.map(|p| p.0);
    let ip = client_ip(&s.auth, &headers, peer).unwrap_or_else(|| "unknown".into());
    let email_key = format!("email:{email}");
    let ip_key = format!("ip:{ip}");
    let keys = [
        (email_key.as_str(), auth::EMAIL_FREE),
        (ip_key.as_str(), auth::IP_FREE),
    ];
    let t = now();
    if let Err(secs) = s.limiter.check(&keys, t) {
        let mut res = error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            &format!("too many attempts; try again in {secs}s"),
        );
        if let Ok(v) = HeaderValue::from_str(&secs.to_string()) {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return res;
    }
    if req.password.len() > accounts::MAX_PASSWORD * 4 {
        return fail(AccountError::Invalid("password too long".into()));
    }
    let (e2, password) = (email.clone(), req.password);
    let found = blocking(&s.accounts, move |a| a.authenticate(&e2, &password)).await;
    match found {
        Ok(Some(user)) => {
            s.limiter.clear(&email_key);
            tracing::info!(user = user.id, "signed in");
            sign_in(
                &s,
                &headers,
                peer,
                user,
                req.remember.unwrap_or(true),
                StatusCode::OK,
            )
            .await
        }
        Ok(None) => {
            s.limiter.fail(&keys, now());
            tracing::info!(ip = %ip, "sign-in failed");
            error(
                StatusCode::UNAUTHORIZED,
                "bad_credentials",
                "email or password is wrong",
            )
        }
        Err(e) => fail(e),
    }
}

/// Bad invite/reset tokens count against the caller's address like failed sign-ins.
fn token_backoff(
    s: &AppState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<String, Response> {
    let ip = client_ip(&s.auth, headers, peer).unwrap_or_else(|| "unknown".into());
    let key = format!("ip:{ip}");
    if let Err(secs) = s.limiter.check(&[(key.as_str(), auth::IP_FREE)], now()) {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            &format!("too many attempts; try again in {secs}s"),
        ));
    }
    Ok(key)
}

fn invite_problem(s: &AppState, key: &str, e: AccountError, inv: Option<Invite>) -> Response {
    if e == AccountError::TokenUnknown {
        s.limiter.fail(&[(key, auth::IP_FREE)], now());
    }
    let status = match e {
        AccountError::TokenUnknown => StatusCode::NOT_FOUND,
        AccountError::Store(_) => return fail(e),
        _ => StatusCode::GONE,
    };
    let code = match e {
        AccountError::TokenExpired => "expired",
        AccountError::TokenUsed => "used",
        AccountError::TokenRevoked => "revoked",
        _ => "unknown",
    };
    (
        status,
        Json(InviteProblem {
            error: e.message(),
            code: code.into(),
            invite: inv,
        }),
    )
        .into_response()
}

async fn invite_lookup(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<TokenRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return bad_json("{ token }");
    };
    let key = match token_backoff(&s, &headers, peer.map(|p| p.0)) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let a = s.accounts.clone();
    let t = now();
    let r = tokio::task::spawn_blocking(move || a.invite_by_secret(req.token.trim(), t))
        .await
        .unwrap_or_else(|e| Err((AccountError::Store(e.to_string()), None)));
    match r {
        Ok(inv) => Json(inv).into_response(),
        Err((e, inv)) => invite_problem(&s, &key, e, inv),
    }
}

async fn invite_accept(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<AcceptInvite>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ token, name, email?, password }");
    };
    let peer = peer.map(|p| p.0);
    let key = match token_backoff(&s, &headers, peer) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let name = match clean_name(&req.name) {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    if let Err(e) = check_password(&req.password) {
        return fail(e);
    }
    let a = s.accounts.clone();
    let token = req.token.trim().to_string();
    let t = now();
    let looked = {
        let token = token.clone();
        tokio::task::spawn_blocking(move || a.invite_by_secret(&token, t))
            .await
            .unwrap_or_else(|e| Err((AccountError::Store(e.to_string()), None)))
    };
    let inv = match looked {
        Ok(inv) => inv,
        Err((e, inv)) => return invite_problem(&s, &key, e, inv),
    };
    let email = match inv.email.clone() {
        Some(e) => e,
        None => match normalize_email(req.email.as_deref().unwrap_or("")) {
            Ok(e) => e,
            Err(e) => return fail(e),
        },
    };
    let password = req.password;
    let created = blocking(&s.accounts, move |a| {
        let phc = accounts::hash_password(&password)?;
        a.accept_invite(&token, &email, &name, &phc, t)
    })
    .await;
    match created {
        Ok(user) => {
            tracing::info!(
                user = user.id,
                invite = inv.id,
                role = user.role.as_str(),
                "invite accepted"
            );
            sign_in(&s, &headers, peer, user, true, StatusCode::CREATED).await
        }
        Err(e) => fail(e),
    }
}

async fn reset_lookup(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<TokenRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return bad_json("{ token }");
    };
    let key = match token_backoff(&s, &headers, peer.map(|p| p.0)) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let t = now();
    let token = req.token.trim().to_string();
    match blocking(&s.accounts, move |a| a.reset_user(&token, t)).await {
        Ok((user, expires)) => Json(ResetInfo {
            email: user.email,
            name: user.name,
            expires,
        })
        .into_response(),
        Err(e) => {
            if e == AccountError::TokenUnknown {
                s.limiter.fail(&[(key.as_str(), auth::IP_FREE)], now());
            }
            fail(e)
        }
    }
}

async fn reset_accept(
    State(s): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<CompleteReset>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ token, password }");
    };
    let key = match token_backoff(&s, &headers, peer.map(|p| p.0)) {
        Ok(k) => k,
        Err(r) => return r,
    };
    if let Err(e) = check_password(&req.password) {
        return fail(e);
    }
    let t = now();
    let (token, password) = (req.token.trim().to_string(), req.password);
    let done = blocking(&s.accounts, move |a| {
        a.reset_user(&token, t)?; // fail fast before argon2
        let phc = accounts::hash_password(&password)?;
        a.complete_reset(&token, &phc, t)
    })
    .await;
    match done {
        Ok(user) => {
            tracing::info!(
                user = user.id,
                "password reset with a reset link; all sessions signed out"
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            if e == AccountError::TokenUnknown {
                s.limiter.fail(&[(key.as_str(), auth::IP_FREE)], now());
            }
            fail(e)
        }
    }
}

// ---- session -----------------------------------------------------------------------------

async fn logout(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    headers: HeaderMap,
) -> Response {
    if let Some(id) = v.session_id {
        let uid = v.user.id;
        if let Err(e) = blocking(&s.accounts, move |a| a.delete_session(uid, id)).await {
            return fail(e);
        }
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, auth::clear_cookie(&s.auth, &headers));
    res
}

async fn account(Extension(v): Extension<Viewer>) -> Json<User> {
    Json(v.user)
}

async fn update_profile(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<UpdateProfile>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ name, email }");
    };
    let (name, email) = match (clean_name(&req.name), normalize_email(&req.email)) {
        (Ok(n), Ok(e)) => (n, e),
        (Err(e), _) | (_, Err(e)) => return fail(e),
    };
    let uid = v.user.id;
    let email_changed = email != v.user.email;
    let password = req.password;
    let r = blocking(&s.accounts, move |a| {
        if email_changed {
            let phc = a.password_hash(uid)?;
            if !password
                .as_deref()
                .is_some_and(|p| accounts::verify_password(p, &phc))
            {
                return Err(AccountError::WrongPassword);
            }
        }
        a.update_profile(uid, &name, &email)
    })
    .await;
    match r {
        Ok(u) => {
            if email_changed {
                tracing::info!(user = uid, "email changed");
            }
            Json(u).into_response()
        }
        Err(e) => fail(e),
    }
}

async fn change_password(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<ChangePassword>>,
) -> Response {
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ current, password }");
    };
    if let Err(e) = check_password(&req.password) {
        return fail(e);
    }
    let (uid, keep) = (v.user.id, v.session_id);
    let t = now();
    let r = blocking(&s.accounts, move |a| {
        let phc = a.password_hash(uid)?;
        if !accounts::verify_password(&req.current, &phc) {
            return Err(AccountError::WrongPassword);
        }
        let new = accounts::hash_password(&req.password)?;
        a.set_password(uid, &new, t)?;
        let n = a.delete_sessions_except(uid, keep)?;
        Ok((a.user(uid)?.ok_or(AccountError::NotFound)?, n))
    })
    .await;
    match r {
        Ok((user, n)) => {
            tracing::info!(user = uid, signed_out = n, "password changed");
            Json(PasswordChanged {
                user,
                signed_out: n as u32,
            })
            .into_response()
        }
        Err(e) => fail(e),
    }
}

async fn sessions(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    let (uid, cur) = (v.user.id, v.session_id.unwrap_or(-1));
    let t = now();
    match blocking(&s.accounts, move |a| a.sessions(uid, cur, t)).await {
        Ok(sessions) => Json(SessionsResponse { sessions }).into_response(),
        Err(e) => fail(e),
    }
}

fn parse_id(id: &str) -> Result<i64, Response> {
    id.parse()
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid", "id must be a number"))
}

async fn sign_out_session(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    let id = match parse_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let uid = v.user.id;
    match blocking(&s.accounts, move |a| a.delete_session(uid, id)).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => fail(AccountError::NotFound),
        Err(e) => fail(e),
    }
}

async fn sign_out_others(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    let (uid, keep) = (v.user.id, v.session_id);
    match blocking(&s.accounts, move |a| a.delete_sessions_except(uid, keep)).await {
        Ok(n) => {
            tracing::info!(user = uid, signed_out = n, "signed out other sessions");
            Json(SignedOutOthers {
                signed_out: n as u32,
            })
            .into_response()
        }
        Err(e) => fail(e),
    }
}

async fn members(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    let owner = v.is_owner();
    let r = blocking(&s.accounts, move |a| {
        Ok((a.members()?, if owner { a.invites()? } else { Vec::new() }))
    })
    .await;
    match r {
        Ok((members, invites)) => Json(MembersResponse { members, invites }).into_response(),
        Err(e) => fail(e),
    }
}

async fn update_member(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
    body: Option<Json<UpdateMember>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let id = match parse_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let Some(Json(req)) = body else {
        return bad_json("{ role }");
    };
    match blocking(&s.accounts, move |a| a.set_role(id, req.role)).await {
        Ok(u) => {
            tracing::info!(
                by = v.user.id,
                user = id,
                role = u.role.as_str(),
                "role changed"
            );
            Json(u).into_response()
        }
        Err(e) => fail(e),
    }
}

async fn remove_member(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let id = match parse_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    if id == v.user.id {
        return error(
            StatusCode::CONFLICT,
            "self",
            "you can't remove yourself; ask another owner",
        );
    }
    match blocking(&s.accounts, move |a| a.remove_user(id)).await {
        Ok(u) => {
            tracing::info!(by = v.user.id, user = id, email = %u.email, "member removed");
            Json(u).into_response()
        }
        Err(e) => fail(e),
    }
}

async fn reset_link(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let id = match parse_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let by = v.user.email.clone();
    let t = now();
    match blocking(&s.accounts, move |a| {
        a.create_reset(id, &by, RESET_TTL_MS, t)
    })
    .await
    {
        Ok((token, expires)) => {
            tracing::info!(by = v.user.id, user = id, "password reset link created");
            Json(ResetLink {
                path: format!("/reset/{token}"),
                token,
                expires,
            })
            .into_response()
        }
        Err(e) => fail(e),
    }
}

async fn create_invite(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<CreateInvite>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    if !s.auth.enabled() {
        return auth_off();
    }
    let Some(Json(req)) = body else {
        return bad_json("{ email?, role }");
    };
    let email = match req
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        Some(e) => match normalize_email(e) {
            Ok(e) => Some(e),
            Err(e) => return fail(e),
        },
        None => None,
    };
    let by = v.user.clone();
    let t = now();
    match blocking(&s.accounts, move |a| {
        a.create_invite(email.as_deref(), req.role, &by, t)
    })
    .await
    {
        Ok((invite, token)) => {
            tracing::info!(
                by = v.user.id,
                invite = invite.id,
                role = invite.role.as_str(),
                "invite created"
            );
            (
                StatusCode::CREATED,
                Json(CreatedInvite {
                    invite,
                    path: format!("/invite/{token}"),
                    token,
                }),
            )
                .into_response()
        }
        Err(e) => fail(e),
    }
}

async fn revoke_invite(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let id = match parse_id(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = now();
    match blocking(&s.accounts, move |a| a.revoke_invite(id, t)).await {
        Ok(inv) => {
            tracing::info!(by = v.user.id, invite = id, "invite revoked");
            Json(inv).into_response()
        }
        Err(e) => fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::{HttpReceiver, IngestConfig, Receiver};
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::sync::Mutex;
    use tower::ServiceExt;

    const HOST: &str = "quiet.test";
    const ORIGIN: &str = "http://quiet.test";
    const PW: &str = "correct horse battery";

    struct T {
        st: AppState,
        app: Router,
    }

    /// A signed-in browser: its cookie and CSRF token.
    #[derive(Clone, Default)]
    struct Who {
        cookie: Option<String>,
        csrf: Option<String>,
    }

    struct Res {
        status: StatusCode,
        headers: axum::http::HeaderMap,
        body: Value,
        text: String,
    }

    impl T {
        async fn new() -> T {
            Self::with(AppState::new(
                Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new()),
                Arc::new(Mutex::new(DockerStatus::Disabled)),
            ))
            .await
        }

        async fn with(st: AppState) -> T {
            let app = crate::api::router(st.clone()).merge(
                HttpReceiver::new(
                    st.pipeline.clone(),
                    st.ingest_tokens.clone(),
                    IngestConfig::default(),
                )
                .routes(),
            );
            st.pipeline
                .ingest(
                    SourceKind::Http,
                    [RawLine::new(
                        r#"{"msg":"hello","email":"a@b.co"}"#,
                        "api",
                        chrono::Utc::now().timestamp_millis(),
                    )],
                )
                .await
                .unwrap();
            T { st, app }
        }

        fn build(method: Method, path: &str, body: Option<Value>, who: &Who) -> Request<Body> {
            let mut r = Request::builder()
                .method(method.clone())
                .uri(path)
                .header("host", HOST);
            if method != Method::GET {
                r = r.header("origin", ORIGIN);
            }
            if let Some(c) = &who.cookie {
                r = r.header("cookie", format!("{}={c}", auth::COOKIE));
            }
            if let Some(c) = &who.csrf {
                r = r.header(auth::CSRF_HEADER, c);
            }
            match body {
                Some(b) => r
                    .header("content-type", "application/json")
                    .body(Body::from(b.to_string()))
                    .unwrap(),
                None => r.body(Body::empty()).unwrap(),
            }
        }

        async fn send(&self, req: Request<Body>) -> Res {
            let res = self.app.clone().oneshot(req).await.unwrap();
            let status = res.status();
            let headers = res.headers().clone();
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            let text = String::from_utf8_lossy(&bytes).to_string();
            Res {
                status,
                headers,
                body: serde_json::from_str(&text).unwrap_or(Value::Null),
                text,
            }
        }

        async fn call(&self, m: Method, path: &str, body: Option<Value>, who: &Who) -> Res {
            self.send(Self::build(m, path, body, who)).await
        }

        async fn get(&self, path: &str, who: &Who) -> Res {
            self.call(Method::GET, path, None, who).await
        }

        async fn post(&self, path: &str, body: Value, who: &Who) -> Res {
            self.call(Method::POST, path, Some(body), who).await
        }

        /// Turn a sign-in response into a browser.
        fn who(res: &Res) -> Who {
            let cookie = res.headers[header::SET_COOKIE].to_str().unwrap();
            let value = cookie
                .split(';')
                .next()
                .unwrap()
                .split_once('=')
                .unwrap()
                .1
                .to_string();
            Who {
                cookie: Some(value),
                csrf: res.body["csrf"].as_str().map(str::to_string),
            }
        }

        async fn setup_owner(&self) -> Who {
            let r = self
                .post(
                    "/api/auth/setup",
                    json!({"name":"Kwaame","email":"k@x.co","password":PW}),
                    &Who::default(),
                )
                .await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            Self::who(&r)
        }

        async fn add_member(&self, owner: &Who, email: &str) -> (Who, i64) {
            let r = self
                .post(
                    "/api/invites",
                    json!({"email": email, "role": "member"}),
                    owner,
                )
                .await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            let token = r.body["token"].as_str().unwrap().to_string();
            let r = self
                .post(
                    "/api/auth/invite/accept",
                    json!({"token": token, "name": "Ama", "password": PW}),
                    &Who::default(),
                )
                .await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            let id = r.body["user"]["id"].as_i64().unwrap();
            (Self::who(&r), id)
        }
    }

    #[tokio::test]
    async fn setup_happens_once() {
        let t = T::new().await;
        let anon = Who::default();
        let s = t.get("/api/auth/state", &anon).await;
        assert_eq!(s.body["setup_required"], true);
        assert_eq!(s.body["auth"], "on");
        assert_eq!(s.body["host"]["store"], "memory");
        assert!(s.body["user"].is_null());

        // Validation before anything is created.
        let r = t
            .post(
                "/api/auth/setup",
                json!({"name":"K","email":"k@x.co","password":"short"}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);

        let owner = t.setup_owner().await;
        let set_cookie = t
            .post(
                "/api/auth/login",
                json!({"email":"k@x.co","password":PW}),
                &anon,
            )
            .await
            .headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));

        let r = t
            .post(
                "/api/auth/setup",
                json!({"name":"Mallory","email":"m@x.co","password":PW}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);
        assert_eq!(r.body["code"], "already_set_up");

        let s = t.get("/api/auth/state", &owner).await;
        assert_eq!(s.body["setup_required"], false);
        assert_eq!(s.body["user"]["role"], "owner");
        assert_eq!(s.body["csrf"], owner.csrf.clone().unwrap().as_str());
        assert!(s.body["host"].is_null(), "host details only before setup");
    }

    #[tokio::test]
    async fn login_bad_password_and_backoff() {
        let t = T::new().await;
        t.setup_owner().await;
        let anon = Who::default();
        let login = |pw: &str| json!({"email":"K@X.co","password":pw,"remember":false});

        let r = t.post("/api/auth/login", login(PW), &anon).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        // Not remembered: a browser-session cookie.
        assert!(!r.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age"));
        let me = T::who(&r);
        assert_eq!(t.get("/api/account", &me).await.body["email"], "k@x.co");

        for _ in 0..auth::EMAIL_FREE {
            let r = t
                .post("/api/auth/login", login("wrong password!"), &anon)
                .await;
            assert_eq!(r.status, StatusCode::UNAUTHORIZED);
            assert_eq!(r.body["error"], "email or password is wrong");
        }
        // Locked: even the right password waits.
        let r = t.post("/api/auth/login", login(PW), &anon).await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(r.headers.contains_key(header::RETRY_AFTER));
        // Unknown emails answer the same way.
        let r = t
            .post(
                "/api/auth/login",
                json!({"email":"nobody@x.co","password":PW}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn invites_are_single_use_and_expire() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        let anon = Who::default();
        let r = t
            .post(
                "/api/invites",
                json!({"email":"Yaw@x.co","role":"member"}),
                &owner,
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        assert!(r.body["path"].as_str().unwrap().starts_with("/invite/inv_"));
        let token = r.body["token"].as_str().unwrap().to_string();
        assert!(!r.body["invite"].to_string().contains(&token));

        let r = t
            .post("/api/auth/invite", json!({"token": token}), &anon)
            .await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.body["email"], "yaw@x.co");
        assert_eq!(r.body["created_by"], "Kwaame");

        let m = t.get("/api/members", &owner).await;
        assert_eq!(m.body["invites"].as_array().unwrap().len(), 1);

        let accept = json!({"token": token, "name": "Yaw", "email": "evil@x.co", "password": PW});
        let r = t
            .post("/api/auth/invite/accept", accept.clone(), &anon)
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        assert_eq!(
            r.body["user"]["email"], "yaw@x.co",
            "the invite's email wins"
        );
        assert_eq!(r.body["user"]["role"], "member");
        let r = t.post("/api/auth/invite/accept", accept, &anon).await;
        assert_eq!(r.status, StatusCode::GONE);
        assert_eq!(r.body["code"], "used");

        // Expired: created 8 days ago.
        let o = t.st.accounts.user_by_email("k@x.co").unwrap().unwrap();
        let old = now() - 8 * accounts::DAY_MS;
        let (_, stale) =
            t.st.accounts
                .create_invite(None, Role::Member, &o, old)
                .unwrap();
        let r = t
            .post("/api/auth/invite", json!({"token": stale}), &anon)
            .await;
        assert_eq!(r.status, StatusCode::GONE);
        assert_eq!(r.body["code"], "expired");
        assert_eq!(r.body["invite"]["created_by"], "Kwaame");
        let r = t
            .post(
                "/api/auth/invite/accept",
                json!({"token": stale, "name":"Z", "email":"z@x.co", "password": PW}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::GONE);

        // Revoked.
        let r = t
            .post("/api/invites", json!({"role":"member"}), &owner)
            .await;
        let (id, tok) = (
            r.body["invite"]["id"].as_i64().unwrap(),
            r.body["token"].as_str().unwrap().to_string(),
        );
        let r = t
            .call(Method::DELETE, &format!("/api/invites/{id}"), None, &owner)
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let r = t
            .post("/api/auth/invite", json!({"token": tok}), &anon)
            .await;
        assert_eq!(r.body["code"], "revoked");
        let r = t
            .post("/api/auth/invite", json!({"token": "inv_nope"}), &anon)
            .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn roles_owner_manages_member_reads() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        let (member, mid) = t.add_member(&owner, "ama@x.co").await;
        let oid = t.st.accounts.user_by_email("k@x.co").unwrap().unwrap().id;

        // Members read everything…
        assert_eq!(t.get("/api/sources", &member).await.status, StatusCode::OK);
        assert_eq!(
            t.get("/api/ingest-tokens", &member).await.status,
            StatusCode::OK
        );
        let m = t.get("/api/members", &member).await;
        assert_eq!(m.body["members"].as_array().unwrap().len(), 2);
        assert_eq!(m.body["invites"].as_array().unwrap().len(), 0);
        // …but manage nothing.
        for (m, path, body) in [
            (
                Method::POST,
                "/api/invites".to_string(),
                Some(json!({"role":"member"})),
            ),
            (
                Method::POST,
                "/api/ingest-tokens".into(),
                Some(json!({"name":"x"})),
            ),
            (Method::DELETE, "/api/ingest-tokens/1".into(), None),
            (
                Method::PATCH,
                format!("/api/members/{oid}"),
                Some(json!({"role":"member"})),
            ),
            (Method::DELETE, format!("/api/members/{oid}"), None),
            (
                Method::POST,
                format!("/api/members/{oid}/reset-link"),
                Some(json!({})),
            ),
            (Method::DELETE, "/api/invites/1".into(), None),
        ] {
            let r = t.call(m.clone(), &path, body, &member).await;
            assert_eq!(r.status, StatusCode::FORBIDDEN, "{m} {path}");
            assert_eq!(r.body["code"], "owner_only");
        }
        // Owner creates ingest tokens.
        let r = t
            .post("/api/ingest-tokens", json!({"name":"edge"}), &owner)
            .await;
        assert_eq!(r.status, StatusCode::CREATED);

        // Always one owner.
        let r = t
            .call(
                Method::PATCH,
                &format!("/api/members/{oid}"),
                Some(json!({"role":"member"})),
                &owner,
            )
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);
        assert_eq!(r.body["code"], "last_owner");
        let r = t
            .call(Method::DELETE, &format!("/api/members/{oid}"), None, &owner)
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);
        // Promote, then the old owner may step down.
        let r = t
            .call(
                Method::PATCH,
                &format!("/api/members/{mid}"),
                Some(json!({"role":"owner"})),
                &owner,
            )
            .await;
        assert_eq!(r.body["role"], "owner");
        let r = t
            .call(
                Method::PATCH,
                &format!("/api/members/{mid}"),
                Some(json!({"role":"member"})),
                &owner,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        // Removing a member signs them out at once.
        let r = t
            .call(Method::DELETE, &format!("/api/members/{mid}"), None, &owner)
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let r = t.get("/api/sources", &member).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(r.body["code"], "session_expired");
    }

    /// Every protected route, as (method, path, body).
    fn protected() -> Vec<(Method, &'static str, Option<Value>)> {
        vec![
            (Method::GET, "/api/health", None),
            (Method::GET, "/api/sources", None),
            (Method::GET, "/api/sources/api/lines", None),
            (Method::GET, "/api/stream?source=api", None),
            (Method::GET, "/api/search?q=hello", None),
            (Method::GET, "/api/export?source=api", None),
            (
                Method::POST,
                "/api/export/token",
                Some(json!({"query":"source=api&mask=pii"})),
            ),
            (Method::GET, "/api/flow?line=1", None),
            (
                Method::POST,
                "/api/flow-summaries",
                Some(json!({"ids":["x"]})),
            ),
            (Method::GET, "/api/ingest-tokens", None),
            (
                Method::POST,
                "/api/ingest-tokens",
                Some(json!({"name":"x"})),
            ),
            (Method::DELETE, "/api/ingest-tokens/99", None),
            (Method::GET, "/api/account", None),
            (
                Method::PATCH,
                "/api/account",
                Some(json!({"name":"K","email":"k@x.co"})),
            ),
            (
                Method::POST,
                "/api/account/password",
                Some(json!({"current":"x","password":"y"})),
            ),
            (Method::GET, "/api/account/sessions", None),
            (Method::DELETE, "/api/account/sessions/99", None),
            (
                Method::POST,
                "/api/account/sessions/sign-out-others",
                Some(json!({})),
            ),
            (Method::GET, "/api/members", None),
            (
                Method::PATCH,
                "/api/members/99",
                Some(json!({"role":"member"})),
            ),
            (Method::DELETE, "/api/members/99", None),
            (Method::POST, "/api/members/99/reset-link", Some(json!({}))),
            (Method::POST, "/api/invites", Some(json!({"role":"member"}))),
            (Method::DELETE, "/api/invites/99", None),
            (Method::POST, "/api/auth/logout", Some(json!({}))),
        ]
    }

    #[tokio::test]
    async fn every_api_route_needs_a_session() {
        let t = T::new().await;
        let anon = Who::default();
        for (m, path, body) in protected() {
            let r = t.call(m.clone(), path, body, &anon).await;
            assert_eq!(
                r.status,
                StatusCode::UNAUTHORIZED,
                "{m} {path} without a session"
            );
            assert_eq!(r.body["code"], "session_required", "{m} {path}");
            let bogus = Who {
                cookie: Some("deadbeef".into()),
                csrf: Some("x".into()),
            };
            let r = t.call(m.clone(), path, None, &bogus).await;
            assert_eq!(
                r.status,
                StatusCode::UNAUTHORIZED,
                "{m} {path} with a bogus cookie"
            );
        }
        let owner = t.setup_owner().await;
        for (m, path, body) in protected() {
            if path == "/api/auth/logout" {
                continue;
            }
            let r = t.call(m.clone(), path, body, &owner).await;
            assert!(
                r.status != StatusCode::UNAUTHORIZED && r.status != StatusCode::FORBIDDEN,
                "{m} {path} with a session: {} {}",
                r.status,
                r.text
            );
        }
        // Probes stay open; so do the public auth routes.
        assert_eq!(t.get("/health", &anon).await.status, StatusCode::OK);
        assert_eq!(t.get("/ready", &anon).await.status, StatusCode::OK);
        assert_eq!(t.get("/api/auth/state", &anon).await.status, StatusCode::OK);
        // Sign out ends the session.
        let r = t.post("/api/auth/logout", json!({}), &owner).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        assert!(r.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
        assert_eq!(
            t.get("/api/sources", &owner).await.status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn tokens_work_without_a_session() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        let anon = Who::default();
        // qi_ ingest token.
        let r = t
            .post("/api/ingest-tokens", json!({"name":"ci"}), &owner)
            .await;
        let qi = r.body["secret"].as_str().unwrap().to_string();
        let res = t
            .send(
                Request::post("/ingest/ndjson")
                    .header("authorization", format!("Bearer {qi}"))
                    .header("x-quiet-source", "ci")
                    .body(Body::from("{\"msg\":\"from a shipper\"}"))
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::ACCEPTED);
        // qx_ export token: issued with a session, used without one.
        let r = t
            .post("/api/export/token", json!({"query":"source=api"}), &owner)
            .await;
        let qx = r.body["token"].as_str().unwrap().to_string();
        let res = t
            .send(
                Request::get("/api/export?source=api")
                    .header("authorization", format!("Bearer {qx}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK);
        assert!(res.text.contains("hello"));
        // A token skips the session only on /api/export, and must be a real one.
        let res = t
            .send(
                Request::get("/api/search?q=hello")
                    .header("authorization", format!("Bearer {qx}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        let res = t
            .send(
                Request::get("/api/export?source=api")
                    .header("authorization", "Bearer qx_forged")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
        let _ = anon;
    }

    #[tokio::test]
    async fn csrf_and_cross_site_requests_are_refused() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        // A session without the CSRF token can't write.
        let no_csrf = Who {
            cookie: owner.cookie.clone(),
            csrf: None,
        };
        let r = t
            .post("/api/invites", json!({"role":"member"}), &no_csrf)
            .await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
        assert_eq!(r.body["code"], "csrf");
        let wrong = Who {
            cookie: owner.cookie.clone(),
            csrf: Some("0".repeat(64)),
        };
        let r = t
            .post("/api/invites", json!({"role":"member"}), &wrong)
            .await;
        assert_eq!(r.body["code"], "csrf");
        // GETs don't need it.
        assert_eq!(t.get("/api/members", &no_csrf).await.status, StatusCode::OK);

        // Another origin is refused, token or not; so is a cross-site sign-in.
        let evil = |m: Method, path: &str, who: &Who| {
            let mut r = Request::builder()
                .method(m)
                .uri(path)
                .header("host", HOST)
                .header("origin", "https://evil.example")
                .header("content-type", "application/json");
            if let Some(c) = &who.cookie {
                r = r.header("cookie", format!("{}={c}", auth::COOKIE));
            }
            if let Some(c) = &who.csrf {
                r = r.header(auth::CSRF_HEADER, c);
            }
            r.body(Body::from(
                json!({"role":"member","email":"k@x.co","password":PW}).to_string(),
            ))
            .unwrap()
        };
        let r = t.send(evil(Method::POST, "/api/invites", &owner)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
        assert_eq!(r.body["code"], "cross_site");
        let r = t
            .send(evil(Method::POST, "/api/auth/login", &Who::default()))
            .await;
        assert_eq!(r.body["code"], "cross_site");
        // Cross-site WebSocket hijacking: the upgrade is checked too.
        let res = t
            .send(
                Request::get("/api/stream?source=api")
                    .header("host", HOST)
                    .header("origin", "https://evil.example")
                    .header("upgrade", "websocket")
                    .header("connection", "upgrade")
                    .header(
                        "cookie",
                        format!("{}={}", auth::COOKIE, owner.cookie.clone().unwrap()),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn reset_links_and_password_changes_sign_out() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        let (member, mid) = t.add_member(&owner, "ama@x.co").await;
        let anon = Who::default();
        let r = t
            .post(&format!("/api/members/{mid}/reset-link"), json!({}), &owner)
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let token = r.body["token"].as_str().unwrap().to_string();
        assert_eq!(r.body["path"], format!("/reset/{token}"));
        let r = t
            .post("/api/auth/reset", json!({"token": token}), &anon)
            .await;
        assert_eq!(r.body["email"], "ama@x.co");
        let new_pw = "a brand new password";
        let r = t
            .post(
                "/api/auth/reset/accept",
                json!({"token": token, "password": new_pw}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
        assert_eq!(
            t.get("/api/account", &member).await.status,
            StatusCode::UNAUTHORIZED
        );
        let r = t
            .post(
                "/api/auth/reset/accept",
                json!({"token": token, "password": new_pw}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::GONE);
        let r = t
            .post(
                "/api/auth/login",
                json!({"email":"ama@x.co","password":new_pw}),
                &anon,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let member = T::who(&r);

        // Changing a password keeps this session, signs out the others.
        let other = T::who(
            &t.post(
                "/api/auth/login",
                json!({"email":"ama@x.co","password":new_pw}),
                &anon,
            )
            .await,
        );
        let r = t
            .post(
                "/api/account/password",
                json!({"current":"nope nope nope","password":"another long password"}),
                &member,
            )
            .await;
        assert_eq!(r.body["code"], "wrong_password");
        let r = t
            .post(
                "/api/account/password",
                json!({"current":new_pw,"password":"another long password"}),
                &member,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        assert_eq!(r.body["signed_out"], 1);
        assert_eq!(t.get("/api/account", &member).await.status, StatusCode::OK);
        assert_eq!(
            t.get("/api/account", &other).await.status,
            StatusCode::UNAUTHORIZED
        );

        // Sessions list + sign out others.
        let third = T::who(
            &t.post(
                "/api/auth/login",
                json!({"email":"ama@x.co","password":"another long password"}),
                &anon,
            )
            .await,
        );
        let s = t.get("/api/account/sessions", &member).await;
        let list = s.body["sessions"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list.iter().filter(|x| x["current"] == true).count(), 1);
        let r = t
            .post("/api/account/sessions/sign-out-others", json!({}), &member)
            .await;
        assert_eq!(r.body["signed_out"], 1);
        assert_eq!(
            t.get("/api/account", &third).await.status,
            StatusCode::UNAUTHORIZED
        );

        // Email changes need the password.
        let r = t
            .call(
                Method::PATCH,
                "/api/account",
                Some(json!({"name":"Ama M","email":"ama2@x.co"})),
                &member,
            )
            .await;
        assert_eq!(r.body["code"], "wrong_password");
        let r = t
            .call(
                Method::PATCH,
                "/api/account",
                Some(
                    json!({"name":"Ama M","email":"ama2@x.co","password":"another long password"}),
                ),
                &member,
            )
            .await;
        assert_eq!(r.body["email"], "ama2@x.co");
    }

    #[tokio::test]
    async fn members_export_with_pii_masked() {
        let t = T::new().await;
        let owner = t.setup_owner().await;
        let (member, _) = t.add_member(&owner, "ama@x.co").await;
        let r = t.get("/api/export?source=api", &owner).await;
        assert!(r.text.contains("a@b.co"));
        let r = t.get("/api/export?source=api", &member).await;
        assert!(!r.text.contains("a@b.co"), "{}", r.text);
        let r = t
            .post("/api/export/token", json!({"query":"source=api"}), &member)
            .await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
        assert_eq!(r.body["code"], "mask_required");
        let r = t
            .post(
                "/api/export/token",
                json!({"query":"source=api&mask=pii"}),
                &member,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_off_is_a_local_owner() {
        let st = AppState::new(
            Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new()),
            Arc::new(Mutex::new(DockerStatus::Disabled)),
        )
        .auth_off();
        let t = T::with(st).await;
        let anon = Who::default();
        let s = t.get("/api/auth/state", &anon).await;
        assert_eq!(s.body["auth"], "off");
        assert_eq!(s.body["user"]["role"], "owner");
        assert_eq!(t.get("/api/sources", &anon).await.status, StatusCode::OK);
        let r = t
            .post("/api/ingest-tokens", json!({"name":"dev"}), &anon)
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        let r = t
            .post(
                "/api/auth/login",
                json!({"email":"k@x.co","password":PW}),
                &anon,
            )
            .await;
        assert_eq!(r.body["code"], "auth_off");
    }
}
