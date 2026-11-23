//! "Check my logs" (Guide → Check my logs, boards v0.1.1-11.6): score a
//! source's recent records against the canonical completion event
//! (`docs/logging-guide.md`).
//!
//! GET /api/sources/:name/lint?sample=1000
//!
//! Every check reads the newest lines of one source as stored (the same
//! `normalize` view the stream shows) and says pass / warn / fail, `review`
//! when the sample can't settle it (standalone jobs, missing completions,
//! a clean secret scan), `optional` for opt-in context, or `na` when the
//! source has nothing the check applies to. The results describe this
//! sample only, not delivery, privacy or SLO coverage. Each check carries a
//! one-line fix that points at the agent prompt.

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
    /// The sample can't settle it; a person should look (standalone jobs,
    /// missing completions, a secret scan that found nothing).
    Review,
    /// Opt-in context that is off (request/response capture).
    Optional,
    /// Nothing in the sample this check applies to.
    Na,
}

/// One row of the scorecard.
#[derive(Debug, Clone, Serialize, TS)]
pub struct LintCheck {
    /// Stable id (`json`, `timestamp`, `level`, `deployment`, `canonical`,
    /// `request_id`, `job_id`, `job_scope`, `job_request_id`, `attempt`,
    /// `error_object`, `completion`, `capture`, `secrets`).
    pub id: String,
    pub title: String,
    pub status: LintStatus,
    /// Share of the records the check looked at that passed, 0–1 (null for
    /// `na` and for a secret scan that found nothing).
    pub share: Option<f64>,
    /// What was seen, e.g. `412 of 420 records`.
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
    /// Checks that pass, out of those that pass, warn or fail (`review`,
    /// `optional` and `na` are not scored).
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
const VERSION_KEYS: &[&str] = &["version", "commit_sha", "service.version", "git_sha"];
const HTTP_KEYS: &[&str] = &["method", "path", "route", "url", "status", "status_code"];
const JOB_KEYS: &[&str] = &[
    "queue",
    "job",
    "job_name",
    "jobName",
    "attempt",
    "retry_attempt",
];
const QUEUE_KEYS: &[&str] = &["queue", "queue.name", "queue_name"];
const ATTEMPT_KEYS: &[&str] = &["attempt", "retry_attempt", "attemptsMade", "attempts"];
use crate::redact::{looks_like_secret, secret_key, REDACTED};

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

/// The actual HTTP status: `status_code`, or the v0.1.0 `status`.
fn http_status(m: &Map<String, Value>) -> Option<f64> {
    num(m, "status_code").or_else(|| num(m, "status"))
}

fn has_id(l: &Line, k: &IdKey) -> bool {
    l.ids.iter().any(|i| i.key == *k)
}

fn id_value<'a>(l: &'a Line, k: &IdKey) -> Option<&'a str> {
    l.ids.iter().find(|i| i.key == *k).map(|i| i.value.as_str())
}

/// Already masked: `[REDACTED]`, `***`, `••••`.
fn masked(s: &str) -> bool {
    let t = s.trim();
    t.eq_ignore_ascii_case(REDACTED)
        || (!t.is_empty() && t.chars().all(|c| matches!(c, '*' | '•' | 'x' | 'X')))
}

/// Walk a parsed record and collect dotted paths that hold an unredacted
/// credential, by key name or by value shape.
fn secret_paths(v: &Value, prefix: &str, depth: usize, out: &mut BTreeSet<String>) {
    let Some(obj) = v.as_object() else { return };
    for (k, x) in obj {
        let path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        let name = k.to_ascii_lowercase().replace('-', "_");
        let by_name = secret_key(&name)
            && match x {
                Value::String(s) => !s.trim().is_empty() && !masked(s),
                Value::Number(_) => true,
                _ => false,
            };
        let by_value = x
            .as_str()
            .is_some_and(|s| !masked(s) && looks_like_secret(s));
        if by_name || by_value {
            out.insert(path.clone());
        }
        if depth < 5 {
            match x {
                Value::Object(_) => secret_paths(x, &path, depth + 1, out),
                Value::Array(items) => {
                    for item in items.iter().take(50) {
                        secret_paths(item, &path, depth + 1, out);
                    }
                }
                _ => {}
            }
        }
    }
}

