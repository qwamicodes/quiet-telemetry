//! Request bodies from log shippers → raw lines with a source name.
//!
//! - `ndjson` (curl, `quiet pipe`, anything): one JSON object or plain text
//!   line per row; a row that is a JSON array is unwrapped.
//! - `vector` (Vector `http` sink, `encoding.codec = "json"`): newline
//!   delimited objects or one JSON array per request.
//! - `fluentbit` (Fluent Bit `http` output, `format json_lines | json | json_stream`).
//!
//! Shippers wrap an app's line in an envelope (`{"message": "<the line>",
//! "container_name": …, "timestamp": …}` from Vector's docker_logs,
//! `{"log": "<the line>", "date": …}` from Fluent Bit's tail/docker inputs).
//! The envelope is opened when its message is itself a JSON object, or when
//! everything around the message is collector metadata, so the app's own
//! line is what gets stored and its ids stitch flows. Anything else is kept
//! whole. The envelope's time becomes the collector timestamp.

use crate::pipeline::RawLine;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shipper {
    Ndjson,
    Vector,
    FluentBit,
}

/// Where a line's source name comes from, strongest first: the token's
/// bound source, `X-Quiet-Source`, the Fluent Bit tag header, a field on the
/// line, then the receiver's default.
#[derive(Debug, Clone, Default)]
pub struct Naming {
    /// Bound token or `X-Quiet-Source`: every line goes here.
    pub fixed: Option<String>,
    /// Fluent Bit tag (`Header_Tag`), e.g. `legivent.api` → `legivent-api`.
    pub tag: Option<String>,
    pub default: String,
}

impl Naming {
    fn name(&self, envelope: Option<&Map<String, Value>>) -> String {
        if let Some(f) = &self.fixed {
            return f.clone();
        }
        if let Some(t) = &self.tag {
            return t.replace('.', "-");
        }
        envelope
            .and_then(field_source)
            .unwrap_or_else(|| self.default.clone())
    }
}

/// A source named on the line itself.
fn field_source(m: &Map<String, Value>) -> Option<String> {
    ["source", "service", "service.name", "container_name"]
        .iter()
        .find_map(|k| match m.get(*k) {
            Some(Value::String(s)) if !s.trim().is_empty() => {
                Some(s.trim().trim_start_matches('/').to_string())
            }
            _ => None,
        })
}

/// Keys a collector puts around a line (Vector docker_logs/file/kubernetes,
/// Fluent Bit tail/docker). A message surrounded only by these is unwrapped.
const ENVELOPE_KEYS: &[&str] = &[
    "timestamp",
    "@timestamp",
    "date",
    "time",
    "source_type",
    "stream",
    "container_id",
    "container_name",
    "container_created_at",
    "image",
    "label",
    "host",
    "hostname",
    "file",
    "path",
    "offset",
    "tag",
    "kubernetes",
    "docker",
    "source",
    "service",
    "partial_message",
];

fn collector_ts(m: &Map<String, Value>) -> Option<i64> {
    for k in ["timestamp", "@timestamp", "time", "date"] {
        match m.get(k) {
            Some(Value::String(s)) => {
                if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
                    return Some(d.timestamp_millis());
                }
            }
            // Fluent Bit's `date` is epoch seconds as a float.
            Some(Value::Number(n)) => {
                if let Some(f) = n.as_f64() {
                    return Some(if f > 1e11 {
                        f as i64
                    } else {
                        (f * 1000.0) as i64
                    });
                }
            }
            _ => {}
        }
    }
    None
}

