//! What the stream and a source page show around the lines themselves.
//!
//! GET /api/stream/stats?source=&q=&window=        level chips, volume histogram, totals
//! GET /api/sources/:name/fields?sample=2000       fields detected, flow ids, malformed lines
//! GET /api/id-coverage?keys=a,b&sample=2000       how often each id key appears, all sources
//!
//! Stats are counted in the store (SQL `GROUP BY` for SQLite), never from the
//! client's buffer, so the chips say how many lines the window really holds.

use crate::api::AppState;
use crate::hub::Line;
use crate::normalize::{IdKey, LogLine};
use crate::search::{Bucket, SearchQuery};
use crate::store::LevelCounts;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/stream/stats", get(stats))
        .route("/api/sources/:name/fields", get(fields))
        .route("/api/id-coverage", get(id_coverage))
}

/// The stream histogram covers the last hour in one-minute bars.
pub const HIST_MS: i64 = 3_600_000;
pub const HIST_BARS: usize = 60;

#[derive(Debug, Deserialize)]
pub struct StatsParams {
    pub source: String,
    /// The stream's text and `key:value` chips (the search language).
    pub q: Option<String>,
}

/// Lines per level chip.
#[derive(Debug, Clone, Default, Serialize, TS, PartialEq)]
pub struct LevelTally {
    /// trace + debug
    pub debug: u64,
    pub info: u64,
    pub warn: u64,
    /// error + fatal
    pub error: u64,
    /// Lines without a level (plain text).
    pub none: u64,
}

impl From<&LevelCounts> for LevelTally {
    fn from(c: &LevelCounts) -> Self {
        let r = &c.by_rank;
        LevelTally {
            debug: r[0] + r[1],
            info: r[2],
            warn: r[3],
            error: r[4] + r[5],
            none: r[6],
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct StreamStats {
    /// Every line of the source in the window, unfiltered.
    pub total: u64,
    /// Lines matching `q` per level chip (the chips' counts; the level chips
    /// themselves are not applied, so a chip shows what turning it on adds).
    pub levels: LevelTally,
    /// Matches of `q` per minute over the last hour, split by level.
    pub histogram: Vec<Bucket>,
    /// The searchable window, unix ms.
    pub since: i64,
    pub until: i64,
    /// Where the histogram starts (unix ms) and its bar width.
    pub hist_since: i64,
    pub hist_width: i64,
}

fn unavailable(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "store read failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "store unavailable" })),
    )
        .into_response()
}

async fn stats(State(s): State<AppState>, Query(p): Query<StatsParams>) -> Response {
    let until = chrono::Utc::now().timestamp_millis();
    let since = until - s.retention_ms();
    // Whole minutes, so bars don't shift every second.
    let width = HIST_MS / HIST_BARS as i64;
    let hist_since = (until / width + 1) * width - HIST_MS;
    let store = s.pipeline.store();
    // Lines just received are searchable once flushed.
    let _ = store.flush().await;

    let base = SearchQuery {
        sources: vec![p.source.clone()],
        since: Some(since),
        until: Some(until),
        ..Default::default()
    };
    let mut filtered = base.clone().parse_q(p.q.as_deref().unwrap_or(""));
    filtered.sources = vec![p.source.clone()];
    filtered.levels.clear();
    filtered.min_level = None;
    let counts = match store
        .level_counts(&filtered, Some((hist_since, width, HIST_BARS)))
        .await
    {
        Ok(c) => c,
        Err(e) => return unavailable(e),
    };
    let unfiltered = p.q.as_deref().is_none_or(|q| q.trim().is_empty());
    let total = if unfiltered {
        counts.total()
    } else {
        match store.level_counts(&base, None).await {
            Ok(c) => c.total(),
            Err(e) => return unavailable(e),
        }
    };
    Json(StreamStats {
        total,
        levels: LevelTally::from(&counts),
        histogram: counts.histogram,
        since,
        until,
        hist_since,
        hist_width: width,
    })
    .into_response()
}

// ---- fields detected -------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct FieldsParams {
    pub sample: Option<usize>,
}

/// One field seen in a source's recent lines.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
pub struct DetectedField {
    /// Dot path (`err.code`); arrays and deep objects stay whole.
    pub key: String,
    /// `str`, `num`, `bool`, `obj`, `arr`, `null`, or `mixed`.
    pub kind: String,
    /// Share of sampled JSON lines carrying it, 0–1.
    pub coverage: f64,
    /// The newest value, as text (cut at 80 chars).
    pub sample: String,
}

/// How often a correlation-id key appears.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
pub struct IdCoverage {
    pub key: IdKey,
    /// Share of sampled lines carrying it, 0–1.
    pub coverage: f64,
    /// Share of sampled lines where it is the id the row shows, 0–1.
    pub shown: f64,
}

/// A line kept as raw text instead of parsed JSON, or parsed with a problem.
#[derive(Debug, Clone, Serialize, TS)]
pub struct MalformedLine {
    #[ts(type = "number")]
    pub id: u64,
    pub ts: i64,
    /// `not JSON`, `truncated`, `duplicate key`, …
    pub reason: String,
    /// The first 300 characters.
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceFields {
    /// Lines looked at (newest first, up to `sample`).
    pub sampled: u64,
    /// How many of those were JSON objects.
    pub json: u64,
    pub fields: Vec<DetectedField>,
    pub ids: Vec<IdCoverage>,
    /// Malformed lines in the whole window (counted in the store).
    pub malformed_total: u64,
    /// The newest malformed lines (up to 50).
    pub malformed: Vec<MalformedLine>,
}

fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "num",
        Value::String(_) => "str",
        Value::Array(_) => "arr",
        Value::Object(_) => "obj",
    }
}

