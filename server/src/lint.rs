//! "Check my logs" (Guide → Check my logs, boards v0.1-11.x): score a
//! source's recent lines against the canonical-line guide.
//!
//! GET /api/sources/:name/lint?sample=1000
//!
//! Every check reads the newest lines of one source as stored (the same
//! `normalize` view the stream shows) and says pass / warn / fail, or `na`
//! when the source has nothing the check applies to (no jobs, no HTTP lines).
//! Each check carries a one-line fix that points at the agent prompt.

use crate::api::AppState;
use crate::hub::Line;
use crate::normalize::{IdKey, Level};
use crate::search::SearchQuery;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/sources/:name/lint", get(lint_source))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LintStatus {
    Pass,
    Warn,
    Fail,
    /// Nothing in the sample this check applies to.
    Na,
}

/// One row of the scorecard.
#[derive(Debug, Clone, Serialize, TS)]
pub struct LintCheck {
    /// Stable id (`json`, `timestamp`, `level`, `service`, `msg`, `canonical`,
    /// `request_id`, `job_id`, `job_request_id`, `error_object`, `calls`, `pii`).
    pub id: String,
    pub title: String,
    pub status: LintStatus,
    /// Share of the lines the check looked at that passed, 0–1 (null for `na`).
    pub share: Option<f64>,
    /// What was seen, e.g. `412 of 420 lines` or `email, phone`.
    pub detail: String,
    /// How to fix it (empty on pass).
    pub fix: String,
}

/// `GET /api/sources/:name/lint`.
#[derive(Debug, Clone, Serialize, TS)]
pub struct LintReport {
    pub source: String,
    /// Lines looked at, newest first.
    pub sampled: u64,
    /// Checks that pass, out of those that apply.
    pub passed: u32,
    pub applicable: u32,
    pub checks: Vec<LintCheck>,
}

#[derive(Debug, Deserialize)]
pub struct LintParams {
    pub sample: Option<usize>,
}

const TS_KEYS: &[&str] = &["timestamp", "time", "ts", "@timestamp"];
const SERVICE_KEYS: &[&str] = &["service", "service.name", "service_name", "app"];
const MSG_KEYS: &[&str] = &["msg", "message", "event"];
const HTTP_KEYS: &[&str] = &["method", "path", "route", "url", "status", "status_code"];
const JOB_KEYS: &[&str] = &[
    "queue",
    "job",
    "job_name",
    "jobName",
    "attempt",
    "retry_attempt",
];
/// Key names that usually hold personal data (matched on the last segment).
const PII_KEYS: &[&str] = &[
    "email",
    "e_mail",
    "phone",
    "phone_number",
    "msisdn",
    "full_name",
    "first_name",
    "last_name",
    "password",
    "passwd",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "cookie",
    "card_number",
    "card",
    "cvv",
    "ssn",
    "address",
    "dob",
    "date_of_birth",
];

fn get_path<'a>(m: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    if let Some(v) = m.get(path) {
        return Some(v);
    }
    let mut parts = path.split('.');
    let mut cur = m.get(parts.next()?)?;
    for p in parts {
        cur = cur.as_object()?.get(p)?;
    }
    Some(cur)
}

fn present(m: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|k| {
        get_path(m, k).is_some_and(|v| match v {
            Value::Null => false,
            Value::String(s) => !s.is_empty(),
            _ => true,
        })
    })
}

fn num(m: &Map<String, Value>, k: &str) -> Option<f64> {
    match m.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn has_id(l: &Line, k: &IdKey) -> bool {
    l.ids.iter().any(|i| i.key == *k)
}

fn looks_like_email(s: &str) -> bool {
    let Some((user, host)) = s.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && !user.contains(' ')
        && host.contains('.')
        && !host.contains(' ')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && s.len() < 120
}

fn looks_like_phone(s: &str) -> bool {
    let t = s.trim();
    let digits = t.chars().filter(|c| c.is_ascii_digit()).count();
    t.starts_with('+')
        && (9..=15).contains(&digits)
        && t.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | ' ' | '-' | '(' | ')'))
}

