//! Muted-lines matching (boards 06.13–06.25, 03.15–03.23), the server's copy
//! of `web/src/lib/mute.ts`.
//!
//! The browser hides muted lines in the stream and search; the server agrees
//! with it when an export follows the search's muted state
//! (`/api/export?muted=hide|auto`) and when it counts what a rule hides
//! (`/api/mute/stats`, `/api/mute/preview`). Keep the two in step: same rule
//! shapes, same case-insensitive `*` globs, same field lookup, same route
//! pick order.

use crate::normalize::LogLine;
use crate::settings::{route_path, MuteRule, MuteShape};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// What an export does with muted lines (`muted=` on `/api/export`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MutedMode {
    /// Every line, muted or not (the default, and what flows export).
    #[default]
    Include,
    /// Leave out lines matching their source's muted-lines rules.
    Hide,
    /// As search shows them by default: hide per source unless that source
    /// (or Settings → General) includes muted lines in search.
    Auto,
}

/// `*` matches any run of characters; everything else literally, ignoring case.
fn glob(pattern: &str, text: &str) -> bool {
    let p = pattern.to_lowercase();
    let t = text.to_lowercase();
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == t;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !t.starts_with(first) || t.len() < first.len() + last.len() || !t.ends_with(last) {
        return false;
    }
    let mut rest = &t[first.len()..t.len() - last.len()];
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid) {
            Some(i) => rest = &rest[i + mid.len()..],
            None => return false,
        }
    }
    true
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(_) | Value::Number(_) => Some(v.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(v).ok(),
    }
}

/// A field's value as text: `msg`/`message` fall back to the row summary,
/// `level` and `source` come from the line, a key with dots in it is tried
/// whole before as a path.
pub(crate) fn field_text(line: &LogLine, path: &str) -> Option<String> {
    let obj = line.fields.as_ref().and_then(Value::as_object);
    if (path == "msg" || path == "message") && obj.is_none_or(|o| !o.contains_key(path)) {
        return Some(line.msg.clone());
    }
    if path == "level" {
        return line
            .level
            .and_then(|l| serde_json::to_value(l).ok())
            .and_then(|v| v.as_str().map(String::from));
    }
    if path == "source" {
        return Some(line.source.clone());
    }
    let obj = obj?;
    if let Some(v) = obj.get(path) {
        return text_of(v);
    }
    let mut v = line.fields.as_ref()?;
    for part in path.split('.') {
        v = v.as_object()?.get(part)?;
    }
    text_of(v)
}

/// Where a line's route can be, in pick order (03.19).
pub const ROUTE_KEYS: [&str; 5] = ["route", "path", "http.route", "req.url", "url"];
/// Where a line's request method can be.
pub const METHOD_KEYS: [&str; 5] = [
    "method",
    "http.method",
    "req.method",
    "request.method",
    "http.request.method",
];

/// `*` matches within one path segment: both sides must have as many `/`,
/// then each segment is a plain glob.
fn glob_segments(pattern: &str, path: &str) -> bool {
    if pattern.matches('/').count() != path.matches('/').count() {
        return false;
    }
    pattern
        .split('/')
        .zip(path.split('/'))
        .all(|(p, t)| glob(p, t))
}

/// The line's route as its first field in [`ROUTE_KEYS`] has it, reduced to
/// the path (`?query`, `#hash`, scheme and host dropped), and that key.
pub fn pick_route(line: &LogLine) -> Option<(&'static str, String)> {
    ROUTE_KEYS.iter().find_map(|k| {
        field_text(line, k)
            .filter(|v| !v.is_empty())
            .map(|v| (*k, route_path(&v)))
    })
}

/// The line's request method, uppercased.
pub fn method_of(line: &LogLine) -> Option<String> {
    METHOD_KEYS
        .iter()
        .find_map(|k| field_text(line, k).filter(|v| !v.is_empty()))
        .map(|m| m.to_ascii_uppercase())
}

fn route_matches(line: &LogLine, pattern: &str) -> bool {
    ROUTE_KEYS.iter().any(|k| {
        field_text(line, k).is_some_and(|v| glob_segments(pattern, &route_path(&v)))
    })
}

/// Whether `line` matches `r` (enabled or not: callers pick the rules).
pub fn matches(line: &LogLine, r: &MuteRule) -> bool {
    match r.shape {
        MuteShape::Route => route_matches(line, &r.value),
        MuteShape::MethodRoute => {
            route_matches(line, &r.value)
                && r.method.as_deref().is_some_and(|m| {
                    method_of(line).is_some_and(|x| x.eq_ignore_ascii_case(m))
                })
        }
        MuteShape::Message => {
            field_text(line, r.field.as_deref().unwrap_or("msg")).is_some_and(|t| glob(&r.value, &t))
        }
        MuteShape::Field => match r.field.as_deref() {
            Some(f) => field_text(line, f).is_some_and(|t| glob(&r.value, &t)),
            None => line.raw.to_lowercase().contains(&r.value.to_lowercase()),
        },
        MuteShape::Text => line.raw.to_lowercase().contains(&r.value.to_lowercase()),
    }
}