/// Flatten to dot paths three levels deep, like the field card does.
fn flatten<'a>(v: &'a Value, prefix: String, depth: usize, out: &mut Vec<(String, &'a Value)>) {
    let Some(obj) = v.as_object() else { return };
    for (k, x) in obj {
        let key = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        if x.is_object() && depth < 2 {
            flatten(x, key, depth + 1, out);
        } else {
            out.push((key, x));
        }
    }
}

/// Why a line counts as malformed, if it does.
pub fn malformed_reason(l: &LogLine) -> Option<String> {
    if l.fields.is_none() {
        let t = l.raw.trim_start();
        return Some(if t.starts_with('{') || t.starts_with('[') {
            "broken JSON".into()
        } else {
            "not JSON".into()
        });
    }
    l.flags.iter().find_map(|f| {
        if f.starts_with("truncated") {
            Some("truncated".to_string())
        } else {
            f.strip_prefix("duplicate_key:")
                .map(|k| format!("duplicate key · {k}"))
        }
    })
}

/// Fold sampled lines (newest first) into the detected-field report.
pub fn detect(lines: &[Line]) -> (Vec<DetectedField>, Vec<IdCoverage>, u64) {
    struct Acc {
        kind: &'static str,
        mixed: bool,
        n: u64,
        sample: String,
        first: usize,
    }
    let mut by: HashMap<String, Acc> = HashMap::new();
    let mut json = 0u64;
    let mut ids: BTreeMap<String, (IdKey, u64, u64)> = BTreeMap::new();
    for (i, l) in lines.iter().enumerate() {
        for id in &l.ids {
            let shown = l.display_id.as_ref().is_some_and(|d| d.key == id.key);
            let e = ids
                .entry(id.key.to_string())
                .or_insert((id.key.clone(), 0, 0));
            e.1 += 1;
            if shown {
                e.2 += 1;
            }
        }
        let Some(f) = &l.fields else { continue };
        json += 1;
        let mut flat = Vec::new();
        flatten(f, String::new(), 0, &mut flat);
        for (k, v) in flat {
            let kind = kind_of(v);
            let a = by.entry(k).or_insert_with(|| Acc {
                kind,
                mixed: false,
                n: 0,
                sample: {
                    let t = crate::search::scalar_text(v);
                    t.chars().take(80).collect()
                },
                first: i,
            });
            a.n += 1;
            if a.kind != kind && kind != "null" {
                a.mixed = a.kind != "null";
                if a.kind == "null" {
                    a.kind = kind;
                }
            }
        }
    }
    let n = lines.len().max(1) as f64;
    let jn = json.max(1) as f64;
    let mut fields: Vec<(usize, DetectedField)> = by
        .into_iter()
        .map(|(key, a)| {
            (
                a.first,
                DetectedField {
                    key,
                    kind: if a.mixed {
                        "mixed".into()
                    } else {
                        a.kind.into()
                    },
                    coverage: a.n as f64 / jn,
                    sample: a.sample,
                },
            )
        })
        .collect();
    // Most common first; ties by name so the list is stable.
    fields.sort_by(|(_, a), (_, b)| {
        b.coverage
            .partial_cmp(&a.coverage)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });
    let ids = ids
        .into_values()
        .map(|(key, c, s)| IdCoverage {
            key,
            coverage: c as f64 / n,
            shown: s as f64 / n,
        })
        .collect();
    (fields.into_iter().map(|(_, f)| f).collect(), ids, json)
}