/// Walk a parsed line and collect dotted paths whose key name or value looks
/// like personal data.
fn pii_paths(v: &Value, prefix: &str, depth: usize, out: &mut BTreeSet<String>) {
    let Some(obj) = v.as_object() else { return };
    for (k, x) in obj {
        let path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        let name = k.to_ascii_lowercase().replace('-', "_");
        let named = PII_KEYS.contains(&name.as_str())
            && !matches!(x, Value::Null | Value::Bool(_))
            && !(x.is_object() || x.is_array());
        let valued = x
            .as_str()
            .is_some_and(|s| looks_like_email(s) || looks_like_phone(s));
        if named || valued {
            out.insert(path.clone());
        }
        if x.is_object() && depth < 3 {
            pii_paths(x, &path, depth + 1, out);
        }
    }
}

fn status_for(share: f64, pass: f64, warn: f64) -> LintStatus {
    if share >= pass {
        LintStatus::Pass
    } else if share >= warn {
        LintStatus::Warn
    } else {
        LintStatus::Fail
    }
}

fn of(n: usize, total: usize, what: &str) -> String {
    format!("{n} of {total} {what}")
}

fn check(
    id: &str,
    title: &str,
    hits: usize,
    total: usize,
    (pass, warn): (f64, f64),
    what: &str,
    fix: &str,
) -> LintCheck {
    if total == 0 {
        return LintCheck {
            id: id.into(),
            title: title.into(),
            status: LintStatus::Na,
            share: None,
            detail: format!("no {what} in the sample"),
            fix: String::new(),
        };
    }
    let share = hits as f64 / total as f64;
    let status = status_for(share, pass, warn);
    LintCheck {
        id: id.into(),
        title: title.into(),
        status,
        share: Some(share),
        detail: of(hits, total, what),
        fix: if status == LintStatus::Pass {
            String::new()
        } else {
            fix.into()
        },
    }
}

