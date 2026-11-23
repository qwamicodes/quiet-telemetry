use crate::{bounded_projection, error_json, finish, Completion, Config, Event, SharedEvent};
use axum::{
    body::{Body, Bytes},
    extract::{MatchedPath, Request, State},
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::Response,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};
use uuid::Uuid;

/// Explicit projections made from already-parsed data. Never a raw body reader.
#[derive(Clone, Default)]
pub struct Projections {
    pub request_body: Option<Value>,
    pub response_body: Option<Value>,
    pub query: Option<Event>,
    pub params: Option<Event>,
}

#[derive(Clone, Default)]
pub struct Capture {
    pub request_body_fields: Option<Vec<String>>,
    pub response_body_fields: Option<Vec<String>>,
    pub query_fields: Vec<String>,
    pub param_fields: Vec<String>,
}

pub type PathProjection = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct HttpConfig {
    pub logging: Arc<Config>,
    /// Enable only with an independently enforced trusted-upstream boundary.
    pub trust_request_id: bool,
    pub request_headers: Vec<String>,
    pub response_headers: Vec<String>,
    /// Exact matched route templates, not arbitrary user paths.
    pub capture: HashMap<String, Capture>,
    /// Return None for a path that cannot be safely represented.
    pub path: PathProjection,
}

impl HttpConfig {
    pub fn new(logging: Arc<Config>) -> Self {
        Self {
            logging,
            trust_request_id: false,
            request_headers: vec!["content-type".into()],
            response_headers: vec!["content-type".into()],
            capture: HashMap::new(),
            path: Arc::new(|path| Some(path.into())),
        }
    }
}

pub fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            let mime = v
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            mime == "application/json"
                || (mime.starts_with("application/") && mime.ends_with("+json"))
        })
}

fn headers(source: &HeaderMap, allow: &[String]) -> Event {
    allow
        .iter()
        .take(64)
        .filter_map(|name| {
            let header_name = axum::http::header::HeaderName::from_bytes(name.as_bytes()).ok()?;
            let values: Vec<_> = source
                .get_all(header_name)
                .iter()
                .take(64)
                .filter_map(|v| {
                    v.to_str().ok().map(|s| {
                        if s.len() > 4096 {
                            json!("[OMITTED: text limit]")
                        } else {
                            json!(s)
                        }
                    })
                })
                .collect();
            match values.len() {
                0 => None,
                1 => Some((name.to_ascii_lowercase(), values[0].clone())),
                _ => Some((name.to_ascii_lowercase(), Value::Array(values))),
            }
        })
        .collect()
}

/// Only copies selected fields, with bounded traversal at finalization.
fn project_field(key: &str, value: &Value) -> (Value, bool) {
    if matches!(crate::normalized_key(key).as_str(), "code" | "state") {
        return (crate::mask(value), false);
    }
    bounded_projection(value)
}

fn project(source: Option<&Value>, fields: &[String]) -> Option<(Value, bool)> {
    let source = source?.as_object()?;
    let mut truncated = fields.len() > 64;
    let value = fields
        .iter()
        .take(64)
        .filter(|key| key.len() <= 128)
        .filter_map(|key| {
            source.get(key).map(|value| {
                let (value, shortened) = project_field(key, value);
                truncated |= shortened;
                (key.clone(), value)
            })
        })
        .collect();
    Some((Value::Object(value), truncated))
}

fn projections(event: &mut Event, projected: &Projections, capture: &Capture) {
    let request = event
        .get_mut("request")
        .and_then(Value::as_object_mut)
        .unwrap();
    for (key, source, fields) in [
        ("query", &projected.query, &capture.query_fields),
        ("params", &projected.params, &capture.param_fields),
    ] {
        if let Some(source) = source {
            let selected: Event = fields
                .iter()
                .take(64)
                .filter(|key| key.len() <= 128)
                .filter_map(|key| {
                    source
                        .get(key)
                        .map(|value| (key.clone(), project_field(key, value).0))
                })
                .collect();
            if !selected.is_empty() {
                request.insert(key.into(), Value::Object(selected));
            }
        }
    }
    for (side, source, fields) in [
        (
            "request",
            projected.request_body.as_ref(),
            &capture.request_body_fields,
        ),
        (
            "response",
            projected.response_body.as_ref(),
            &capture.response_body_fields,
        ),
    ] {
        let group = event.get_mut(side).and_then(Value::as_object_mut).unwrap();
        match fields {
            None => {
                group.insert("body_capture".into(), json!("disabled"));
            }
            Some(fields) => {
                // Missing projection with capture enabled is unknown/skipped, not disabled.
                if let Some((body, truncated)) = project(source, fields) {
                    group.insert("body".into(), body);
                    if truncated {
                        group.insert("body_capture".into(), json!("truncated"));
                    }
                }
            }
        }
    }
}

struct Terminal {
    event: SharedEvent,
    owned: Event,
    config: Arc<Config>,
    started: Instant,
    status: Option<u16>,
    done: bool,
}