/// `error.message` holding JSON (`"{\"code\":…}"`) instead of real fields.
fn stringified_json(s: &str) -> bool {
    let t = s.trim();
    (t.starts_with('{') || t.starts_with('['))
        && serde_json::from_str::<Value>(t).is_ok_and(|v| v.is_object() || v.is_array())
}

fn typed_error(m: &Map<String, Value>) -> bool {
    ["error", "err"].iter().any(|k| {
        m.get(*k).and_then(Value::as_object).is_some_and(|e| {
            (e.contains_key("message") || e.contains_key("code"))
                && !e
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(stringified_json)
        })
    })
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

/// A warn/fail the sample can't settle becomes `review`; the fix stays.
fn as_review(mut c: LintCheck) -> LintCheck {
    if matches!(c.status, LintStatus::Warn | LintStatus::Fail) {
        c.status = LintStatus::Review;
    }
    c
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
        "JSON lines",
        n,
        total,
        (0.95, 0.5),
        "records parse",
        "Configure the existing logger to print one JSON object per line to stdout.",
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
    let mut c = check(
        "timestamp",
        "One timestamp",
        ts_ok,
        n,
        (0.98, 0.8),
        "records",
        "Keep one UTC completion `timestamp`; drop the logger's second time key.",
    );
    if c.status != LintStatus::Na && ts_ok < n {
        c.detail = format!("{} records have two timestamp keys", n - ts_ok);
    }
    out.push(c);

    let level_ok = objs.iter().filter(|(l, _)| l.level.is_some()).count();
    let numeric = objs
        .iter()
        .any(|(_, m)| m.get("level").is_some_and(Value::is_number));
    let mut c = check(
        "level",
        "level",
        level_ok,
        n,
        (0.98, 0.8),
        "records",
        "Set `level`: error for a recorded error or HTTP ≥400, warn for a slow success, info otherwise.",
    );
    if c.status == LintStatus::Pass && numeric {
        c.detail = "pino levels map to debug / info / warn / error".into();
    }
    out.push(c);

    // service plus a deployment marker (version or commit), set once in the
    // logger base.
    let no_service = objs
        .iter()
        .filter(|(_, m)| !present(m, SERVICE_KEYS))
        .count();
    let no_version = objs
        .iter()
        .filter(|(_, m)| !present(m, VERSION_KEYS))
        .count();
    let deploy_ok = objs
        .iter()
        .filter(|(_, m)| present(m, SERVICE_KEYS) && present(m, VERSION_KEYS))
        .count();
    let mut c = check(
        "deployment",
        "Deployment context",
        deploy_ok,
        n,
        (0.98, 0.3),
        "records",
        "Set `service`, `env` and `version` (or `commit_sha`) once in the logger base; don't invent a version.",
    );
    if c.status != LintStatus::Na && deploy_ok < n {
        let mut parts = Vec::new();
        if no_service > 0 {
            parts.push(format!("service absent on {no_service} records"));
        }
        if no_version > 0 {
            parts.push(format!("version absent on {no_version} records"));
        }
        c.detail = parts.join(" · ");
    }
    out.push(c);

    // One canonical completion event per request: of the request ids seen,
    // how many have exactly one record carrying both a status and duration_ms.
    let mut per_req: HashMap<&str, usize> = HashMap::new();
    let mut req_seen: BTreeSet<&str> = BTreeSet::new();
    for (l, m) in &objs {
        let Some(r) = id_value(l, &IdKey::RequestId) else {
            continue;
        };
        if has_id(l, &IdKey::JobId) {
            continue; // job records carry the parent request_id; not HTTP completions
        }
        req_seen.insert(r);
        if http_status(m).is_some() && num(m, "duration_ms").is_some() {
            *per_req.entry(r).or_default() += 1;
        }
    }
    let exactly_one = req_seen
        .iter()
        .filter(|r| per_req.get(*r).copied() == Some(1))
        .count();
    let mut c = check(
        "canonical",
        "One completion event per request",
        exactly_one,
        req_seen.len(),
        (0.9, 0.5),
        "requests",
        "Let middleware build one event per request and emit it once when the response completes, with `status_code` and `duration_ms`; drop the scattered start/progress lines.",
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
        "request_id on request records",
        http_req,
        http.len(),
        (0.95, 0.6),
        "request records",
        "Accept `x-request-id` only from trusted upstreams, otherwise generate one; keep it request-local and return it as a header.",
    ));

    let jobish: Vec<_> = objs
        .iter()
        .filter(|(l, m)| has_id(l, &IdKey::JobId) || present(m, JOB_KEYS))
        .collect();
    let with_job = jobish
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::JobId))
        .count();
    let mut c = check(
        "job_id",
        "job_id on job records",
        with_job,
        jobish.len(),
        (0.95, 0.6),
        "job records",
        "Log the queue's own job id as `job_id` (`payout-88-1300`) on every attempt.",
    );
    if c.status == LintStatus::Pass {
        c.detail = "native id and queue on each attempt".into();
    }
    out.push(c);

    let job_lines: Vec<_> = jobish
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::JobId))
        .collect();

    // Native id plus its scope: the same bare id can repeat across queues.
    let scoped = job_lines
        .iter()
        .filter(|(_, m)| present(m, QUEUE_KEYS) && present(m, SERVICE_KEYS))
        .count();
    let mut c = check(
        "job_scope",
        "Scoped job identity",
        scoped,
        job_lines.len(),
        (0.95, 0.6),
        "job records",
        "Bare ids may repeat across queues: log `queue` and `service` next to `job_id`.",
    );
    if c.status == LintStatus::Pass {
        c.detail = "native id + queue + service present".into();
    }
    out.push(c);

    let job_req = job_lines
        .iter()
        .filter(|(l, _)| has_id(l, &IdKey::RequestId))
        .count();
    out.push(as_review(check(
        "job_request_id",
        "Parent request_id on jobs",
        job_req,
        job_lines.len(),
        (0.8, 0.3),
        "job records",
        "Check expected parents: propagate `request_id` into job data when a request enqueues the job. Standalone jobs are valid without one.",
    )));

    let attempts = job_lines
        .iter()
        .filter(|(_, m)| num(m, "duration_ms").is_some() && present(m, ATTEMPT_KEYS))
        .count();
    let mut c = check(
        "attempt",
        "duration_ms · native attempt",
        attempts,
        job_lines.len(),
        (0.95, 0.6),
        "job records",
        "Write one completion event per attempt with `duration_ms` and the queue's own attempt number.",
    );
    if c.status == LintStatus::Pass {
        c.detail = "on every attempt record".into();
    }
    out.push(c);

    let errors: Vec<_> = objs
        .iter()
        .filter(|(l, m)| {
            matches!(l.level, Some(Level::Error | Level::Fatal))
                || http_status(m).is_some_and(|s| s >= 400.0)
        })
        .collect();
    let structured = errors.iter().filter(|(_, m)| typed_error(m)).count();
    let mut c = check(
        "error_object",
        "Typed error fields",
        structured,
        errors.len(),
        (0.9, 0.5),
        "error records",
        "Make `error` an object `{ name, code, message, reason, details }`; keep reason and details as their own JSON types.",
    );
    if !matches!(c.status, LintStatus::Na | LintStatus::Pass) {
        c.detail = format!(
            "{} errors are strings or stringified JSON · {}",
            errors.len() - structured,
            of(structured, errors.len(), "typed")
        );
    }
    out.push(c);

    // Terminal evidence per logical job: at least one attempt finished with a
    // measured duration. Missing completion is unknown, not failure.
    let mut jobs: HashMap<&str, bool> = HashMap::new();
    for (l, m) in &job_lines {
        if let Some(j) = id_value(l, &IdKey::JobId) {
            let done = num(m, "duration_ms").is_some();
            let e = jobs.entry(j).or_default();
            *e = *e || done;
        }
    }
    let finished = jobs.values().filter(|d| **d).count();
    let mut c = as_review(check(
        "completion",
        "Completion evidence",
        finished,
        jobs.len(),
        (0.98, 0.98),
        "jobs",
        "Verify missing terminal evidence with the queue; don't infer completion from a missing log.",
    ));
    if c.status == LintStatus::Review {
        c.detail = format!(
            "{}% have terminal evidence; others unknown",
            (c.share.unwrap_or(0.0) * 100.0).round()
        );
    }
    out.push(c);

    // Request/response context on HTTP completions. Opt-in, so never a fail.
    let completions: Vec<_> = http
        .iter()
        .filter(|(_, m)| http_status(m).is_some())
        .collect();
    let with_ctx = completions
        .iter()
        .filter(|(_, m)| {
            m.get("request").is_some_and(Value::is_object)
                || m.get("response").is_some_and(Value::is_object)
        })
        .count();
    let disabled = completions
        .iter()
        .filter(|(_, m)| {
            ["request", "response"].iter().any(|side| {
                get_path(m, &format!("{side}.body_capture")).and_then(Value::as_str)
                    == Some("disabled")
            })
        })
        .count();
    let mut c = check(
        "capture",
        "Request / response capture",
        with_ctx,
        completions.len(),
        (0.9, 0.9),
        "request records",
        "Optional: capture approved headers, and opt in to safe body fields per route with byte limits.",
    );
    if matches!(c.status, LintStatus::Warn | LintStatus::Fail) {
        c.status = LintStatus::Optional;
    }
    if c.status != LintStatus::Na {
        if with_ctx == 0 {
            c.detail = "no request or response context".into();
        }
        if disabled > 0 {
            c.detail
                .push_str(&format!(" · body capture disabled on {disabled}"));
        }
    }
    out.push(c);

    // Unredacted credentials. A clean scan is still `review`: key and shape
    // matching can't prove a record holds no secret.
    let mut found = BTreeSet::new();
    let mut leaky = 0usize;
    for (_, m) in &objs {
        let mut mine = BTreeSet::new();
        secret_paths(&Value::Object((*m).clone()), "", 0, &mut mine);
        if !mine.is_empty() {
            leaky += 1;
        }
        found.extend(mine);
    }
    out.push(if n == 0 {
        check("secrets", "Sensitive-value scan", 0, 0, (1.0, 1.0), "records", "")
    } else if found.is_empty() {
        LintCheck {
            id: "secrets".into(),
            title: "Sensitive-value scan".into(),
            status: LintStatus::Review,
            share: None,
            detail: "no patterns found; this is not a privacy guarantee".into(),
            fix: String::new(),
        }
    } else {
        let shown: Vec<_> = found.iter().take(6).cloned().collect();
        LintCheck {
            id: "secrets".into(),
            title: "Sensitive-value scan".into(),
            status: LintStatus::Fail,
            share: Some((n - leaky) as f64 / n as f64),
            detail: format!(
                "{leaky} of {n} records hold unredacted values: {}{}",
                shown.join(", "),
                if found.len() > 6 { ", …" } else { "" }
            ),
            fix: "Redact credentials and configured fields as `[REDACTED]` before the log is written. Email and phone stay visible unless a source rule hides them.".into(),
        }
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
    let applicable = checks
        .iter()
        .filter(|c| {
            matches!(
                c.status,
                LintStatus::Pass | LintStatus::Warn | LintStatus::Fail
            )
        })
        .count() as u32;
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
    fn canonical_source_passes() {
        let c = lint(&lines(&[
            r#"{"timestamp":"2026-11-23T14:07:31.123Z","level":"info","service":"api","env":"production","version":"1.42.0","flow":"create_order","request_id":"req_1","method":"POST","path":"/orders","status_code":201,"duration_ms":142,"request":{"headers":{"authorization":"[REDACTED]"},"body_capture":"disabled"},"response":{"headers":{},"body_capture":"disabled"},"order":{"id":"ord_1"}}"#,
            r#"{"timestamp":"2026-11-23T14:07:32.000Z","level":"error","service":"api","env":"production","version":"1.42.0","flow":"build_report","request_id":"req_2","method":"GET","path":"/r/1","status_code":500,"duration_ms":3412,"request":{"headers":{}},"error":{"name":"ReportError","code":"X","message":"boom","details":{"renderer":"pdf"}}}"#,
            r#"{"timestamp":"2026-11-23T14:07:33.000Z","level":"error","service":"worker","env":"production","version":"1.42.0","flow":"deliver_order","job_id":"job_456","queue":"orders","request_id":"req_1","attempt":1,"duration_ms":350,"error":{"code":"PROVIDER_UNAVAILABLE","message":"down","reason":"upstream_unavailable"}}"#,
            r#"{"timestamp":"2026-11-23T14:07:38.000Z","level":"info","service":"worker","env":"production","version":"1.42.0","flow":"deliver_order","job_id":"job_456","queue":"orders","request_id":"req_1","attempt":2,"duration_ms":200}"#,
        ]));
        for check in &c {
            if check.id == "secrets" {
                assert_eq!(check.status, LintStatus::Review, "{check:?}");
                assert_eq!(check.share, None);
                continue;
            }
            assert_eq!(check.status, LintStatus::Pass, "{check:?}");
            assert!(check.fix.is_empty());
        }
        assert!(c
            .iter()
            .all(|c| c.id != "msg" && c.id != "calls" && c.id != "pii"));
    }

    #[test]
    fn v010_worker_fails_with_fixes() {
        let c = lint(&lines(&[
            "plain text: start settle",
            r#"{"time":1,"timestamp":"2026-10-22T14:07:34Z","level":50,"service":"order-worker","msg":"job failed","job_id":"payout-88-1300","outcome":"failed","error":{"message":"{\"code\":\"INSUFFICIENT_FLOAT\"}"},"wideEvents":{"calls":[{"provider":"paystack","at_ms":3}]}}"#,
            r#"{"time":2,"level":"info","service":"order-worker","msg":"picked up","job_id":"payout-88-1301","queue":"payouts"}"#,
            r#"{"time":3,"level":"warn","msg":"retry","queue":"payouts","attempt":1}"#,
        ]));
        assert_eq!(get(&c, "json").status, LintStatus::Warn); // 3 of 4
        let ts = get(&c, "timestamp");
        assert_ne!(ts.status, LintStatus::Pass);
        assert!(ts.detail.contains("two timestamp keys"), "{}", ts.detail);
        let dep = get(&c, "deployment");
        assert_eq!(dep.status, LintStatus::Fail);
        assert!(dep.detail.contains("version absent on 3"), "{}", dep.detail);
        // The retry record has no job_id.
        assert_eq!(get(&c, "job_id").share, Some(2.0 / 3.0));
        // payout-88-1300 has no queue.
        assert_eq!(get(&c, "job_scope").status, LintStatus::Fail);
        // No request_id on jobs is a question, not a failure.
        assert_eq!(get(&c, "job_request_id").status, LintStatus::Review);
        assert_eq!(get(&c, "attempt").status, LintStatus::Fail);
        let err = get(&c, "error_object");
        assert_eq!(err.status, LintStatus::Fail);
        assert!(
            err.detail.starts_with("1 errors are strings"),
            "{}",
            err.detail
        );
        let done = get(&c, "completion");
        assert_eq!(done.status, LintStatus::Review);
        assert!(done.detail.contains("others unknown"));
        // Worker: no HTTP completions.
        assert_eq!(get(&c, "capture").status, LintStatus::Na);
        assert_eq!(get(&c, "canonical").status, LintStatus::Na);
    }

    #[test]
    fn http_counts_status_code_and_legacy_status() {
        let c = lint(&lines(&[
            r#"{"time":1,"level":"info","service":"api","version":"1","request_id":"req_1","path":"/a","status_code":201,"duration_ms":4}"#,
            r#"{"time":2,"level":"info","service":"api","version":"1","request_id":"req_2","path":"/b","status":201,"duration_ms":5}"#,
            r#"{"time":3,"level":"info","service":"api","version":"1","request_id":"req_2","path":"/b","status":201,"duration_ms":6}"#,
            r#"{"time":4,"level":"info","service":"api","version":"1","path":"/c","status_code":404,"duration_ms":2,"error":"not_found"}"#,
        ]));
        let canon = get(&c, "canonical");
        assert_eq!(canon.share, Some(0.5));
        assert!(
            canon.detail.contains("1 with more than one"),
            "{}",
            canon.detail
        );
        assert_eq!(get(&c, "request_id").share, Some(0.75));
        // 404 is an error record; a string error is not typed.
        assert_eq!(get(&c, "error_object").status, LintStatus::Fail);
        // No request/response objects: opt-in context, not a failure.
        let cap = get(&c, "capture");
        assert_eq!(cap.status, LintStatus::Optional);
        assert_eq!(cap.detail, "no request or response context");
    }

    #[test]
    fn secrets_ignore_email_phone_and_redacted() {
        let clean = lint(&lines(&[
            r#"{"time":1,"level":"info","service":"api","user":{"email":"ama@example.com","msisdn":"+233205550118"},"request":{"headers":{"authorization":"[REDACTED]","cookie":"***"}}}"#,
        ]));
        assert_eq!(get(&clean, "secrets").status, LintStatus::Review);
        let leaky = lint(&lines(&[
            r#"{"time":1,"level":"info","service":"api","request":{"headers":{"authorization":"Bearer abcdefghijklmnop"}},"password":"hunter2"}"#,
            r#"{"time":2,"level":"info","service":"api","note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}"#,
        ]));
        let s = get(&leaky, "secrets");
        assert_eq!(s.status, LintStatus::Fail);
        assert_eq!(s.share, Some(0.0));
        assert!(
            s.detail.contains("password")
                && s.detail.contains("request.headers.authorization")
                && s.detail.contains("note"),
            "{}",
            s.detail
        );
    }

    #[test]
    fn checks_without_matching_records_are_na() {
        let c = lint(&lines(&[
            r#"{"time":1,"level":"info","service":"cron","version":"1","flow":"tick"}"#,
        ]));
        for id in [
            "canonical",
            "request_id",
            "job_id",
            "job_scope",
            "job_request_id",
            "attempt",
            "error_object",
            "completion",
            "capture",
        ] {
            assert_eq!(get(&c, id).status, LintStatus::Na, "{id}");
            assert_eq!(get(&c, id).share, None);
        }
        let empty = lint(&[]);
        assert!(empty.iter().all(|c| c.status == LintStatus::Na));
    }

    #[test]
    fn heuristics() {
        assert!(looks_like_secret("Bearer abcdefghijklmnop"));
        assert!(!looks_like_secret("Bearer x"));
        assert!(!looks_like_secret("ama@example.com"));
        assert!(masked("[REDACTED]") && masked("****") && !masked("hunter2"));
        assert!(stringified_json(r#"{"code":"X"}"#));
        assert!(!stringified_json("{not json"));
    }
}
