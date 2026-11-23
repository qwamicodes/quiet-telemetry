//! Adapted from Boris Tane's wideEventMiddleware / shouldSample (loggingsucks.com)
//! and logging-best-practices (MIT). Queue hooks are our adaptation, not his code.
pub mod http;
pub mod worker;

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    io::{self, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub type Event = Map<String, Value>;
pub type SharedEvent = Arc<Mutex<Event>>;
pub type Predicate = Arc<dyn Fn(&Event) -> bool + Send + Sync>;
pub type TextPolicy = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type JsonSink = Arc<dyn Fn(&str) -> io::Result<()> + Send + Sync>;
pub type Measurement = Arc<dyn Fn(&Event, Completion) + Send + Sync>;

/// Facts at this adapter's boundary, never a claim about client receipt or broker ack.
#[derive(Clone, Copy, Debug, Default)]
pub struct Completion {
    pub successful: bool,
    pub confirmed_retry_completion: bool,
    /// False if sanitization failed; count this measurement as unclassified coverage.
    pub context_available: bool,
}

#[derive(Clone)]
pub struct Config {
    pub service: String,
    pub env: String,
    pub deployment: Event,
    pub sample_rate: f64,
    pub slow_ms: Option<f64>,
    pub slow: Option<Predicate>,
    pub slo_failure: Option<Predicate>,
    pub retain: Option<Predicate>,
    pub measure: Measurement,
    pub sink: JsonSink,
    /// Inspect this counter independently; never send raw failed events to a fallback.
    pub logging_failures: Arc<AtomicU64>,
    pub sensitive_fields: HashSet<String>,
    /// Applied to every non-redacted string (including errors); None omits its value.
    pub text_policy: Option<TextPolicy>,
    pub body_limit: usize,
    pub event_limit: usize,
}

impl Config {
    pub fn new(service: &str, env: &str, sink: JsonSink) -> Self {
        Self {
            service: service.into(),
            env: env.into(),
            deployment: Event::new(),
            sample_rate: 1.0,
            slow_ms: None,
            slow: None,
            slo_failure: None,
            retain: None,
            measure: Arc::new(|_, _| {}),
            sink,
            logging_failures: Arc::new(AtomicU64::new(0)),
            sensitive_fields: HashSet::new(),
            text_policy: None,
            body_limit: 8192,
            event_limit: 32768,
        }
    }

    /// Call at startup before sharing immutable configuration with the adapters.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.sample_rate.is_finite() || !(0.0..=1.0).contains(&self.sample_rate) {
            return Err("sample_rate must be finite and between zero and one");
        }
        if self.slow_ms.is_some_and(|n| !n.is_finite() || n < 0.0) {
            return Err("slow_ms must be finite and nonnegative");
        }
        if self.body_limit < 64 || self.event_limit < 512 {
            return Err("body_limit must be >=64 and event_limit >=512 bytes");
        }
        if self
            .deployment
            .keys()
            .any(|key| CORE.contains(&key.as_str()))
        {
            return Err("deployment metadata cannot overwrite canonical fields");
        }
        Ok(())
    }

    pub(crate) fn failure(&self) {
        self.logging_failures.fetch_add(1, Ordering::Relaxed);
    }
}

/// One JSON-lines sink created at startup. An application's existing sink can replace it.
pub fn stdout_json_sink() -> JsonSink {
    Arc::new(|line| {
        let mut out = io::stdout().lock();
        writeln!(out, "{line}")
    })
}

/// Rust errors expose Display plus source, not reflective custom fields. The adapter
/// explicitly supplies native fields; no Debug/repr fallback is ever emitted.
pub fn error_json<E: std::error::Error>(error: &E, mut fields: Event) -> Value {
    fields
        .entry("name")
        .or_insert_with(|| json!(std::any::type_name::<E>()));
    fields.entry("message").or_insert_with(|| {
        let message = catch_unwind(AssertUnwindSafe(|| error.to_string()))
            .unwrap_or_else(|_| "Error message unavailable".into());
        json!(message)
    });
    Value::Object(fields)
}

pub(crate) fn bounded_projection(source: &Value) -> (Value, bool) {
    // Bound copying before the final shared redaction/text policy, without invoking callbacks.
    bounded_value(source, true)
}

pub(crate) fn bounded_value(source: &Value, oauth: bool) -> (Value, bool) {
    let mut config = Config::new("", "", Arc::new(|_| Ok(())));
    if oauth {
        config
            .sensitive_fields
            .extend(["code".into(), "state".into()]);
    }
    let mut truncated = false;
    let value = sanitize(source, &config, 0, &mut 2048, &mut truncated);
    (value, truncated)
}