/// Score `lines` (one source, newest first).
pub fn lint(lines: &[Line]) -> Vec<LintCheck> {
    let total = lines.len();
    let objs: Vec<(&Line, &Map<String, Value>)> = lines
        .iter()
        .filter_map(|l| match &l.fields {
            Some(Value::Object(m)) => Some((l, m)),
            _ => None,
        })
        .collect();
    let n = objs.len();
    let mut out = Vec::new();

    out.push(check(
        "json",
        "Lines are JSON",
        n,
        total,
        (0.95, 0.5),
        "lines",
        "Configure the logger to print one JSON object per line to stdout (pino, structlog, slog do this out of the box).",
    ));

    // Exactly one timestamp key, written once, that quiet could read.
    let ts_ok = objs
        .iter()
        .filter(|(l, m)| {
            TS_KEYS.iter().filter(|k| m.contains_key(**k)).count() == 1
                && !l.flags.iter().any(|f| {
                    f.starts_with("ts:")
                        || f.strip_prefix("duplicate_key:")
                            .is_some_and(|k| TS_KEYS.contains(&k))
                })
        })
        .count();
    out.push(check(
        "timestamp",
        "One timestamp per line",
        ts_ok,
        n,
        (0.98, 0.8),
        "JSON lines",
        "Write exactly one of `time` (epoch ms) or `timestamp` (ISO 8601), never both.",
    ));

    let level_ok = objs.iter().filter(|(l, _)| l.level.is_some()).count();
    out.push(check(
        "level",
        "Level on every line",
        level_ok,
        n,
        (0.98, 0.8),
        "JSON lines",
        "Add `level` (debug, info, warn, error; pino numbers are fine).",
    ));

    let service_ok = objs
        .iter()
        .filter(|(_, m)| present(m, SERVICE_KEYS))
        .count();
    out.push(check(
        "service",
        "Service name on every line",
        service_ok,
        n,
        (0.98, 0.5),
        "JSON lines",
        "Set `service`, `env` and `version` once in the logger base so every line carries them.",
    ));

    let msg_ok = objs.iter().filter(|(_, m)| present(m, MSG_KEYS)).count();
    out.push(check(
        "msg",
        "Short event name in msg",
        msg_ok,
        n,
        (0.98, 0.8),
        "JSON lines",
        "Give every line a short snake_case `msg` (`create_payout`), not a sentence.",
    ));

    // One canonical line per request: of the request ids seen, how many have
    // exactly one line carrying both status and duration_ms.
    let mut per_req: HashMap<&str, usize> = HashMap::new();
    let mut req_seen: BTreeSet<&str> = BTreeSet::new();
    for (l, m) in &objs {
        let Some(r) = l.ids.iter().find(|i| i.key == IdKey::RequestId) else {
            continue;
        };
        if has_id(l, &IdKey::JobId) {
            continue; // job lines carry the parent request_id; not canonical HTTP lines
        }
        req_seen.insert(r.value.as_str());
        let canonical = m.get("status").is_some() && num(m, "duration_ms").is_some();
        if canonical {
            *per_req.entry(r.value.as_str()).or_default() += 1;
        }
    }
    let exactly_one = req_seen
        .iter()
        .filter(|r| per_req.get(*r).copied() == Some(1))
        .count();
    let mut c = check(
        "canonical",
        "One canonical line per request",
        exactly_one,
        req_seen.len(),
        (0.9, 0.5),
        "requests",
        "Write one line per request when it ends, with `status` and `duration_ms` (a middleware with a finally block); drop the scattered start/progress lines.",
    );
    let dupes = per_req.values().filter(|n| **n > 1).count();
    if dupes > 0 && c.status != LintStatus::Na {
        c.detail.push_str(&format!(" · {dupes} with more than one"));
    }
    out.push(c);

    let http: Vec<_> = objs
        .iter()
        .filter(|(l, m)| present(m, HTTP_KEYS) && !has_id(l, &IdKey::JobId))
        .collect();
    let http_req = http
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::RequestId))
        .count();
    out.push(check(
        "request_id",
        "request_id on request lines",
        http_req,
        http.len(),
        (0.95, 0.6),
        "request lines",
        "Generate (or accept `x-request-id`) at the edge, keep it in request context, put it on every line and return it as a header.",
    ));

    let jobish: Vec<_> = objs
        .iter()
        .filter(|(l, m)| has_id(l, &IdKey::JobId) || present(m, JOB_KEYS))
        .collect();
    let with_job = jobish
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::JobId))
        .count();
    out.push(check(
        "job_id",
        "job_id on job lines",
        with_job,
        jobish.len(),
        (0.95, 0.6),
        "job lines",
        "Log a globally unique `job_id` (`payout:88:1300`) on every line a job writes.",
    ));
    let job_lines: Vec<_> = jobish
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::JobId))
        .collect();
    let job_req = job_lines
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::RequestId))
        .count();
    out.push(check(
        "job_request_id",
        "Jobs carry the parent request_id",
        job_req,
        job_lines.len(),
        (0.8, 0.3),
        "job lines",
        "Put `request_id` into the job data when a request enqueues it and log it on every job line, so the job joins the request's flow.",
    ));

    let errors: Vec<_> = objs
        .iter()
        .filter(|(l, m)| {
            matches!(l.level, Some(Level::Error | Level::Fatal))
                || num(m, "status").is_some_and(|s| s >= 500.0)
                || m.get("outcome").and_then(Value::as_str) == Some("failed")
        })
        .collect();
    let structured = errors
        .iter()
        .filter(|(_, m)| {
            ["error", "err"].iter().any(|k| {
                m.get(*k)
                    .and_then(Value::as_object)
                    .is_some_and(|e| e.contains_key("message") || e.contains_key("code"))
            })
        })
        .count();
    out.push(check(
        "error_object",
        "Errors are structured objects",
        structured,
        errors.len(),
        (0.9, 0.5),
        "error lines",
        "Log `error: { name, code, message, details, stack }` as an object; `details` stays an object, never stringified JSON.",
    ));

    // wideEvents.calls: every call an object with provider/action and a numeric at_ms.
    let mut calls = 0usize;
    let mut calls_ok = 0usize;
    for (_, m) in &objs {
        let Some(list) = get_path(m, "wideEvents.calls").and_then(Value::as_array) else {
            continue;
        };
        for c in list {
            calls += 1;
            let ok = c.as_object().is_some_and(|o| {
                (o.contains_key("provider") || o.contains_key("action") || o.contains_key("name"))
                    && o.get("at_ms").is_some_and(Value::is_number)
                    && o.get("duration_ms").is_none_or(Value::is_number)
            });
            if ok {
                calls_ok += 1;
            }
        }
    }
    out.push(check(
        "calls",
        "wideEvents.calls are well formed",
        calls_ok,
        calls,
        (0.95, 0.6),
        "calls",
        "Each call is `{ provider, action, at_ms, duration_ms?, ok?, status? }` with `at_ms` = ms since the unit of work started.",
    ));

    let mut pii = BTreeSet::new();
    let mut pii_lines = 0usize;
    for (_, m) in &objs {
        let mut mine = BTreeSet::new();
        pii_paths(&Value::Object((*m).clone()), "", 0, &mut mine);
        if !mine.is_empty() {
            pii_lines += 1;
        }
        pii.extend(mine);
    }
    out.push(if n == 0 {
        check("pii", "No personal data", 0, 0, (1.0, 1.0), "JSON lines", "")
    } else {
        let clean = n - pii_lines;
        let mut c = check(
            "pii",
            "No personal data",
            clean,
            n,
            (1.0, 0.99),
            "JSON lines",
            "Log ids instead of emails, phone numbers, names, tokens or card data; mask what must stay.",
        );
        if !pii.is_empty() {
            let shown: Vec<_> = pii.iter().take(6).cloned().collect();
            c.detail = format!(
                "{} · looks like personal data: {}{}",
                c.detail,
                shown.join(", "),
                if pii.len() > 6 { ", …" } else { "" }
            );
        }
        c
    });
    out
}