async fn fields(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(p): Query<FieldsParams>,
) -> Response {
    let store = s.pipeline.store();
    let sample = p.sample.unwrap_or(2000).clamp(1, 10_000);
    let until = chrono::Utc::now().timestamp_millis();
    let since = until - s.retention_ms();
    let _ = store.flush().await;
    let page = match store
        .search(&SearchQuery {
            sources: vec![name.clone()],
            since: Some(since),
            until: Some(until),
            limit: sample.min(crate::search::MAX_PAGE),
            ..Default::default()
        })
        .await
    {
        Ok(p) => p,
        Err(e) => return unavailable(e),
    };
    let (fields, ids, json) = detect(&page.lines);
    let malformed: Vec<MalformedLine> = page
        .lines
        .iter()
        .filter_map(|l| {
            malformed_reason(l).map(|reason| MalformedLine {
                id: l.id,
                ts: l.ts,
                reason,
                raw: l.raw.chars().take(300).collect(),
            })
        })
        .take(50)
        .collect();
    // In the window: lines without a level that aren't JSON objects are the
    // bulk of malformed ones; count those in the store, plus flagged ones seen.
    let malformed_total = match store
        .level_counts(
            &SearchQuery {
                sources: vec![name.clone()],
                since: Some(since),
                until: Some(until),
                not_text: vec!["{".into()],
                ..Default::default()
            },
            None,
        )
        .await
    {
        Ok(c) => c.total().max(malformed.len() as u64),
        Err(_) => malformed.len() as u64,
    };
    Json(SourceFields {
        sampled: page.lines.len() as u64,
        json,
        fields,
        ids,
        malformed_total,
        malformed,
    })
    .into_response()
}

// ---- id coverage (Settings → Flow id order) ----------------------------------------

#[derive(Debug, Deserialize)]
pub struct IdCoverageParams {
    /// Comma-separated keys; built-in names or custom field names / dotted paths.
    pub keys: Option<String>,
    pub sample: Option<usize>,
}

/// How often one id key (built-in or custom) appears in recent lines, whatever
/// the current order says, so a field can be judged before it is added.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
pub struct KeyCoverage {
    pub key: IdKey,
    /// Share of sampled lines carrying it, 0–1.
    pub coverage: f64,
    /// Sources it was seen on, most lines first (at most 5).
    pub sources: Vec<String>,
}

/// `GET /api/id-coverage`.
#[derive(Debug, Clone, Serialize, TS)]
pub struct IdCoverageReport {
    /// Lines looked at (newest first across every source).
    pub sampled: u64,
    pub keys: Vec<KeyCoverage>,
}

/// Fold sampled lines into per-key coverage.
pub fn key_coverage(lines: &[Line], keys: &[IdKey]) -> Vec<KeyCoverage> {
    let n = lines.len().max(1) as f64;
    keys.iter()
        .map(|k| {
            let mut hits = 0u64;
            let mut by: HashMap<&str, u64> = HashMap::new();
            for l in lines {
                let Some(Value::Object(m)) = &l.fields else {
                    continue;
                };
                if crate::normalize::id_value(m, k).is_some() {
                    hits += 1;
                    *by.entry(l.source.as_str()).or_default() += 1;
                }
            }
            let mut sources: Vec<(&str, u64)> = by.into_iter().collect();
            sources.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            KeyCoverage {
                key: k.clone(),
                coverage: hits as f64 / n,
                sources: sources
                    .into_iter()
                    .take(5)
                    .map(|(s, _)| s.to_string())
                    .collect(),
            }
        })
        .collect()
}