pub(crate) fn bounded_error(source: &Value) -> Value {
    sanitize_error(source, &Config::new("", "", Arc::new(|_| Ok(()))))
}

pub fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

fn sensitive(key: &str, config: &Config) -> bool {
    let key = normalized_key(key);
    matches!(
        key.as_str(),
        "auth"
            | "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "pwd"
            | "token"
            | "apikey"
            | "xapikey"
            | "secret"
            | "credentials"
            | "credential"
            | "privatekey"
            | "connectionstring"
            | "oauthcode"
            | "oauthstate"
            | "paymentcredentials"
            | "cardnumber"
            | "cvv"
            | "cvc"
    ) || ["token", "password", "secret", "apikey"]
        .iter()
        .any(|suffix| key.ends_with(suffix))
        || config
            .sensitive_fields
            .iter()
            .any(|name| normalized_key(name) == key)
}

fn url_key(key: &str) -> bool {
    let key = normalized_key(key);
    key.ends_with("url") || key.ends_with("uri") || key == "location"
}

fn mask(value: &Value) -> Value {
    // Header/query multi-values keep their string-or-array shape, with bounded expansion.
    if let Value::Array(values) = value {
        Value::Array(
            values
                .iter()
                .take(64)
                .map(|_| json!("[REDACTED]"))
                .collect(),
        )
    } else {
        json!("[REDACTED]")
    }
}

/// JSON values cannot contain cycles. Visit a bounded subset without cloning whole trees.
fn sanitize(
    value: &Value,
    config: &Config,
    depth: usize,
    budget: &mut usize,
    truncated: &mut bool,
) -> Value {
    if depth > 16 || *budget == 0 {
        *truncated = true;
        return json!("[OMITTED: expansion limit]");
    }
    *budget -= 1;
    match value {
        Value::Object(map) => {
            *truncated |= map.len() > 64;
            Value::Object(
                map.iter()
                    .take(64)
                    .filter_map(|(key, value)| {
                        if key.len() > 128 {
                            *truncated = true;
                            return None;
                        }
                        let result = if sensitive(key, config) {
                            mask(value)
                        } else if url_key(key) {
                            // A raw URL can contain secrets in userinfo, path, query or fragment.
                            json!("[REDACTED]")
                        } else {
                            sanitize(value, config, depth + 1, budget, truncated)
                        };
                        // Oversized/dynamic keys themselves are not safe payloads.
                        Some((key.clone(), result))
                    })
                    .collect(),
            )
        }
        Value::Array(values) => {
            *truncated |= values.len() > 64;
            Value::Array(
                values
                    .iter()
                    .take(64)
                    .map(|v| sanitize(v, config, depth + 1, budget, truncated))
                    .collect(),
            )
        }
        Value::String(text) => {
            if text == "[REDACTED]"
                || matches!(
                    text.as_str(),
                    "[OMITTED: expansion limit]"
                        | "[OMITTED: structured text]"
                        | "[OMITTED: text limit]"
                )
            {
                return json!(text);
            }
            if text.len() > 4096 {
                *truncated = true;
                return json!("[OMITTED: text limit]");
            }
            let bounded = short_string(text, 4096);
            let trimmed = bounded.trim_start();
            if trimmed.starts_with('{')
                || trimmed.starts_with('[')
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                // No unbounded parsing, nor encoded-JSON/URL bypass of key redaction.
                return json!("[OMITTED: structured text]");
            }
            let safe = match &config.text_policy {
                Some(policy) => policy(&bounded).unwrap_or_else(|| "[REDACTED]".into()),
                None => bounded,
            };
            json!(short_string(&safe, 4096))
        }
        _ => value.clone(),
    }
}

fn short_string(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut boundary = limit.saturating_sub(3);
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}…", &text[..boundary])
}

fn bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |v| v.len())
}

/// Shorten JSON values, never serialized byte slices; leave redaction markers intact.
fn shrink(value: &mut Value) -> bool {
    match value {
        Value::String(text) if text != "[REDACTED]" && text.len() > 24 => {
            *text = short_string(text, (text.len() / 2).max(24));
            true
        }
        Value::Object(map) => {
            if let Some(value) = map.values_mut().max_by_key(|v| bytes(v)) {
                if shrink(value) {
                    return true;
                }
            }
            if let Some(key) = map.keys().next_back().cloned() {
                map.remove(&key);
                return true;
            }
            false
        }
        Value::Array(values) => {
            if let Some(value) = values.iter_mut().max_by_key(|v| bytes(v)) {
                if shrink(value) {
                    return true;
                }
            }
            values.pop().is_some()
        }
        _ => false,
    }
}