/// One record from a shipper → one raw line.
fn open_envelope(
    m: &Map<String, Value>,
    text: &str,
    shipper: Shipper,
    naming: &Naming,
    received: i64,
) -> RawLine {
    // Plain NDJSON is named by the request alone; shippers name per record.
    let source = naming.name((shipper != Shipper::Ndjson).then_some(m));
    let key = match shipper {
        Shipper::Vector => "message",
        Shipper::FluentBit => "log",
        Shipper::Ndjson => "",
    };
    if let Some(Value::String(inner)) = m.get(key) {
        let inner = inner.trim_end_matches(['\r', '\n']);
        let is_object = inner.trim_start().starts_with('{')
            && matches!(serde_json::from_str::<Value>(inner), Ok(Value::Object(_)));
        let only_metadata = m
            .keys()
            .all(|k| k == key || ENVELOPE_KEYS.contains(&k.as_str()));
        if is_object || only_metadata {
            let mut r = RawLine::new(inner.trim(), source, received);
            r.collector_ts = collector_ts(m);
            return r;
        }
    }
    RawLine::new(text.trim(), source, received)
}

/// Split a body into raw lines.
pub fn parse(body: &str, shipper: Shipper, naming: &Naming, received: i64) -> Vec<RawLine> {
    if shipper != Shipper::Ndjson {
        if let Some(lines) = parse_json_stream(body, shipper, naming, received) {
            return lines;
        }
    }
    split_lines(body, shipper, naming, received)
}

/// NDJSON, concatenated objects or arrays of objects, keeping each object's
/// original text (duplicate keys and all). `None` when the body isn't JSON.
fn parse_json_stream(
    body: &str,
    shipper: Shipper,
    naming: &Naming,
    received: i64,
) -> Option<Vec<RawLine>> {
    let mut out = Vec::new();
    let mut stream = serde_json::Deserializer::from_str(body).into_iter::<Value>();
    let mut start = 0;
    while let Some(next) = stream.next() {
        let end = stream.byte_offset();
        let v = next.ok()?;
        let text = &body[start..end];
        start = end;
        match v {
            Value::Object(m) => out.push(open_envelope(&m, text, shipper, naming, received)),
            Value::Array(items) => {
                for item in items {
                    let text = item.to_string();
                    match &item {
                        Value::Object(m) => {
                            out.push(open_envelope(m, &text, shipper, naming, received))
                        }
                        Value::String(s) => {
                            out.push(RawLine::new(s.as_str(), naming.name(None), received))
                        }
                        _ => out.push(RawLine::new(text, naming.name(None), received)),
                    }
                }
            }
            Value::String(s) => out.push(RawLine::new(s, naming.name(None), received)),
            other => out.push(RawLine::new(other.to_string(), naming.name(None), received)),
        }
    }
    Some(out)
}