pub fn is_muted(line: &LogLine, rules: &[MuteRule]) -> bool {
    rules.iter().any(|r| matches(line, r))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    fn line(raw: &str) -> LogLine {
        normalize(raw, "api", None, 1)
    }

    fn rule(field: Option<&str>, value: &str) -> MuteRule {
        MuteRule::legacy(field, value)
    }

    fn shaped(shape: MuteShape, value: &str, method: Option<&str>) -> MuteRule {
        MuteRule {
            shape,
            value: value.into(),
            method: method.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn globs_match_like_the_browser() {
        assert!(glob("/api/v1/health*", "/API/v1/health/live"));
        assert!(glob("*health*", "/healthz"));
        assert!(glob("a*b*c", "aXXbYYc"));
        assert!(!glob("a*b*c", "aXXcYYb"));
        assert!(glob("exact", "EXACT"));
        assert!(!glob("exact", "exactly"));
        assert!(!glob("ab*ba", "aba"), "prefix and suffix may not overlap");
    }

    #[test]
    fn field_and_text_rules() {
        let l = line(
            r#"{"msg":"GET done","path":"/api/v1/health","status":200,"http":{"route":"/x"},"a.b":"dotted"}"#,
        );
        assert!(matches(&l, &rule(Some("path"), "/api/v1/health*")));
        assert!(matches(&l, &rule(Some("status"), "200")));
        assert!(matches(&l, &rule(Some("http.route"), "/x")));
        assert!(matches(&l, &rule(Some("a.b"), "dotted")));
        assert!(matches(&l, &rule(Some("source"), "api")));
        let warn = line(r#"{"level":"warn","msg":"slow"}"#);
        assert!(matches(&warn, &rule(Some("level"), "WARN")));
        assert!(matches(&l, &rule(Some("msg"), "get *")));
        assert!(!matches(&l, &rule(Some("missing"), "*")));
        assert!(matches(&l, &rule(None, "API/V1")));
        assert!(!matches(&l, &rule(None, "nope")));
        let plain = line("plain text heartbeat");
        assert!(matches(&plain, &rule(Some("msg"), "*heartbeat")));
        assert!(is_muted(&plain, &[rule(None, "nope"), rule(None, "HEART")]));
        assert!(!is_muted(&plain, &[]));
    }

    #[test]
    fn routes_ignore_query_host_and_match_any_route_field() {
        let l = line(r#"{"msg":"request completed","method":"get","path":"/api/v1/health?probe=1"}"#);
        let r = shaped(MuteShape::Route, "/api/v1/health", None);
        assert!(matches(&l, &r));
        assert_eq!(pick_route(&l), Some(("path", "/api/v1/health".into())));
        assert_eq!(method_of(&l).as_deref(), Some("GET"));
        assert!(!matches(&line(r#"{"path":"/api/v1/healthz"}"#), &r));
        // pino-http: req.url, full URL: host and scheme dropped.
        let pino = line(r#"{"req":{"url":"https://x.io/api/v1/health#top","method":"HEAD"}}"#);
        assert!(matches(&pino, &r));
        assert_eq!(pick_route(&pino), Some(("req.url", "/api/v1/health".into())));
        // route wins the pick, but any route field can match.
        let both = line(r#"{"route":"/orders/:id","path":"/orders/7"}"#);
        assert_eq!(pick_route(&both), Some(("route", "/orders/:id".into())));
        assert!(matches(&both, &shaped(MuteShape::Route, "/orders/7", None)));
        // `*` stays inside one segment.
        let seg = shaped(MuteShape::Route, "/api/v1/orders/*", None);
        assert!(matches(&line(r#"{"path":"/api/v1/orders/42"}"#), &seg));
        assert!(!matches(&line(r#"{"path":"/api/v1/orders/42/items"}"#), &seg));
        assert!(matches(
            &line(r#"{"path":"/api/v1/healthz"}"#),
            &shaped(MuteShape::Route, "/api/v1/health*", None)
        ));
        // No route field: never a route match.
        assert!(!matches(&line("plain /api/v1/health"), &r));
    }

    #[test]
    fn method_route_message_and_legacy_shapes() {
        let get = line(r#"{"msg":"request completed","method":"GET","path":"/api/v1/ping"}"#);
        let head = line(r#"{"msg":"request completed","method":"HEAD","path":"/api/v1/ping"}"#);
        let r = shaped(MuteShape::MethodRoute, "/api/v1/ping", Some("get"));
        assert!(matches(&get, &r));
        assert!(!matches(&head, &r));
        assert!(!matches(&line(r#"{"path":"/api/v1/ping"}"#), &r), "no method");
        let m = shaped(MuteShape::Message, "Request completed", None);
        assert!(matches(&get, &m) && matches(&head, &m));
        assert!(!matches(&line(r#"{"msg":"request completed slowly"}"#), &m));
        assert!(matches(&line("heartbeat ok"), &shaped(MuteShape::Message, "heartbeat ok", None)));
        // Legacy rules read as before.
        assert_eq!(rule(None, "x").shape, MuteShape::Text);
        assert_eq!(rule(Some("msg"), "x").shape, MuteShape::Message);
        assert_eq!(rule(Some("path"), "x").shape, MuteShape::Field);
        assert!(!matches(&line(r#"{"path":"/api/v1/health?probe=1"}"#), &rule(Some("path"), "/api/v1/health")));
    }
}