fn bound_body(side: &mut Value, limit: usize) {
    let Some(group) = side.as_object_mut() else {
        return;
    };
    let Some(body) = group.get_mut("body") else {
        return;
    };
    let mut shortened = false;
    while bytes(body) > limit {
        shortened = true;
        if !shrink(body) {
            *body = Value::Null;
            break;
        }
    }
    if shortened {
        group.insert("body_capture".into(), json!("truncated"));
    }
}

const CORE: &[&str] = &[
    "timestamp",
    "level",
    "service",
    "env",
    "request_id",
    "flow",
    "method",
    "path",
    "status_code",
    "duration_ms",
    "request",
    "response",
    "error",
    "job_id",
    "attempt",
];

/// Safe snapshot before any callback/sink; minimal core must fit or emission is rejected.
pub fn sanitized_event(event: &Event, config: &Config) -> Option<Event> {
    // Process core first so optional expansion cannot crowd it out.
    let mut result = Event::new();
    let mut budget = 2048;
    for key in CORE.iter().copied().chain(
        event
            .keys()
            .map(String::as_str)
            .filter(|k| !CORE.contains(k))
            .take(64),
    ) {
        if key.len() > 128 {
            continue;
        }
        if let Some(value) = event.get(key) {
            let mut core_budget = 2048;
            let field_budget = if CORE.contains(&key) {
                &mut core_budget
            } else {
                &mut budget
            };
            let safe = if sensitive(key, config) || url_key(key) {
                mask(value)
            } else if matches!(key, "request" | "response") {
                sanitize_http_group(value, config)
            } else if key == "error" {
                sanitize_error(value, config)
            } else {
                sanitize(value, config, 0, field_budget, &mut false)
            };
            result.insert(key.into(), safe);
        }
    }
    bound_event(result, config)
}

fn sanitize_error(source: &Value, config: &Config) -> Value {
    let Some(fields) = source.as_object() else {
        return sanitize(source, config, 0, &mut 2048, &mut false);
    };
    // Custom-field expansion must not displace the native error's identifying fields.
    const STANDARD: &[&str] = &["message", "code", "name"];
    let mut result = Event::new();
    let mut budget = 2048;
    for key in STANDARD.iter().copied().chain(
        fields
            .keys()
            .map(String::as_str)
            .filter(|key| !STANDARD.contains(key))
            .take(61),
    ) {
        if key.len() > 128 {
            continue;
        }
        if let Some(value) = fields.get(key) {
            let mut reserved = 128;
            let field_budget = if STANDARD.contains(&key) {
                &mut reserved
            } else {
                &mut budget
            };
            result.insert(
                key.into(),
                if sensitive(key, config) || url_key(key) {
                    mask(value)
                } else {
                    sanitize(value, config, 0, field_budget, &mut false)
                },
            );
        }
    }
    Value::Object(result)
}

fn sanitize_http_group(source: &Value, config: &Config) -> Value {
    let Some(group) = source.as_object() else {
        return Value::Null;
    };
    let mut result = Event::new();
    let mut budget = 2048;
    for (key, value) in group
        .iter()
        .filter(|(key, _)| key.as_str() != "body")
        .take(64)
    {
        if key.len() <= 128 {
            result.insert(
                key.clone(),
                if sensitive(key, config) {
                    mask(value)
                } else {
                    sanitize(value, config, 0, &mut budget, &mut false)
                },
            );
        }
    }
    if let Some(body) = group.get("body") {
        let mut truncated = false;
        result.insert(
            "body".into(),
            sanitize(body, config, 0, &mut 2048, &mut truncated),
        );
        if truncated {
            result.insert("body_capture".into(), json!("truncated"));
        }
    }
    Value::Object(result)
}

fn bound_event(mut result: Event, config: &Config) -> Option<Event> {
    for side in ["request", "response"] {
        if let Some(value) = result.get_mut(side) {
            bound_body(value, config.body_limit);
        }
    }
    let mut value = Value::Object(result);
    if bytes(&value) <= config.event_limit {
        return value.as_object().cloned();
    }
    let map = value.as_object_mut()?;
    for side in ["request", "response"] {
        if let Some(group) = map.get_mut(side).and_then(Value::as_object_mut) {
            if group.remove("body").is_some() {
                group.insert("body_capture".into(), json!("truncated"));
            }
        }
    }
    if bytes(&value) <= config.event_limit {
        return value.as_object().cloned();
    }
    let map = value.as_object_mut()?;
    let optional: Vec<_> = map
        .keys()
        .filter(|k| !CORE.contains(&k.as_str()))
        .cloned()
        .collect();
    for key in optional {
        map.remove(&key);
    }
    for side in ["request", "response"] {
        if let Some(group) = map.get_mut(side).and_then(Value::as_object_mut) {
            group.retain(|key, _| matches!(key.as_str(), "body_capture" | "route"));
        }
    }
    // Keep structured core error information; large details/stack are expendable.
    if let Some(Value::Object(error)) = map.get_mut("error") {
        error.retain(|key, _| matches!(key.as_str(), "name" | "code" | "message"));
    }
    (bytes(&value) <= config.event_limit).then(|| value.as_object().unwrap().clone())
}

