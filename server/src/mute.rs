//! Muted-lines matching (board 06.3), the server's copy of `web/src/lib/mute.ts`.
//!
//! The browser hides muted lines in the stream and search; the server only
//! needs to agree with it when an export follows the search's muted state
//! (`/api/export?muted=hide|auto`). Keep the two in step: same rule shapes,
//! same case-insensitive `*` globs, same field lookup.

use crate::normalize::LogLine;
use crate::settings::MuteRule;
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
fn field_text(line: &LogLine, path: &str) -> Option<String> {
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

pub fn matches(line: &LogLine, r: &MuteRule) -> bool {
    match r.field.as_deref() {
        Some(f) => field_text(line, f).is_some_and(|t| glob(&r.value, &t)),
        None => line.raw.to_lowercase().contains(&r.value.to_lowercase()),
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
        MuteRule {
            field: field.map(String::from),
            value: value.into(),
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
}
