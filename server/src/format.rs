//! Which logging contract a source writes (plan slice 7, board v0.1.1-00.3).
//!
//! A record is **v0.1.0** when it carries a field only the old prompt asked
//! for: `outcome`, `wideEvents.calls`, `msg` without `flow`, or `status`
//! without `status_code`. It is **v0.1.1** when it has `flow` and none of
//! those. Anything else (plain text, a library's own log) says nothing.
//!
//! Every line updates its source's last old / new arrival in the hub, so
//! `/api/sources` can tag a source `v0.1.0` cheaply; the tag clears 24 hours
//! after the last old-format record. `/api/sources/:name/format` reads the
//! newest 5,000 records for the upgrade screen: what the code writes → what
//! v0.1.1 expects with counts, and the hourly rollout.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Map, Value};
use ts_rs::TS;

use crate::api::AppState;
use crate::hub::Line;

/// How long a source keeps its `v0.1.0` tag after its last old record.
pub const TAG_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Records read for the upgrade screen.
pub const SAMPLE: usize = 5_000;
const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
pub enum LogFormat {
    #[serde(rename = "v0.1.0")]
    V010,
    #[serde(rename = "v0.1.1")]
    V011,
}

/// One v0.1.0 → v0.1.1 change the upgrade screen lists.
struct Change {
    id: &'static str,
    from: &'static str,
    to: &'static str,
    /// Counts toward the v0.1.0 tag (the rest are advice).
    old: bool,
    test: fn(&Map<String, Value>) -> bool,
}

fn has(m: &Map<String, Value>, k: &str) -> bool {
    m.get(k).is_some_and(|v| !v.is_null())
}

fn status_number(v: &Value) -> bool {
    match v {
        Value::Number(_) => true,
        Value::String(s) => s.len() == 3 && s.parse::<u16>().is_ok(),
        _ => false,
    }
}

const CHANGES: &[Change] = &[
    Change {
        id: "outcome",
        from: "outcome",
        to: "level + status_code, error when it failed",
        old: true,
        test: |m| has(m, "outcome"),
    },
    Change {
        id: "wide_events_calls",
        from: "wideEvents.calls",
        to: "one event per request or job attempt; the failing call in error.details",
        old: true,
        test: |m| {
            m.get("wideEvents")
                .and_then(|w| w.get("calls"))
                .is_some_and(|c| !c.is_null())
        },
    },
    Change {
        id: "msg_without_flow",
        from: "msg without flow",
        to: "flow (the operation name)",
        old: true,
        test: |m| (has(m, "msg") || has(m, "message")) && !has(m, "flow"),
    },
    Change {
        id: "status",
        from: "status",
        to: "status_code",
        old: true,
        test: |m| m.get("status").is_some_and(status_number) && !has(m, "status_code"),
    },
    Change {
        id: "err",
        from: "err",
        to: "error { name, code, message, reason }",
        old: false,
        test: |m| has(m, "err") && !has(m, "error"),
    },
    Change {
        id: "job_scope",
        from: "job_id without queue",
        to: "the queue's own job_id + queue + attempt",
        old: false,
        test: |m| has(m, "job_id") && !has(m, "queue"),
    },
];

/// The contract a record follows, if it says.
pub fn classify(fields: Option<&Value>) -> Option<LogFormat> {
    let m = fields?.as_object()?;
    if CHANGES.iter().any(|c| c.old && (c.test)(m)) {
        Some(LogFormat::V010)
    } else if has(m, "flow") {
        Some(LogFormat::V011)
    } else {
        None
    }
}

/// The tag `/api/sources` shows: v0.1.0 while an old record arrived in the
/// last 24 h, else v0.1.1 once a new one has, else nothing.
pub fn tag(last_old: Option<i64>, last_new: Option<i64>, now: i64) -> Option<LogFormat> {
    match (last_old, last_new) {
        (Some(o), _) if now - o < TAG_TTL_MS => Some(LogFormat::V010),
        (_, Some(_)) => Some(LogFormat::V011),
        _ => None,
    }
}

