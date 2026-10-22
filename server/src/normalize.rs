//! Turn one raw log line into a [`LogLine`].
//!
//! Rules (see docs/logging-guide.md):
//! - JSON first; anything that isn't a JSON object stays as raw text.
//! - Timestamp from `time` / `timestamp` / `ts` / `@timestamp`, else the
//!   collector's timestamp (Docker), else arrival time.
//! - Duplicate keys are tolerated: we keep the last value (like JSON.parse)
//!   but flag the line, and for timestamp keys we prefer the ISO-parsable one.
//! - Pino numeric levels map to names.
//! - Every correlation id present is indexed; one is chosen for display by
//!   priority request_id → job_id → trace_id → correlation_id.

use chrono::{DateTime, Utc};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl Level {
    pub fn from_number(n: f64) -> Option<Level> {
        // pino: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
        Some(match n as i64 {
            i64::MIN..=14 => Level::Trace,
            15..=24 => Level::Debug,
            25..=34 => Level::Info,
            35..=44 => Level::Warn,
            45..=54 => Level::Error,
            _ => Level::Fatal,
        })
    }

    pub fn parse_name(s: &str) -> Option<Level> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "trace" | "verbose" => Level::Trace,
            "debug" | "dbg" => Level::Debug,
            "info" | "information" | "notice" | "log" => Level::Info,
            "warn" | "warning" => Level::Warn,
            "error" | "err" => Level::Error,
            "fatal" | "critical" | "crit" | "panic" | "emergency" | "alert" => Level::Fatal,
            other => {
                return other.parse::<f64>().ok().and_then(Level::from_number);
            }
        })
    }
}

/// One correlation id found on a line, with its canonical key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CorrId {
    pub key: &'static str,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    /// Monotonic per server process; assigned by the hub.
    pub id: u64,
    /// Event time, unix ms.
    pub ts: i64,
    /// Arrival time at quiet, unix ms.
    pub received: i64,
    pub source: String,
    pub level: Option<Level>,
    /// The id shown on the row (first by priority).
    pub display_id: Option<CorrId>,
    /// Every correlation id on the line (what flows stitch on).
    pub ids: Vec<CorrId>,
    /// One-line summary for the stream row.
    pub msg: String,
    /// Parsed JSON object, when the line was JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
    pub raw: String,
    /// Oddities worth showing in the Raw view, e.g. `duplicate_key:timestamp`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<String>,
}

const TS_KEYS: &[&str] = &["timestamp", "time", "ts", "@timestamp"];
const LEVEL_KEYS: &[&str] = &["level", "lvl", "severity", "log.level", "levelname"];
const MSG_KEYS: &[&str] = &["msg", "message", "event"];

/// Canonical id key and the spellings that map to it, in display priority.
const ID_KEYS: &[(&str, &[&str])] = &[
    (
        "request_id",
        &[
            "request_id",
            "requestId",
            "requestID",
            "req_id",
            "reqId",
            "x-request-id",
            "x_request_id",
        ],
    ),
    ("job_id", &["job_id", "jobId", "jobID"]),
    ("trace_id", &["trace_id", "traceId", "traceID", "trace.id"]),
    (
        "correlation_id",
        &[
            "correlation_id",
            "correlationId",
            "correlationID",
            "x-correlation-id",
        ],
    ),
];

/// How deep to look for correlation ids (e.g. `job.data.request_id`).
const ID_DEPTH: usize = 4;