impl Terminal {
    fn finish(&mut self, boundary: &str) {
        if self.done {
            return;
        }
        self.done = true;
        let mut event = std::mem::take(&mut *self.event.lock().unwrap_or_else(|e| e.into_inner()));
        // Handler writes cannot replace adapter-owned metadata.
        for key in [
            "timestamp",
            "level",
            "service",
            "env",
            "request_id",
            "method",
            "path",
            "status_code",
            "duration_ms",
            "request",
            "response",
        ] {
            event.remove(key);
        }
        event.extend(std::mem::take(&mut self.owned));
        let complete = boundary == "complete";
        if !complete {
            event.entry("error").or_insert_with(|| json!({
                "name": if boundary == "body_error" { "ResponseBodyError" } else if std::thread::panicking() { "HandlerPanic" } else { "LocalWorkInterrupted" },
                "message": "Response completion not observed at the local body boundary",
                "reason": boundary
            }));
        }
        let successful = complete
            && self.status.is_some_and(|s| (200..400).contains(&s))
            && !event.contains_key("error");
        finish(
            event,
            self.started.elapsed(),
            Completion {
                successful,
                confirmed_retry_completion: false,
                context_available: true,
            },
            &self.config,
        );
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.finish("dropped");
    }
}

/// Apply last (outermost), after status/error mapping middleware and all routes.
pub async fn wide_event_middleware(
    State(config): State<Arc<HttpConfig>>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let incoming = request.headers().get_all("x-request-id");
    let request_id = if config.trust_request_id && incoming.iter().count() == 1 {
        incoming
            .iter()
            .next()
            .and_then(|h| h.to_str().ok())
            .filter(|id| valid_request_id(id))
            .map(str::to_owned)
    } else {
        None
    }
    .unwrap_or_else(|| Uuid::new_v4().to_string());
    let event: SharedEvent = Arc::new(Mutex::new(config.logging.deployment.clone()));
    let mut owned = Event::from_iter([
        ("request_id".into(), json!(request_id)),
        ("method".into(), json!(request.method().as_str())),
        (
            "request".into(),
            json!({"headers": headers(request.headers(), &config.request_headers)}),
        ),
        ("response".into(), json!({})),
    ]);
    // Never send query/fragment to the path policy.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (config.path)(request.uri().path())
    })) {
        Ok(Some(path)) => {
            owned.insert(
                "path".into(),
                json!(path.split(['?', '#']).next().unwrap_or_default()),
            );
        }
        Ok(None) => {}
        Err(_) => config.logging.failure(),
    }
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned());
    if let Some(route) = &route {
        owned["request"]["route"] = json!(route);
    }
    let capture = route
        .as_ref()
        .and_then(|r| config.capture.get(r))
        .cloned()
        .unwrap_or_default();
    let request_json = json_content_type(request.headers());
    projections(&mut owned, &Projections::default(), &capture);
    {
        let mut context = event.lock().unwrap_or_else(|e| e.into_inner());
        context.extend(owned.clone());
        context.insert("service".into(), json!(config.logging.service));
        context.insert("env".into(), json!(config.logging.env));
    }
    // Projection storage is independent from the direct business-event map.
    let projected: Arc<Mutex<Projections>> = Arc::new(Mutex::new(Projections::default()));
    request.extensions_mut().insert(event.clone());
    request.extensions_mut().insert(projected.clone());
    let mut terminal = Terminal {
        event,
        owned,
        config: config.logging.clone(),
        started,
        status: None,
        done: false,
    };
    let mut response = next.run(request).await;
    terminal.status = Some(response.status().as_u16());
    terminal
        .owned
        .insert("status_code".into(), json!(response.status().as_u16()));
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&request_id).expect("validated or generated id"),
    );
    terminal.owned["response"]["headers"] =
        Value::Object(headers(response.headers(), &config.response_headers));
    let mut projected = projected.lock().unwrap_or_else(|e| e.into_inner());
    let upgrade = terminal.status == Some(101)
        || (terminal.owned["method"] == "CONNECT"
            && terminal.status.is_some_and(|s| (200..300).contains(&s)));
    let no_entity =
        terminal.owned["method"] == "HEAD" || matches!(terminal.status, Some(204 | 304));
    let response_json = !upgrade
        && !no_entity
        && json_content_type(response.headers())
        && response.body().size_hint().exact().is_some();
    if !request_json {
        projected.request_body = None;
    }
    if !response_json {
        projected.response_body = None;
    }
    if let Some(safe_response) = response
        .extensions()
        .get::<Projections>()
        .filter(|_| response_json)
    {
        // Take an already-bounded subset rather than cloning an unbounded response value.
        projected.response_body = project(
            safe_response.response_body.as_ref(),
            capture.response_body_fields.as_deref().unwrap_or_default(),
        )
        .map(|(value, truncated)| {
            if truncated {
                terminal.owned["response"]["body_capture"] = json!("truncated");
            }
            value
        });
    }
    projections(&mut terminal.owned, &projected, &capture);
    drop(projected);
    let (parts, body) = response.into_parts();
    // Hyper may skip polling known-empty bodies (HEAD, 204, empty Full).
    if upgrade {
        terminal.finish("unsupported_upgrade");
    } else if no_entity || body.is_end_stream() {
        terminal.finish("complete");
    }
    Response::from_parts(
        parts,
        Body::new(CompletionBody {
            inner: body,
            terminal,
        }),
    )
}

struct CompletionBody {
    inner: Body,
    terminal: Terminal,
}

impl HttpBody for CompletionBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = self.get_mut();
        let frame = Pin::new(&mut this.inner).poll_frame(cx);
        match &frame {
            Poll::Ready(Some(Err(error))) => {
                this.terminal
                    .event
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .entry("error")
                    .or_insert_with(|| error_json(error, Event::new()));
                this.terminal.finish("body_error");
            }
            Poll::Ready(None) => this.terminal.finish("complete"),
            Poll::Ready(Some(Ok(_))) if this.inner.is_end_stream() => {
                this.terminal.finish("complete")
            }
            _ => {}
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