fn predicate(callback: &Option<Predicate>, event: &Event, config: &Config) -> bool {
    callback.as_ref().is_some_and(|callback| {
        catch_unwind(AssertUnwindSafe(|| callback(event))).unwrap_or_else(|_| {
            config.failure();
            // Retain on policy failure without inventing an SLO classification.
            true
        })
    })
}

fn is_slow(event: &Event, config: &Config) -> bool {
    config.slow_ms.is_some_and(|threshold| {
        event
            .get("duration_ms")
            .and_then(Value::as_f64)
            .is_some_and(|ms| ms >= threshold)
    }) || predicate(&config.slow, event, config)
}

fn measure(event: &Event, completion: Completion, config: &Config) {
    if catch_unwind(AssertUnwindSafe(|| (config.measure)(event, completion))).is_err() {
        config.failure();
    }
}

/// Tail-sampling, with a supplied uniform draw in [0,1) for deterministic fixtures.
pub fn should_sample(event: &Event, completion: Completion, config: &Config, draw: f64) -> bool {
    event.contains_key("error")
        || event
            .get("status_code")
            .and_then(Value::as_u64)
            .is_some_and(|s| s >= 400)
        || (completion.successful && is_slow(event, config))
        || completion.confirmed_retry_completion
        || predicate(&config.slo_failure, event, config)
        || predicate(&config.retain, event, config)
        || draw < config.sample_rate
}

pub(crate) fn finish(mut event: Event, elapsed: Duration, completion: Completion, config: &Config) {
    // User callbacks, serializers and sinks never unwind through application code.
    if catch_unwind(AssertUnwindSafe(|| {
        for (key, value) in &config.deployment {
            event.entry(key.clone()).or_insert_with(|| value.clone());
        }
        event.insert(
            "timestamp".into(),
            json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        );
        event.insert("duration_ms".into(), json!(elapsed.as_secs_f64() * 1000.0));
        event.insert("service".into(), json!(config.service));
        event.insert("env".into(), json!(config.env));
        let has_error = event.contains_key("error")
            || event
                .get("status_code")
                .and_then(Value::as_u64)
                .is_some_and(|s| s >= 400);
        if let Some(Value::String(message)) = event.get("error") {
            event.insert("error".into(), json!({"message": message}));
        }
        // Sanitize without event-budget pruning so policy/measurements see the bounded context.
        let mut callback_config = config.clone();
        callback_config.event_limit = usize::MAX;
        let invalid_core = ["request_id", "job_id", "flow"].iter().any(|key| {
            event
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|s| s.len() > 4096)
        });
        let mut event = match catch_unwind(AssertUnwindSafe(|| {
            sanitized_event(&event, &callback_config)
        })) {
            Ok(Some(event)) => event,
            _ => {
                config.failure();
                // Still observe the unit, but expose only fixed/typed facts on redaction failure.
                let mut minimal = Event::from_iter([(
                    "duration_ms".into(),
                    json!(elapsed.as_secs_f64() * 1000.0),
                )]);
                if let Some(status) = event.get("status_code").and_then(Value::as_u64) {
                    minimal.insert("status_code".into(), json!(status));
                }
                if has_error {
                    minimal.insert("error".into(), json!({"message": "Details unavailable"}));
                }
                measure(
                    &minimal,
                    Completion {
                        context_available: false,
                        ..completion
                    },
                    config,
                );
                return;
            }
        };
        let slow = completion.successful && is_slow(&event, config);
        event.insert(
            "level".into(),
            json!(if has_error {
                "error"
            } else if slow {
                "warn"
            } else {
                "info"
            }),
        );
        measure(&event, completion, config);
        if invalid_core {
            config.failure();
            return;
        }
        if should_sample(&event, completion, config, rand::random()) {
            match bound_event(event, config).and_then(|e| serde_json::to_string(&e).ok()) {
                Some(line) => {
                    if (config.sink)(&line).is_err() {
                        config.failure();
                    }
                }
                None => config.failure(),
            }
        }
    }))
    .is_err()
    {
        config.failure();
    }
}