pub fn normalize(raw: &str, source: &str, collector_ts: Option<i64>, received: i64) -> LogLine {
    let raw = raw.trim_end_matches(['\r', '\n']).to_string();
    let mut flags = Vec::new();

    let parsed = parse_object(&raw);
    let Some(entries) = parsed else {
        return LogLine {
            id: 0,
            ts: collector_ts.unwrap_or(received),
            received,
            source: source.to_string(),
            level: sniff_text_level(&raw),
            display_id: None,
            ids: Vec::new(),
            msg: truncate(&raw, 400),
            fields: None,
            raw,
            flags,
        };
    };

    // Duplicate keys: last wins, but remember every timestamp candidate.
    let mut map = Map::new();
    let mut ts_candidates: Vec<&Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (k, v) in entries.iter() {
        if !seen.insert(k.as_str()) {
            flags.push(format!("duplicate_key:{k}"));
        }
        if TS_KEYS.contains(&k.as_str()) {
            ts_candidates.push(v);
        }
    }
    for (k, v) in entries.iter() {
        map.insert(k.clone(), v.clone());
    }

    // Timestamp: ISO strings first, then numbers.
    let ts = ts_candidates
        .iter()
        .find_map(|v| v.as_str().and_then(parse_iso))
        .or_else(|| ts_candidates.iter().find_map(|v| parse_epoch(v)));
    if ts.is_none() {
        flags.push(if collector_ts.is_some() {
            "ts:collector".into()
        } else {
            "ts:arrival".into()
        });
    }
    let ts = ts.or(collector_ts).unwrap_or(received);

    let level = LEVEL_KEYS.iter().find_map(|k| {
        map.get(*k).and_then(|v| match v {
            Value::Number(n) => n.as_f64().and_then(Level::from_number),
            Value::String(s) => Level::parse_name(s),
            _ => None,
        })
    });

    let mut ids = Vec::new();
    collect_ids(&map, 0, &mut ids);
    let display_id = ID_KEYS
        .iter()
        .find_map(|(canon, _)| ids.iter().find(|i| i.key == *canon).cloned());

    let msg = summarize(&map).unwrap_or_else(|| truncate(&raw, 400));

    LogLine {
        id: 0,
        ts,
        received,
        source: source.to_string(),
        level,
        display_id,
        ids,
        msg,
        fields: Some(Value::Object(map)),
        raw,
        flags,
    }
}

fn collect_ids(map: &Map<String, Value>, depth: usize, out: &mut Vec<CorrId>) {
    for (canon, spellings) in ID_KEYS {
        for s in *spellings {
            if let Some(v) = map.get(*s) {
                let value = match v {
                    Value::String(s) if !s.is_empty() => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => continue,
                };
                if !out.iter().any(|i| i.key == *canon && i.value == value) {
                    out.push(CorrId { key: canon, value });
                }
            }
        }
    }
    if depth + 1 >= ID_DEPTH {
        return;
    }
    for v in map.values() {
        if let Value::Object(child) = v {
            collect_ids(child, depth + 1, out);
        }
    }
}

fn summarize(map: &Map<String, Value>) -> Option<String> {
    for k in MSG_KEYS {
        if let Some(Value::String(s)) = map.get(*k) {
            if !s.is_empty() {
                return Some(truncate(s, 400));
            }
        }
    }
    // Canonical HTTP line without a message: "GET /orders 200".
    let get = |keys: &[&str]| keys.iter().find_map(|k| map.get(*k)).map(scalar);
    let method = get(&["method", "http_method"]);
    let path = get(&["path", "route", "url"]);
    let status = get(&["status", "status_code", "statusCode"]);
    match (method, path) {
        (Some(m), Some(p)) => Some(match status {
            Some(s) => format!("{m} {p} {s}"),
            None => format!("{m} {p}"),
        }),
        _ => None,
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse_iso(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc).timestamp_millis())
        .ok()
}

fn parse_epoch(v: &Value) -> Option<i64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.parse::<f64>().ok()?,
        _ => return None,
    };
    if n > 1e17 {
        Some((n / 1e6) as i64) // ns
    } else if n > 1e14 {
        Some((n / 1e3) as i64) // µs
    } else if n > 1e11 {
        Some(n as i64) // ms
    } else if n > 1e8 {
        Some((n * 1e3) as i64) // s
    } else {
        None
    }
}