/// One JSON object or plain text line per row; a JSON array row is unwrapped.
fn split_lines(body: &str, shipper: Shipper, naming: &Naming, received: i64) -> Vec<RawLine> {
    let mut out = Vec::new();
    for raw in body.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let parsed = (raw.starts_with('{') || raw.starts_with('['))
            .then(|| serde_json::from_str::<Value>(raw).ok())
            .flatten();
        match parsed {
            Some(Value::Array(items)) => {
                for item in items {
                    let text = item.to_string();
                    match &item {
                        Value::Object(m) => {
                            out.push(open_envelope(m, &text, shipper, naming, received))
                        }
                        _ => out.push(RawLine::new(text, naming.name(None), received)),
                    }
                }
            }
            Some(Value::Object(m)) => out.push(open_envelope(&m, raw, shipper, naming, received)),
            _ => out.push(RawLine::new(raw, naming.name(None), received)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naming(default: &str) -> Naming {
        Naming {
            default: default.into(),
            ..Default::default()
        }
    }

    fn texts(r: &[RawLine]) -> Vec<(&str, &str)> {
        r.iter()
            .map(|l| (l.source.as_str(), l.text.as_str()))
            .collect()
    }

    #[test]
    fn ndjson_rows_text_and_arrays() {
        let r = parse(
            "{\"a\":1}\n\n  plain  \n[{\"msg\":\"x\"},{\"msg\":\"y\"}]\n[not json",
            Shipper::Ndjson,
            &naming("http"),
            1,
        );
        assert_eq!(
            texts(&r),
            vec![
                ("http", "{\"a\":1}"),
                ("http", "plain"),
                ("http", "{\"msg\":\"x\"}"),
                ("http", "{\"msg\":\"y\"}"),
                ("http", "[not json"),
            ]
        );
    }

    #[test]
    fn vector_docker_logs_envelope_is_opened() {
        // encoding.codec = "json", framing newline_delimited.
        let body = concat!(
            r#"{"container_name":"/legivent-api","message":"{\"level\":30,\"msg\":\"ok\",\"request_id\":\"r1\",\"request_id\":\"r1\"}","source_type":"docker_logs","stream":"stdout","timestamp":"2026-10-22T14:07:12.004Z"}"#,
            "\n",
            r#"{"container_name":"traefik","message":"GET /health 200","source_type":"docker_logs","timestamp":"2026-10-22T14:07:13Z"}"#,
            "\n",
            r#"{"message":"user signed in","user_id":42,"source":"auth"}"#,
            "\n"
        );
        let r = parse(body, Shipper::Vector, &naming("vector"), 1);
        assert_eq!(r[0].source, "legivent-api");
        assert_eq!(
            r[0].text, r#"{"level":30,"msg":"ok","request_id":"r1","request_id":"r1"}"#,
            "the app's own line, duplicate keys intact"
        );
        assert_eq!(r[0].collector_ts, Some(1_792_678_032_004));
        assert_eq!(
            (r[1].source.as_str(), r[1].text.as_str()),
            ("traefik", "GET /health 200")
        );
        // A parsed event with its own fields is kept whole.
        assert_eq!(r[2].source, "auth");
        assert!(r[2].text.contains("\"user_id\":42"));

        // Default framing: one JSON array per request.
        let r = parse(
            r#"[{"message":"a","host":"h"},{"message":"b","host":"h"}]"#,
            Shipper::Vector,
            &naming("vector"),
            1,
        );
        assert_eq!(texts(&r), vec![("vector", "a"), ("vector", "b")]);
    }

    #[test]
    fn fluent_bit_formats_and_tag() {
        let tagged = Naming {
            tag: Some("legivent.cron".into()),
            default: "fluent-bit".into(),
            ..Default::default()
        };
        // json_lines with the tail input's `log` key and json_date_key `date`.
        let body = "{\"date\":1792678032.5,\"log\":\"{\\\"msg\\\":\\\"run\\\",\\\"job_id\\\":\\\"7\\\"}\\n\"}\n{\"date\":1792678033.0,\"log\":\"plain\\n\"}\n";
        let r = parse(body, Shipper::FluentBit, &tagged, 1);
        assert_eq!(
            texts(&r),
            vec![
                ("legivent-cron", "{\"msg\":\"run\",\"job_id\":\"7\"}"),
                ("legivent-cron", "plain")
            ]
        );
        assert_eq!(r[0].collector_ts, Some(1_792_678_032_500));
        // format json: one array; json_stream: concatenated objects.
        let r = parse(
            r#"[{"date":1.0,"msg":"a"}]{"date":2.0,"msg":"b"}"#,
            Shipper::FluentBit,
            &naming("fluent-bit"),
            1,
        );
        assert_eq!(r.len(), 2);
        assert!(r[1].text.contains("\"b\""));
        // Not JSON at all: falls back to lines.
        let r = parse("one\ntwo", Shipper::FluentBit, &naming("fluent-bit"), 1);
        assert_eq!(
            texts(&r),
            vec![("fluent-bit", "one"), ("fluent-bit", "two")]
        );
    }

    #[test]
    fn fixed_source_wins() {
        let n = Naming {
            fixed: Some("cron".into()),
            tag: Some("x.y".into()),
            default: "d".into(),
        };
        let r = parse(
            r#"{"message":"m","container_name":"api"}"#,
            Shipper::Vector,
            &n,
            1,
        );
        assert_eq!(r[0].source, "cron");
    }
}