async fn id_coverage(State(s): State<AppState>, Query(p): Query<IdCoverageParams>) -> Response {
    let mut keys: Vec<IdKey> = match p.keys.as_deref() {
        Some(k) => k
            .split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(IdKey::from_name)
            .collect(),
        None => crate::idpolicy::ALL.to_vec(),
    };
    keys.dedup();
    if keys.len() > 32
        || keys
            .iter()
            .any(|k| k.is_custom() && !crate::settings::valid_custom_key(k.as_str()))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "keys: up to 32 id keys or field names" })),
        )
            .into_response();
    }
    let store = s.pipeline.store();
    let sample = p.sample.unwrap_or(2000).clamp(1, 10_000);
    let until = chrono::Utc::now().timestamp_millis();
    let since = until - s.retention_ms();
    let _ = store.flush().await;
    let page = match store
        .search(&SearchQuery {
            since: Some(since),
            until: Some(until),
            limit: sample.min(crate::search::MAX_PAGE),
            ..Default::default()
        })
        .await
    {
        Ok(p) => p,
        Err(e) => return unavailable(e),
    };
    Json(IdCoverageReport {
        sampled: page.lines.len() as u64,
        keys: key_coverage(&page.lines, &keys),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use std::sync::Arc;

    #[test]
    fn key_coverage_counts_builtin_and_custom_keys_per_source() {
        let mk = |src: &str, raw: &str| Arc::new(normalize(raw, src, None, 0));
        let lines: Vec<Line> = vec![
            mk("api", r#"{"msg":"a","requestId":"r1","x-edge":"e1"}"#),
            mk("api", r#"{"msg":"b","request_id":"r2"}"#),
            mk(
                "worker",
                r#"{"msg":"c","job":{"data":{"request_id":"r1"}},"ctx":{"trace":"t"}}"#,
            ),
            mk("edge", "not json"),
        ];
        let keys = [
            IdKey::RequestId,
            IdKey::Custom("x-edge".into()),
            IdKey::Custom("ctx.trace".into()),
            IdKey::JobId,
        ];
        let c = key_coverage(&lines, &keys);
        assert_eq!(c[0].coverage, 0.75);
        assert_eq!(c[0].sources, vec!["api", "worker"]);
        assert_eq!(
            (c[1].coverage, c[1].sources.clone()),
            (0.25, vec!["api".to_string()])
        );
        assert_eq!(c[2].sources, vec!["worker"]);
        assert_eq!(c[3].coverage, 0.0);
        assert!(c[3].sources.is_empty());
    }

    #[test]
    fn detects_fields_ids_and_malformed() {
        let lines: Vec<Line> = [
            r#"{"msg":"a","request_id":"r1","status":200,"err":{"code":"X"}}"#,
            r#"{"msg":"b","request_id":"r2","job_id":"j","status":"oops"}"#,
            "plain text line",
        ]
        .iter()
        .map(|r| Arc::new(normalize(r, "api", None, 0)))
        .collect();
        let (fields, ids, json) = detect(&lines);
        assert_eq!(json, 2);
        let status = fields.iter().find(|f| f.key == "status").unwrap();
        assert_eq!(status.kind, "mixed");
        assert_eq!(status.coverage, 1.0);
        let code = fields.iter().find(|f| f.key == "err.code").unwrap();
        assert_eq!((code.kind.as_str(), code.coverage), ("str", 0.5));
        let req = ids.iter().find(|i| i.key == IdKey::RequestId).unwrap();
        assert!((req.coverage - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(malformed_reason(&lines[2]).as_deref(), Some("not JSON"));
        assert_eq!(malformed_reason(&lines[0]), None);
    }
}