fn sniff_text_level(raw: &str) -> Option<Level> {
    let head: String = raw.chars().take(80).collect();
    for (needle, lvl) in [
        ("FATAL", Level::Fatal),
        ("PANIC", Level::Fatal),
        ("ERROR", Level::Error),
        ("WARN", Level::Warn),
        ("INFO", Level::Info),
        ("DEBUG", Level::Debug),
        ("TRACE", Level::Trace),
    ] {
        if head.contains(needle) {
            return Some(lvl);
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

/// Top-level object entries in order, duplicates kept.
struct Entries(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Entries {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Entries;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Entries, A::Error> {
                let mut out = Vec::with_capacity(m.size_hint().unwrap_or(16));
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Entries(out))
            }
        }
        d.deserialize_map(V).map_err(de::Error::custom)
    }
}

fn parse_object(raw: &str) -> Option<Vec<(String, Value)>> {
    let t = raw.trim_start();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Entries>(t).ok().map(|e| e.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000_000;

    #[test]
    fn plain_text_stays_raw() {
        let l = normalize("server listening on :3000", "api", None, NOW);
        assert!(l.fields.is_none());
        assert_eq!(l.msg, "server listening on :3000");
        assert_eq!(l.ts, NOW);
    }

    #[test]
    fn text_level_sniffed() {
        let l = normalize("2026-10-22 ERROR boom", "api", None, NOW);
        assert_eq!(l.level, Some(Level::Error));
    }

    #[test]
    fn pino_line() {
        let l = normalize(
            r#"{"level":50,"time":1760000000123,"msg":"payment failed","req":{"id":"r1"},"request_id":"req_9"}"#,
            "api",
            None,
            NOW,
        );
        assert_eq!(l.level, Some(Level::Error));
        assert_eq!(l.ts, 1_760_000_000_123);
        assert_eq!(l.msg, "payment failed");
        assert_eq!(l.display_id.unwrap().value, "req_9");
    }

    #[test]
    fn iso_timestamp_and_string_level() {
        let l = normalize(
            r#"{"timestamp":"2026-10-22T08:00:00.500Z","level":"warning","message":"slow"}"#,
            "w",
            None,
            NOW,
        );
        assert_eq!(l.level, Some(Level::Warn));
        assert_eq!(l.ts, 1_792_656_000_500);
    }

    #[test]
    fn duplicate_timestamp_prefers_iso_and_flags() {
        let l = normalize(
            r#"{"timestamp":"not a date","msg":"x","timestamp":"2026-10-22T08:00:00Z"}"#,
            "api",
            None,
            NOW,
        );
        assert_eq!(l.ts, 1_792_656_000_000);
        assert!(l.flags.iter().any(|f| f == "duplicate_key:timestamp"));

        let l = normalize(
            r#"{"timestamp":"2026-10-22T08:00:00Z","timestamp":1}"#,
            "api",
            None,
            NOW,
        );
        assert_eq!(l.ts, 1_792_656_000_000, "ISO wins even when it isn't last");
    }

    #[test]
    fn every_id_indexed_and_priority_display() {
        let l = normalize(
            r#"{"msg":"job picked up","job_id":"42","data":{"request_id":"req_1"},"trace_id":"t1"}"#,
            "worker",
            None,
            NOW,
        );
        let keys: Vec<_> = l.ids.iter().map(|i| (i.key, i.value.as_str())).collect();
        assert!(keys.contains(&("job_id", "42")));
        assert!(keys.contains(&("request_id", "req_1")));
        assert!(keys.contains(&("trace_id", "t1")));
        assert_eq!(l.display_id.unwrap().key, "request_id");
    }

    #[test]
    fn canonical_http_summary_and_collector_ts() {
        let l = normalize(
            r#"{"method":"POST","path":"/orders","status":201}"#,
            "api",
            Some(5),
            NOW,
        );
        assert_eq!(l.msg, "POST /orders 201");
        assert_eq!(l.ts, 5);
        assert!(l.flags.contains(&"ts:collector".to_string()));
    }

    #[test]
    fn epoch_seconds_and_nanos() {
        assert_eq!(
            parse_epoch(&serde_json::json!(1760000000)),
            Some(1_760_000_000_000)
        );
        assert_eq!(
            parse_epoch(&serde_json::json!(1760000000123456789u64)),
            Some(1_760_000_000_123)
        );
    }
}