async fn lint_source(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(p): Query<LintParams>,
) -> Response {
    let store = s.pipeline.store();
    let sample = p.sample.unwrap_or(1000).clamp(1, crate::search::MAX_PAGE);
    let until = chrono::Utc::now().timestamp_millis();
    let since = until - s.retention_ms();
    let _ = store.flush().await;
    let page = match store
        .search(&SearchQuery {
            sources: vec![name.clone()],
            since: Some(since),
            until: Some(until),
            limit: sample,
            ..Default::default()
        })
        .await
    {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "store read failed");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "store unavailable" })),
            )
                .into_response();
        }
    };
    let checks = lint(&page.lines);
    let applicable = checks.iter().filter(|c| c.status != LintStatus::Na).count() as u32;
    let passed = checks
        .iter()
        .filter(|c| c.status == LintStatus::Pass)
        .count() as u32;
    Json(LintReport {
        source: name,
        sampled: page.lines.len() as u64,
        passed,
        applicable,
        checks,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use std::sync::Arc;

    fn lines(raws: &[&str]) -> Vec<Line> {
        raws.iter()
            .map(|r| Arc::new(normalize(r, "lint-src", None, 1_000)))
            .collect()
    }

    fn get<'a>(c: &'a [LintCheck], id: &str) -> &'a LintCheck {
        c.iter().find(|c| c.id == id).unwrap()
    }

    #[test]
    fn canonical_source_passes_everything() {
        let c = lint(&lines(&[
            r#"{"time":1761148051123,"level":"info","service":"api","msg":"create_order","request_id":"req_1","method":"POST","path":"/orders","status":201,"duration_ms":142,"wideEvents":{"calls":[{"provider":"postgres","action":"insert","at_ms":3,"duration_ms":9,"ok":true}]}}"#,
            r#"{"time":1761148051200,"level":"error","service":"api","msg":"build_report","request_id":"req_2","method":"GET","path":"/r/1","status":500,"duration_ms":3412,"outcome":"failed","error":{"name":"E","code":"X","message":"boom"}}"#,
            r#"{"time":1761148051300,"level":"info","service":"worker","msg":"picked_up","job_id":"delivery:1182","request_id":"req_1","queue":"delivery"}"#,
            r#"{"time":1761148051400,"level":"info","service":"worker","msg":"completed","job_id":"delivery:1182","request_id":"req_1","duration_ms":80}"#,
        ]));
        for check in &c {
            assert_eq!(check.status, LintStatus::Pass, "{check:?}");
            assert!(check.fix.is_empty());
        }
    }

    #[test]
    fn messy_source_fails_with_fixes() {
        let c = lint(&lines(&[
            "plain text: start create order",
            r#"{"time":1,"timestamp":"2026-10-22T14:07:34Z","msg":"user ok","request_id":"req_1","path":"/orders"}"#,
            r#"{"time":2,"level":"info","msg":"charging","request_id":"req_1","status":201,"duration_ms":40}"#,
            r#"{"time":3,"level":"info","msg":"done","request_id":"req_1","status":201,"duration_ms":41,"email":"ama@example.com"}"#,
            r#"{"time":4,"level":"error","msg":"failed","path":"/pay","status":502,"error":"provider_502","customer":{"phone":"+233 24 123 4567"}}"#,
            r#"{"time":5,"level":"warn","msg":"retry","queue":"payouts","attempt":1}"#,
            r#"{"time":6,"level":"info","msg":"job","job_id":"7","wideEvents":{"calls":[{"provider":"x","at_ms":"soon"}]}}"#,
        ]));
        assert_eq!(get(&c, "json").status, LintStatus::Warn); // 6 of 7
                                                              // time + timestamp on one line.
        assert_ne!(get(&c, "timestamp").status, LintStatus::Pass);
        assert_eq!(get(&c, "service").status, LintStatus::Fail);
        // req_1 has two lines with status + duration_ms.
        let canon = get(&c, "canonical");
        assert_eq!(canon.status, LintStatus::Fail);
        assert!(canon.detail.contains("more than one"), "{}", canon.detail);
        // /pay has no request_id.
        assert_eq!(get(&c, "request_id").share, Some(0.75));
        // The retry line has no job_id; the job line has no request_id.
        assert_eq!(get(&c, "job_id").share, Some(0.5));
        assert_eq!(get(&c, "job_request_id").status, LintStatus::Fail);
        assert_eq!(get(&c, "error_object").status, LintStatus::Fail);
        assert_eq!(get(&c, "calls").status, LintStatus::Fail);
        let pii = get(&c, "pii");
        assert_eq!(pii.status, LintStatus::Fail);
        assert!(pii.detail.contains("email") && pii.detail.contains("customer.phone"));
        assert!(!pii.fix.is_empty());
    }

    #[test]
    fn checks_without_matching_lines_are_na() {
        let c = lint(&lines(&[
            r#"{"time":1,"level":"info","service":"cron","msg":"tick"}"#,
        ]));
        for id in [
            "canonical",
            "request_id",
            "job_id",
            "job_request_id",
            "error_object",
            "calls",
        ] {
            assert_eq!(get(&c, id).status, LintStatus::Na, "{id}");
            assert_eq!(get(&c, id).share, None);
        }
        assert_eq!(get(&c, "pii").status, LintStatus::Pass);
        let empty = lint(&[]);
        assert!(empty.iter().all(|c| c.status == LintStatus::Na));
    }

    #[test]
    fn pii_heuristics() {
        assert!(looks_like_email("ama@example.com"));
        assert!(!looks_like_email("payout@88"));
        assert!(!looks_like_email("@scope/pkg"));
        assert!(looks_like_phone("+233 24 123 4567"));
        assert!(!looks_like_phone("2026-10-22"));
        assert!(!looks_like_phone("+1"));
    }
}
