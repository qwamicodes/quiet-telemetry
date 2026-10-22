//! OTLP/HTTP: logs (`/v1/logs`) and traces (`/v1/traces`), protobuf or JSON.
//!
//! Each log record and each span becomes one canonical JSON line, so the rest
//! of quiet (normalize, search, flows) treats it like any other line:
//!
//! - log record → `{ timestamp, level, msg, service, trace_id, span_id,
//!   …attributes, …body fields, resource, scope }`
//! - span → `{ timestamp (end), level (error when the status is ERROR), msg
//!   and name (span name), otel.type: "span", span.kind, duration_ms,
//!   trace_id, span_id, parent_span_id, otel.status_code, …attributes,
//!   steps (span events, `at_ms` from the span start), resource, scope }`
//!
//! The source is the resource's `service.name` unless the token (or
//! `X-Quiet-Source`) names one. Ids are lowercase hex. gRPC is v0.2.
//!
//! The protobuf messages are the subset of opentelemetry-proto v1 quiet
//! reads, declared with prost by hand (field numbers from the .proto files),
//! so the build needs no protoc and no tonic.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Number, Value};

pub mod pb {
    //! opentelemetry/proto/{common,resource,logs,trace}/v1 (subset).

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct AnyValue {
        #[prost(oneof = "any_value::Value", tags = "1, 2, 3, 4, 5, 6, 7")]
        pub value: Option<any_value::Value>,
    }