/// Last old / new arrival in `lines` (to warm the hub after a restart).
pub fn last_seen(lines: &[Line]) -> (Option<i64>, Option<i64>) {
    let (mut old, mut new) = (None, None);
    for l in lines {
        match classify(l.fields.as_ref()) {
            Some(LogFormat::V010) => old = old.max(Some(l.received)),
            Some(LogFormat::V011) => new = new.max(Some(l.received)),
            None => {}
        }
    }
    (old, new)
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FieldChange {
    /// Stable id (`outcome`, `wide_events_calls`, `msg_without_flow`,
    /// `status`, `err`, `job_scope`).
    pub id: String,
    /// What the code writes now.
    pub from: String,
    /// What v0.1.1 expects instead.
    pub to: String,
    /// Records in the sample that still do it.
    pub count: u32,
    /// Part of the v0.1.0 tag (the others are advice).
    pub old_format: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct RolloutBucket {
    /// Hour start, unix ms (arrival).
    pub start: i64,
    pub old: u32,
    pub new: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FormatReport {
    pub source: String,
    /// Records read (the newest, up to 5,000).
    pub sample: u32,
    pub old: u32,
    pub new: u32,
    /// Records that say nothing (plain text, library logs).
    pub other: u32,
    pub tag: Option<LogFormat>,
    pub last_old: Option<i64>,
    pub last_new: Option<i64>,
    /// Only changes some record still needs.
    pub changes: Vec<FieldChange>,
    /// Old vs new per hour, oldest first, at most 24 hours.
    pub rollout: Vec<RolloutBucket>,
    pub now: i64,
}

pub fn report(source: &str, lines: &[Line], now: i64) -> FormatReport {
    let mut counts = vec![0u32; CHANGES.len()];
    let (mut old, mut new, mut other) = (0, 0, 0);
    let mut hours: BTreeMap<i64, (u32, u32)> = BTreeMap::new();
    for l in lines {
        if let Some(m) = l.fields.as_ref().and_then(Value::as_object) {
            for (i, c) in CHANGES.iter().enumerate() {
                if (c.test)(m) {
                    counts[i] += 1;
                }
            }
        }
        let h = l.received.div_euclid(HOUR_MS) * HOUR_MS;
        match classify(l.fields.as_ref()) {
            Some(LogFormat::V010) => {
                old += 1;
                hours.entry(h).or_default().0 += 1;
            }
            Some(LogFormat::V011) => {
                new += 1;
                hours.entry(h).or_default().1 += 1;
            }
            None => other += 1,
        }
    }
    let (last_old, last_new) = last_seen(lines);
    let mut rollout: Vec<RolloutBucket> = hours
        .into_iter()
        .map(|(start, (old, new))| RolloutBucket { start, old, new })
        .collect();
    if rollout.len() > 24 {
        rollout.drain(..rollout.len() - 24);
    }
    FormatReport {
        source: source.to_string(),
        sample: lines.len() as u32,
        old,
        new,
        other,
        tag: tag(last_old, last_new, now),
        last_old,
        last_new,
        changes: CHANGES
            .iter()
            .zip(counts)
            .filter(|(_, n)| *n > 0)
            .map(|(c, count)| FieldChange {
                id: c.id.into(),
                from: c.from.into(),
                to: c.to.into(),
                count,
                old_format: c.old,
            })
            .collect(),
        rollout,
        now,
    }
}

/// After a restart, set each source's last old / new arrival from its
/// stored tail, so the tag survives (it would otherwise wait for new lines).
pub async fn warm(p: &crate::pipeline::Pipeline) {
    for src in p.hub().list() {
        let Ok(lines) = p.store().tail(&src.name, 1_000).await else {
            continue;
        };
        let (old, new) = last_seen(&lines);
        if let Some(s) = p.hub().source(&src.name) {
            s.update_meta(|m| {
                m.last_old_format = m.last_old_format.max(old);
                m.last_new_format = m.last_new_format.max(new);
            });
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/sources/:name/format", get(format_source))
}

async fn format_source(State(s): State<AppState>, Path(name): Path<String>) -> Response {
    let store = s.pipeline.store();
    let _ = store.flush().await;
    match store.tail(&name, SAMPLE).await {
        Ok(lines) => {
            Json(report(&name, &lines, chrono::Utc::now().timestamp_millis())).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "store read failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "store unavailable" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use std::sync::Arc;

    fn line(raw: &str, received: i64) -> Line {
        Arc::new(normalize(raw, "api", None, received))
    }

    #[test]
    fn classifies_by_v010_only_fields() {
        let c = |raw: &str| classify(normalize(raw, "a", None, 0).fields.as_ref());
        assert_eq!(
            c(r#"{"flow":"x","status_code":200}"#),
            Some(LogFormat::V011)
        );
        assert_eq!(c(r#"{"flow":"x","outcome":"ok"}"#), Some(LogFormat::V010));
        assert_eq!(
            c(r#"{"msg":"request done","status":200}"#),
            Some(LogFormat::V010)
        );
        assert_eq!(
            c(r#"{"flow":"x","wideEvents":{"calls":[]}}"#),
            Some(LogFormat::V010)
        );
        assert_eq!(
            c(r#"{"flow":"x","status":"active"}"#),
            Some(LogFormat::V011)
        );
        assert_eq!(c(r#"{"level":"info"}"#), None);
        assert_eq!(c("plain text"), None);
    }

    #[test]
    fn tag_clears_a_day_after_the_last_old_record() {
        assert_eq!(tag(Some(0), None, TAG_TTL_MS - 1), Some(LogFormat::V010));
        assert_eq!(tag(Some(0), Some(5), TAG_TTL_MS), Some(LogFormat::V011));
        assert_eq!(tag(Some(0), None, TAG_TTL_MS), None);
        assert_eq!(tag(None, None, 0), None);
    }

    #[test]
    fn report_counts_changes_and_rollout() {
        let lines = vec![
            line(
                r#"{"msg":"done","outcome":"ok","status":200,"job_id":"j1"}"#,
                0,
            ),
            line(r#"{"msg":"done","outcome":"failed","err":{"m":"x"}}"#, 1),
            line(r#"{"flow":"create_order","status_code":201}"#, HOUR_MS + 5),
            line("plain text", HOUR_MS + 6),
        ];
        let r = report("api", &lines, HOUR_MS + 10);
        assert_eq!((r.sample, r.old, r.new, r.other), (4, 2, 1, 1));
        assert_eq!(r.tag, Some(LogFormat::V010));
        let ids: Vec<_> = r.changes.iter().map(|c| (c.id.as_str(), c.count)).collect();
        assert_eq!(
            ids,
            vec![
                ("outcome", 2),
                ("msg_without_flow", 2),
                ("status", 1),
                ("err", 1),
                ("job_scope", 1)
            ]
        );
        assert_eq!(r.rollout.len(), 2);
        assert_eq!((r.rollout[0].old, r.rollout[0].new), (2, 0));
        assert_eq!((r.rollout[1].old, r.rollout[1].new), (0, 1));
    }
}