    pub mod any_value {
        // Names mirror the .proto oneof.
        #[allow(clippy::enum_variant_names)]
        #[derive(Clone, PartialEq, prost::Oneof)]
        pub enum Value {
            #[prost(string, tag = "1")]
            StringValue(String),
            #[prost(bool, tag = "2")]
            BoolValue(bool),
            #[prost(int64, tag = "3")]
            IntValue(i64),
            #[prost(double, tag = "4")]
            DoubleValue(f64),
            #[prost(message, tag = "5")]
            ArrayValue(super::ArrayValue),
            #[prost(message, tag = "6")]
            KvlistValue(super::KeyValueList),
            #[prost(bytes, tag = "7")]
            BytesValue(Vec<u8>),
        }
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ArrayValue {
        #[prost(message, repeated, tag = "1")]
        pub values: Vec<AnyValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct KeyValueList {
        #[prost(message, repeated, tag = "1")]
        pub values: Vec<KeyValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct KeyValue {
        #[prost(string, tag = "1")]
        pub key: String,
        #[prost(message, optional, tag = "2")]
        pub value: Option<AnyValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct InstrumentationScope {
        #[prost(string, tag = "1")]
        pub name: String,
        #[prost(string, tag = "2")]
        pub version: String,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Resource {
        #[prost(message, repeated, tag = "1")]
        pub attributes: Vec<KeyValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ExportLogsServiceRequest {
        #[prost(message, repeated, tag = "1")]
        pub resource_logs: Vec<ResourceLogs>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ResourceLogs {
        #[prost(message, optional, tag = "1")]
        pub resource: Option<Resource>,
        #[prost(message, repeated, tag = "2")]
        pub scope_logs: Vec<ScopeLogs>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ScopeLogs {
        #[prost(message, optional, tag = "1")]
        pub scope: Option<InstrumentationScope>,
        #[prost(message, repeated, tag = "2")]
        pub log_records: Vec<LogRecord>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct LogRecord {
        #[prost(fixed64, tag = "1")]
        pub time_unix_nano: u64,
        #[prost(fixed64, tag = "11")]
        pub observed_time_unix_nano: u64,
        #[prost(int32, tag = "2")]
        pub severity_number: i32,
        #[prost(string, tag = "3")]
        pub severity_text: String,
        #[prost(message, optional, tag = "5")]
        pub body: Option<AnyValue>,
        #[prost(message, repeated, tag = "6")]
        pub attributes: Vec<KeyValue>,
        #[prost(bytes = "vec", tag = "9")]
        pub trace_id: Vec<u8>,
        #[prost(bytes = "vec", tag = "10")]
        pub span_id: Vec<u8>,
        #[prost(string, tag = "12")]
        pub event_name: String,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ExportTraceServiceRequest {
        #[prost(message, repeated, tag = "1")]
        pub resource_spans: Vec<ResourceSpans>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ResourceSpans {
        #[prost(message, optional, tag = "1")]
        pub resource: Option<Resource>,
        #[prost(message, repeated, tag = "2")]
        pub scope_spans: Vec<ScopeSpans>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ScopeSpans {
        #[prost(message, optional, tag = "1")]
        pub scope: Option<InstrumentationScope>,
        #[prost(message, repeated, tag = "2")]
        pub spans: Vec<Span>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Span {
        #[prost(bytes = "vec", tag = "1")]
        pub trace_id: Vec<u8>,
        #[prost(bytes = "vec", tag = "2")]
        pub span_id: Vec<u8>,
        #[prost(bytes = "vec", tag = "4")]
        pub parent_span_id: Vec<u8>,
        #[prost(string, tag = "5")]
        pub name: String,
        #[prost(int32, tag = "6")]
        pub kind: i32,
        #[prost(fixed64, tag = "7")]
        pub start_time_unix_nano: u64,
        #[prost(fixed64, tag = "8")]
        pub end_time_unix_nano: u64,
        #[prost(message, repeated, tag = "9")]
        pub attributes: Vec<KeyValue>,
        #[prost(message, repeated, tag = "11")]
        pub events: Vec<SpanEvent>,
        #[prost(message, optional, tag = "15")]
        pub status: Option<Status>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct SpanEvent {
        #[prost(fixed64, tag = "1")]
        pub time_unix_nano: u64,
        #[prost(string, tag = "2")]
        pub name: String,
        #[prost(message, repeated, tag = "3")]
        pub attributes: Vec<KeyValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Status {
        #[prost(string, tag = "2")]
        pub message: String,
        #[prost(int32, tag = "3")]
        pub code: i32,
    }
}

use pb::any_value::Value as Av;

/// One converted record: its source (when the data names one) and its line.
#[derive(Debug, Clone, PartialEq)]
pub struct OtlpLine {
    pub service: Option<String>,
    pub json: String,
}

/// Which signal a request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Logs,
    Traces,
}

/// Decode a request body (`protobuf` = `application/x-protobuf`, else JSON).
pub fn decode(
    signal: Signal,
    body: &[u8],
    protobuf: bool,
    received: i64,
) -> Result<Vec<OtlpLine>, String> {
    use prost::Message;
    match (signal, protobuf) {
        (Signal::Logs, true) => pb::ExportLogsServiceRequest::decode(body)
            .map(|r| logs(&r, received))
            .map_err(|e| format!("invalid OTLP protobuf: {e}")),
        (Signal::Traces, true) => pb::ExportTraceServiceRequest::decode(body)
            .map(|r| spans(&r))
            .map_err(|e| format!("invalid OTLP protobuf: {e}")),
        (s, false) => {
            let v: Value =
                serde_json::from_slice(body).map_err(|e| format!("invalid OTLP JSON: {e}"))?;
            Ok(match s {
                Signal::Logs => logs(&json::logs(&v), received),
                Signal::Traces => spans(&json::traces(&v)),
            })
        }
    }
}

/// Resource attributes not worth repeating on every line.
fn noisy_resource_key(k: &str) -> bool {
    k == "service.name"
        || k.starts_with("telemetry.sdk.")
        || k == "process.command_args"
        || k == "process.command_line"
}

struct Context {
    service: Option<String>,
    resource: Map<String, Value>,
    scope: Option<String>,
}

fn context(resource: Option<&pb::Resource>, scope: Option<&pb::InstrumentationScope>) -> Context {
    let attrs = resource
        .map(|r| r.attributes.as_slice())
        .unwrap_or_default();
    let service = attrs
        .iter()
        .find(|kv| kv.key == "service.name")
        .and_then(|kv| match kv.value.as_ref()?.value.as_ref()? {
            Av::StringValue(s) if !s.is_empty() => Some(s.clone()),
            _ => None,
        });
    let resource = attrs
        .iter()
        .filter(|kv| !noisy_resource_key(&kv.key))
        .map(|kv| (kv.key.clone(), any(kv.value.as_ref())))
        .collect();
    let scope = scope.map(|s| s.name.clone()).filter(|s| !s.is_empty());
    Context {
        service,
        resource,
        scope,
    }
}

fn finish(mut obj: Map<String, Value>, cx: &Context) -> OtlpLine {
    if let Some(s) = &cx.service {
        obj.entry("service")
            .or_insert_with(|| Value::String(s.clone()));
    }
    if let Some(s) = &cx.scope {
        obj.entry("scope")
            .or_insert_with(|| Value::String(s.clone()));
    }
    if !cx.resource.is_empty() {
        obj.entry("resource")
            .or_insert_with(|| Value::Object(cx.resource.clone()));
    }
    OtlpLine {
        service: cx.service.clone(),
        json: Value::Object(obj).to_string(),
    }
}

fn logs(req: &pb::ExportLogsServiceRequest, received: i64) -> Vec<OtlpLine> {
    let mut out = Vec::new();
    for rl in &req.resource_logs {
        for sl in &rl.scope_logs {
            let cx = context(rl.resource.as_ref(), sl.scope.as_ref());
            for r in &sl.log_records {
                out.push(finish(log_record(r, received), &cx));
            }
        }
    }
    out
}

fn log_record(r: &pb::LogRecord, received: i64) -> Map<String, Value> {
    let mut obj = Map::new();
    // Attributes first: the record's own fields win on a clash.
    for kv in &r.attributes {
        obj.insert(kv.key.clone(), any(kv.value.as_ref()));
    }
    // A structured body (or a JSON string body, an app logging JSON through
    // an OTel bridge) spreads into the line; a text body is the message.
    match r.body.as_ref().and_then(|b| b.value.as_ref()) {
        Some(Av::KvlistValue(kv)) => {
            for kv in &kv.values {
                obj.insert(kv.key.clone(), any(kv.value.as_ref()));
            }
        }
        Some(Av::StringValue(s)) => match json_object(s) {
            Some(m) => obj.extend(m),
            None => {
                obj.insert("msg".into(), Value::String(s.clone()));
            }
        },
        Some(other) => {
            obj.insert(
                "msg".into(),
                any(Some(&pb::AnyValue {
                    value: Some(other.clone()),
                })),
            );
        }
        None => {}
    }
    let nanos = if r.time_unix_nano > 0 {
        r.time_unix_nano
    } else {
        r.observed_time_unix_nano
    };
    let ts = if nanos > 0 {
        iso(nanos)
    } else {
        iso(received as u64 * 1_000_000)
    };
    obj.insert("timestamp".into(), Value::String(ts));
    if let Some(level) = severity(r.severity_number, &r.severity_text) {
        obj.insert("level".into(), Value::String(level));
    }
    if !r.event_name.is_empty() {
        obj.entry("event")
            .or_insert_with(|| Value::String(r.event_name.clone()));
    }
    put_id(&mut obj, "trace_id", &r.trace_id);
    put_id(&mut obj, "span_id", &r.span_id);
    obj
}

fn spans(req: &pb::ExportTraceServiceRequest) -> Vec<OtlpLine> {
    let mut out = Vec::new();
    for rs in &req.resource_spans {
        for ss in &rs.scope_spans {
            let cx = context(rs.resource.as_ref(), ss.scope.as_ref());
            for s in &ss.spans {
                out.push(finish(span(s), &cx));
            }
        }
    }
    out
}

const SPAN_KINDS: [&str; 6] = [
    "unspecified",
    "internal",
    "server",
    "client",
    "producer",
    "consumer",
];

fn span(s: &pb::Span) -> Map<String, Value> {
    let mut obj = Map::new();
    for kv in &s.attributes {
        obj.insert(kv.key.clone(), any(kv.value.as_ref()));
    }
    let end = s.end_time_unix_nano.max(s.start_time_unix_nano);
    let error = s.status.as_ref().is_some_and(|st| st.code == 2);
    obj.insert("timestamp".into(), Value::String(iso(end)));
    obj.insert(
        "level".into(),
        Value::String(if error { "error" } else { "info" }.into()),
    );
    obj.insert("msg".into(), Value::String(s.name.clone()));
    obj.insert("name".into(), Value::String(s.name.clone()));
    obj.insert("otel.type".into(), Value::String("span".into()));
    if let Some(k) = SPAN_KINDS.get(s.kind as usize).filter(|_| s.kind > 0) {
        obj.insert("span.kind".into(), Value::String((*k).into()));
    }
    if s.start_time_unix_nano > 0 && end >= s.start_time_unix_nano {
        let ms = (end - s.start_time_unix_nano) as f64 / 1e6;
        obj.insert("duration_ms".into(), num((ms * 1000.0).round() / 1000.0));
    }
    put_id(&mut obj, "trace_id", &s.trace_id);
    put_id(&mut obj, "span_id", &s.span_id);
    put_id(&mut obj, "parent_span_id", &s.parent_span_id);
    if let Some(st) = &s.status {
        let code = match st.code {
            1 => Some("OK"),
            2 => Some("ERROR"),
            _ => None,
        };
        if let Some(c) = code {
            obj.insert("otel.status_code".into(), Value::String(c.into()));
        }
        if !st.message.is_empty() {
            obj.insert(
                "otel.status_message".into(),
                Value::String(st.message.clone()),
            );
        }
    }
    // Span events → child steps (the same shape as `wideEvents.steps`).
    if !s.events.is_empty() {
        let steps: Vec<Value> = s
            .events
            .iter()
            .map(|e| {
                let mut step = Map::new();
                step.insert("name".into(), Value::String(e.name.clone()));
                if e.time_unix_nano >= s.start_time_unix_nano && s.start_time_unix_nano > 0 {
                    step.insert(
                        "at_ms".into(),
                        Value::from(
                            ((e.time_unix_nano - s.start_time_unix_nano) / 1_000_000) as i64,
                        ),
                    );
                }
                for kv in &e.attributes {
                    if kv.key == "exception.message" {
                        step.insert("error".into(), any(kv.value.as_ref()));
                    } else if kv.key == "exception.type" {
                        step.insert("target".into(), any(kv.value.as_ref()));
                    }
                }
                Value::Object(step)
            })
            .collect();
        obj.insert("steps".into(), Value::Array(steps));
    }
    obj
}

fn put_id(obj: &mut Map<String, Value>, key: &str, bytes: &[u8]) {
    if !bytes.is_empty() && bytes.iter().any(|b| *b != 0) {
        obj.insert(key.into(), Value::String(hex(bytes)));
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn num(f: f64) -> Value {
    Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn iso(nanos: u64) -> String {
    let secs = (nanos / 1_000_000_000) as i64;
    let sub = (nanos % 1_000_000_000) as u32;
    DateTime::<Utc>::from_timestamp(secs, sub)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

/// OTLP severity → a level name quiet's normalizer reads.
fn severity(n: i32, text: &str) -> Option<String> {
    let by_number = match n {
        1..=4 => Some("trace"),
        5..=8 => Some("debug"),
        9..=12 => Some("info"),
        13..=16 => Some("warn"),
        17..=20 => Some("error"),
        21..=24 => Some("fatal"),
        _ => None,
    };
    by_number
        .map(str::to_string)
        .or_else(|| (!text.is_empty()).then(|| text.to_string()))
}

fn json_object(s: &str) -> Option<Map<String, Value>> {
    let t = s.trim();
    if !t.starts_with('{') {
        return None;
    }
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn any(v: Option<&pb::AnyValue>) -> Value {
    match v.and_then(|v| v.value.as_ref()) {
        None => Value::Null,
        Some(Av::StringValue(s)) => Value::String(s.clone()),
        Some(Av::BoolValue(b)) => Value::Bool(*b),
        Some(Av::IntValue(i)) => Value::from(*i),
        Some(Av::DoubleValue(d)) => num(*d),
        Some(Av::ArrayValue(a)) => Value::Array(a.values.iter().map(|v| any(Some(v))).collect()),
        Some(Av::KvlistValue(kv)) => Value::Object(
            kv.values
                .iter()
                .map(|kv| (kv.key.clone(), any(kv.value.as_ref())))
                .collect(),
        ),
        Some(Av::BytesValue(b)) => Value::String(hex(b)),
    }
}

/// OTLP/JSON → the same messages. The JSON mapping uses lowerCamelCase keys,
/// hex ids and 64-bit integers as strings; snake_case keys and numbers are
/// accepted too.
mod json {
    use super::pb;
    use super::Av;
    use serde_json::Value;

    fn get<'a>(v: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
        v.get(camel).or_else(|| v.get(snake))
    }

    fn arr<'a>(v: &'a Value, camel: &str, snake: &str) -> &'a [Value] {
        get(v, camel, snake)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn string(v: &Value, camel: &str, snake: &str) -> String {
        get(v, camel, snake)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    fn u64_of(v: &Value, camel: &str, snake: &str) -> u64 {
        match get(v, camel, snake) {
            Some(Value::String(s)) => s.parse().unwrap_or(0),
            Some(Value::Number(n)) => n
                .as_u64()
                .or_else(|| n.as_f64().map(|f| f as u64))
                .unwrap_or(0),
            _ => 0,
        }
    }

    fn i32_of(v: &Value, camel: &str, snake: &str) -> i32 {
        match get(v, camel, snake) {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0) as i32,
            Some(Value::String(s)) => s.parse().unwrap_or_else(|_| enum_name(s)),
            _ => 0,
        }
    }

    /// Enum names some exporters send instead of numbers.
    fn enum_name(s: &str) -> i32 {
        match s {
            "STATUS_CODE_OK" | "SPAN_KIND_INTERNAL" => 1,
            "STATUS_CODE_ERROR" | "SPAN_KIND_SERVER" => 2,
            "SPAN_KIND_CLIENT" => 3,
            "SPAN_KIND_PRODUCER" => 4,
            "SPAN_KIND_CONSUMER" => 5,
            _ => 0,
        }
    }

    fn id(v: &Value, camel: &str, snake: &str) -> Vec<u8> {
        let s = string(v, camel, snake);
        if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Vec::new();
        }
        (0..s.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
            .collect()
    }

    fn any(v: Option<&Value>) -> Option<pb::AnyValue> {
        let v = v?;
        let value = if let Some(s) = get(v, "stringValue", "string_value").and_then(Value::as_str) {
            Av::StringValue(s.to_string())
        } else if let Some(b) = get(v, "boolValue", "bool_value").and_then(Value::as_bool) {
            Av::BoolValue(b)
        } else if let Some(i) = get(v, "intValue", "int_value") {
            Av::IntValue(match i {
                Value::String(s) => s.parse().unwrap_or(0),
                other => other.as_i64().unwrap_or(0),
            })
        } else if let Some(d) = get(v, "doubleValue", "double_value") {
            Av::DoubleValue(match d {
                Value::String(s) => s.parse().unwrap_or(0.0),
                other => other.as_f64().unwrap_or(0.0),
            })
        } else if let Some(a) = get(v, "arrayValue", "array_value") {
            Av::ArrayValue(pb::ArrayValue {
                values: arr(a, "values", "values")
                    .iter()
                    .filter_map(|x| any(Some(x)))
                    .collect(),
            })
        } else if let Some(kv) = get(v, "kvlistValue", "kvlist_value") {
            Av::KvlistValue(pb::KeyValueList {
                values: kvs(arr(kv, "values", "values")),
            })
        } else {
            // bytesValue is base64 in OTLP/JSON; kept as the text it arrived as.
            let b = get(v, "bytesValue", "bytes_value").and_then(Value::as_str)?;
            Av::StringValue(b.to_string())
        };
        Some(pb::AnyValue { value: Some(value) })
    }

    fn kvs(list: &[Value]) -> Vec<pb::KeyValue> {
        list.iter()
            .map(|kv| pb::KeyValue {
                key: string(kv, "key", "key"),
                value: any(kv.get("value")),
            })
            .collect()
    }

    fn resource(v: &Value) -> Option<pb::Resource> {
        get(v, "resource", "resource").map(|r| pb::Resource {
            attributes: kvs(arr(r, "attributes", "attributes")),
        })
    }

    fn scope(v: &Value) -> Option<pb::InstrumentationScope> {
        get(v, "scope", "scope").map(|s| pb::InstrumentationScope {
            name: string(s, "name", "name"),
            version: string(s, "version", "version"),
        })
    }

    pub fn logs(v: &Value) -> pb::ExportLogsServiceRequest {
        pb::ExportLogsServiceRequest {
            resource_logs: arr(v, "resourceLogs", "resource_logs")
                .iter()
                .map(|rl| pb::ResourceLogs {
                    resource: resource(rl),
                    scope_logs: arr(rl, "scopeLogs", "scope_logs")
                        .iter()
                        .map(|sl| pb::ScopeLogs {
                            scope: scope(sl),
                            log_records: arr(sl, "logRecords", "log_records")
                                .iter()
                                .map(|r| pb::LogRecord {
                                    time_unix_nano: u64_of(r, "timeUnixNano", "time_unix_nano"),
                                    observed_time_unix_nano: u64_of(
                                        r,
                                        "observedTimeUnixNano",
                                        "observed_time_unix_nano",
                                    ),
                                    severity_number: i32_of(r, "severityNumber", "severity_number"),
                                    severity_text: string(r, "severityText", "severity_text"),
                                    body: any(r.get("body")),
                                    attributes: kvs(arr(r, "attributes", "attributes")),
                                    trace_id: id(r, "traceId", "trace_id"),
                                    span_id: id(r, "spanId", "span_id"),
                                    event_name: string(r, "eventName", "event_name"),
                                })
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    pub fn traces(v: &Value) -> pb::ExportTraceServiceRequest {
        pb::ExportTraceServiceRequest {
            resource_spans: arr(v, "resourceSpans", "resource_spans")
                .iter()
                .map(|rs| pb::ResourceSpans {
                    resource: resource(rs),
                    scope_spans: arr(rs, "scopeSpans", "scope_spans")
                        .iter()
                        .map(|ss| pb::ScopeSpans {
                            scope: scope(ss),
                            spans: arr(ss, "spans", "spans")
                                .iter()
                                .map(|s| pb::Span {
                                    trace_id: id(s, "traceId", "trace_id"),
                                    span_id: id(s, "spanId", "span_id"),
                                    parent_span_id: id(s, "parentSpanId", "parent_span_id"),
                                    name: string(s, "name", "name"),
                                    kind: i32_of(s, "kind", "kind"),
                                    start_time_unix_nano: u64_of(
                                        s,
                                        "startTimeUnixNano",
                                        "start_time_unix_nano",
                                    ),
                                    end_time_unix_nano: u64_of(
                                        s,
                                        "endTimeUnixNano",
                                        "end_time_unix_nano",
                                    ),
                                    attributes: kvs(arr(s, "attributes", "attributes")),
                                    events: arr(s, "events", "events")
                                        .iter()
                                        .map(|e| pb::SpanEvent {
                                            time_unix_nano: u64_of(
                                                e,
                                                "timeUnixNano",
                                                "time_unix_nano",
                                            ),
                                            name: string(e, "name", "name"),
                                            attributes: kvs(arr(e, "attributes", "attributes")),
                                        })
                                        .collect(),
                                    status: get(s, "status", "status").map(|st| pb::Status {
                                        message: string(st, "message", "message"),
                                        code: i32_of(st, "code", "code"),
                                    }),
                                })
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use prost::Message;

    pub fn kv(k: &str, v: &str) -> pb::KeyValue {
        pb::KeyValue {
            key: k.into(),
            value: Some(pb::AnyValue {
                value: Some(Av::StringValue(v.into())),
            }),
        }
    }

    /// A protobuf logs request with one record from `service`.
    pub fn logs_request(service: &str, body: &str) -> Vec<u8> {
        pb::ExportLogsServiceRequest {
            resource_logs: vec![pb::ResourceLogs {
                resource: Some(pb::Resource {
                    attributes: vec![
                        kv("service.name", service),
                        kv("telemetry.sdk.name", "opentelemetry"),
                        kv("host.name", "vm-1"),
                    ],
                }),
                scope_logs: vec![pb::ScopeLogs {
                    scope: Some(pb::InstrumentationScope {
                        name: "app".into(),
                        version: String::new(),
                    }),
                    log_records: vec![pb::LogRecord {
                        time_unix_nano: 1_760_000_000_123_456_789,
                        severity_number: 17,
                        severity_text: "ERROR".into(),
                        body: Some(pb::AnyValue {
                            value: Some(Av::StringValue(body.into())),
                        }),
                        attributes: vec![kv("request_id", "req_1"), kv("http.route", "/orders")],
                        trace_id: vec![0xab; 16],
                        span_id: vec![0x01; 8],
                        ..Default::default()
                    }],
                }],
            }],
        }
        .encode_to_vec()
    }

    fn obj(l: &OtlpLine) -> Value {
        serde_json::from_str(&l.json).unwrap()
    }

    #[test]
    fn protobuf_log_record() {
        let lines = decode(
            Signal::Logs,
            &logs_request("payments-svc", "charge failed"),
            true,
            0,
        )
        .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].service.as_deref(), Some("payments-svc"));
        let v = obj(&lines[0]);
        assert_eq!(v["msg"], "charge failed");
        assert_eq!(v["level"], "error");
        assert_eq!(v["timestamp"], "2025-10-09T08:53:20.123456789Z");
        assert_eq!(v["trace_id"], "ab".repeat(16));
        assert_eq!(v["span_id"], "01".repeat(8));
        assert_eq!(v["request_id"], "req_1");
        assert_eq!(v["service"], "payments-svc");
        assert_eq!(v["scope"], "app");
        assert_eq!(v["resource"], serde_json::json!({ "host.name": "vm-1" }));
        assert!(decode(Signal::Logs, b"\xff\xff\xff", true, 0).is_err());
    }

    #[test]
    fn json_log_record_with_structured_and_json_bodies() {
        let body = serde_json::json!({
          "resourceLogs": [{
            "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "api" } }] },
            "scopeLogs": [{ "logRecords": [
              { "timeUnixNano": "1760000000000000000", "severityNumber": 9,
                "traceId": "5B8EFFF798038103D269B633813FC60C", "spanId": "EEE19B7EC3C1B174",
                "body": { "kvlistValue": { "values": [
                  { "key": "msg", "value": { "stringValue": "listed" } },
                  { "key": "count", "value": { "intValue": "3" } } ] } } },
              { "observedTimeUnixNano": 1760000001000000000u64, "severityText": "WARN",
                "body": { "stringValue": "{\"msg\":\"slow\",\"job_id\":\"j1\"}" } }
            ] }]
          }]
        });
        let lines = decode(Signal::Logs, body.to_string().as_bytes(), false, 0).unwrap();
        let a = obj(&lines[0]);
        assert_eq!(a["msg"], "listed");
        assert_eq!(a["count"], 3);
        assert_eq!(a["level"], "info");
        assert_eq!(a["trace_id"], "5b8efff798038103d269b633813fc60c");
        let b = obj(&lines[1]);
        assert_eq!(b["msg"], "slow");
        assert_eq!(b["job_id"], "j1");
        assert_eq!(b["level"], "WARN");
        assert_eq!(b["timestamp"], "2025-10-09T08:53:21Z");
        assert!(decode(Signal::Logs, b"{not json", false, 0).is_err());
    }

    #[test]
    fn spans_become_lines_with_parent_and_events() {
        let req = pb::ExportTraceServiceRequest {
            resource_spans: vec![pb::ResourceSpans {
                resource: Some(pb::Resource {
                    attributes: vec![kv("service.name", "api")],
                }),
                scope_spans: vec![pb::ScopeSpans {
                    scope: None,
                    spans: vec![pb::Span {
                        trace_id: vec![0x11; 16],
                        span_id: vec![0x22; 8],
                        parent_span_id: vec![0x33; 8],
                        name: "SELECT orders".into(),
                        kind: 3,
                        start_time_unix_nano: 1_760_000_000_000_000_000,
                        end_time_unix_nano: 1_760_000_000_012_500_000,
                        attributes: vec![kv("db.system", "postgresql")],
                        events: vec![pb::SpanEvent {
                            time_unix_nano: 1_760_000_000_010_000_000,
                            name: "exception".into(),
                            attributes: vec![kv("exception.message", "timeout")],
                        }],
                        status: Some(pb::Status {
                            message: "timeout".into(),
                            code: 2,
                        }),
                    }],
                }],
            }],
        };
        let lines = decode(Signal::Traces, &req.encode_to_vec(), true, 0).unwrap();
        let v = obj(&lines[0]);
        assert_eq!(v["otel.type"], "span");
        assert_eq!(v["name"], "SELECT orders");
        assert_eq!(v["span.kind"], "client");
        assert_eq!(v["duration_ms"], 12.5);
        assert_eq!(v["level"], "error");
        assert_eq!(v["parent_span_id"], "33".repeat(8));
        assert_eq!(v["otel.status_code"], "ERROR");
        assert_eq!(v["steps"][0]["at_ms"], 10);
        assert_eq!(v["steps"][0]["error"], "timeout");
        assert_eq!(v["timestamp"], "2025-10-09T08:53:20.012500Z");

        let j = serde_json::json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [
            { "traceId": "11111111111111111111111111111111", "spanId": "2222222222222222",
              "name": "GET /orders", "kind": "SPAN_KIND_SERVER",
              "startTimeUnixNano": "1760000000000000000", "endTimeUnixNano": "1760000000040000000",
              "status": { "code": 1 } } ] }] }] });
        let lines = decode(Signal::Traces, j.to_string().as_bytes(), false, 0).unwrap();
        let v = obj(&lines[0]);
        assert_eq!(v["span.kind"], "server");
        assert_eq!(v["duration_ms"], 40.0);
        assert!(v.get("parent_span_id").is_none());
        assert_eq!(lines[0].service, None);
    }
}
