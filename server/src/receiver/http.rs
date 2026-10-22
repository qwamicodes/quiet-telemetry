//! HTTP ingest: everything that pushes lines to quiet.
//!
//! | Endpoint                 | Who sends it                                         | Source kind |
//! |--------------------------|------------------------------------------------------|-------------|
//! | `POST /ingest/ndjson`    | curl, `quiet pipe`, anything: JSON or text per row   | `http`      |
//! | `POST /ingest/vector`    | Vector `http` sink, `encoding.codec = "json"`        | `vector`    |
//! | `POST /ingest/fluentbit` | Fluent Bit `http` output, `json_lines`/`json`        | `fluentbit` |
//! | `POST /v1/logs`          | OTLP/HTTP logs, protobuf or JSON                     | `otlp`      |
//! | `POST /v1/traces`        | OTLP/HTTP traces (spans become lines)                | `otlp`      |
//!
//! Every request needs `Authorization: Bearer qi_…` (an ingest token, see
//! `tokens.rs`) unless the server runs with `--ingest-auth open`; a token that
//! is sent is always checked. Bodies may be gzip (or deflate) encoded.
//!
//! Failures say what went wrong: 401 (missing/unknown/revoked token), 413
//! (body over `--ingest-max-body`, compressed or not), 429 + `Retry-After`
//! (over the token's `--ingest-rate` lines/s), 400 (not OTLP), 415 (unknown
//! `Content-Encoding`), 503 (store down). Rejected requests are logged, their
//! bodies are not.

use super::otlp::{self, Signal};
use super::shippers::{self, Naming, Shipper};
use super::Receiver;
use crate::hub::SourceKind;
use crate::pipeline::{Pipeline, RawLine};
use crate::tokens::{IngestTokens, RateLimit, TokenEntry};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;
use ts_rs::TS;

/// Whether ingest needs a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum IngestAuth {
    /// Every request needs a `qi_` token (the default).
    Token,
    /// Requests without a token are accepted (local development). A token
    /// that is sent is still checked.
    Open,
}

/// How HTTP ingest is gated and limited.
#[derive(Debug, Clone, Copy)]
pub struct IngestConfig {
    pub auth: IngestAuth,
    /// Largest body accepted, after decompression, bytes.
    pub max_body: u64,
    /// Lines per second per token (0 = unlimited); bursts of 5 s worth.
    pub rate: u32,
    /// The server listens on loopback only (remote shippers can't reach it).
    pub loopback: bool,
}

impl Default for IngestConfig {
    fn default() -> Self {
        IngestConfig {
            auth: IngestAuth::Token,
            max_body: 16_000_000,
            rate: 20_000,
            loopback: true,
        }
    }
}

impl IngestConfig {
    pub fn info(&self, active_tokens: usize) -> IngestInfo {
        IngestInfo {
            auth: self.auth,
            loopback: self.loopback,
            max_body: self.max_body,
            rate: self.rate,
            tokens: active_tokens as u32,
        }
    }
}

/// HTTP ingest as `/api/health` reports it (the connect screens use it).
#[derive(Debug, Clone, Serialize, TS)]
pub struct IngestInfo {
    pub auth: IngestAuth,
    /// Listening on loopback only: shippers on other machines need `QUIET_ADDR=0.0.0.0:7070`.
    pub loopback: bool,
    /// Bytes, after decompression.
    pub max_body: u64,
    /// Lines per second per token (0 = unlimited).
    pub rate: u32,
    /// Ingest tokens that still work.
    pub tokens: u32,
}

struct Inner {
    pipeline: Arc<Pipeline>,
    tokens: Arc<IngestTokens>,
    config: IngestConfig,
    /// The budget for requests without a token (`--ingest-auth open`).
    open_limit: RateLimit,
}

pub struct HttpReceiver {
    inner: Arc<Inner>,
}

impl HttpReceiver {
    pub fn new(pipeline: Arc<Pipeline>, tokens: Arc<IngestTokens>, config: IngestConfig) -> Self {
        HttpReceiver {
            inner: Arc::new(Inner {
                pipeline,
                tokens,
                open_limit: RateLimit::new(config.rate, 5),
                config,
            }),
        }
    }
}

#[async_trait::async_trait]
impl Receiver for HttpReceiver {
    fn name(&self) -> &'static str {
        "http-ingest"
    }

    fn routes(&self) -> Router {
        Router::new()
            .route("/ingest/ndjson", post(ndjson))
            .route("/ingest/vector", post(vector))
            .route("/ingest/fluentbit", post(fluentbit))
            .route("/ingest/fluent-bit", post(fluentbit))
            .route("/v1/logs", post(otlp_logs))
            .route("/v1/traces", post(otlp_traces))
            // The body is read (and capped) by `read_body`, with a JSON 413.
            .layer(DefaultBodyLimit::disable())
            .with_state(self.inner.clone())
    }
}

#[derive(Clone, Copy)]
enum Format {
    Lines(Shipper),
    Otlp(Signal),
}

async fn ndjson(State(i): State<Arc<Inner>>, h: HeaderMap, b: Body) -> Response {
    handle(&i, SourceKind::Http, Format::Lines(Shipper::Ndjson), h, b).await
}
async fn vector(State(i): State<Arc<Inner>>, h: HeaderMap, b: Body) -> Response {
    handle(&i, SourceKind::Vector, Format::Lines(Shipper::Vector), h, b).await
}
async fn fluentbit(State(i): State<Arc<Inner>>, h: HeaderMap, b: Body) -> Response {
    handle(
        &i,
        SourceKind::Fluentbit,
        Format::Lines(Shipper::FluentBit),
        h,
        b,
    )
    .await
}
async fn otlp_logs(State(i): State<Arc<Inner>>, h: HeaderMap, b: Body) -> Response {
    handle(&i, SourceKind::Otlp, Format::Otlp(Signal::Logs), h, b).await
}
async fn otlp_traces(State(i): State<Arc<Inner>>, h: HeaderMap, b: Body) -> Response {
    handle(&i, SourceKind::Otlp, Format::Otlp(Signal::Traces), h, b).await
}

/// A rejected request: status + a message the shipper's log will show.
struct Reject(StatusCode, String);

impl IntoResponse for Reject {
    fn into_response(self) -> Response {
        let mut res = (self.0, Json(json!({ "error": self.1 }))).into_response();
        if self.0 == StatusCode::UNAUTHORIZED {
            res.headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        res
    }
}

fn header_str<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn default_name(kind: SourceKind) -> &'static str {
    match kind {
        SourceKind::Fluentbit => "fluent-bit",
        other => other.as_str(),
    }
}

async fn handle(i: &Inner, kind: SourceKind, format: Format, h: HeaderMap, body: Body) -> Response {
    let endpoint = match format {
        Format::Lines(Shipper::Ndjson) => "ndjson",
        Format::Lines(Shipper::Vector) => "vector",
        Format::Lines(Shipper::FluentBit) => "fluentbit",
        Format::Otlp(Signal::Logs) => "otlp-logs",
        Format::Otlp(Signal::Traces) => "otlp-traces",
    };
    let res = match ingest(i, kind, format, &h, body).await {
        Ok(res) => res,
        Err(Reject(status, msg)) => {
            tracing::warn!(endpoint, status = status.as_u16(), reason = %msg, "ingest rejected");
            record(i, endpoint, status, &msg, &h);
            return Reject(status, msg).into_response();
        }
    };
    if res.status() == StatusCode::TOO_MANY_REQUESTS {
        record(i, endpoint, res.status(), "over the ingest rate", &h);
    }
    res
}

/// Count a refused request for the system status and the source's Rejected
/// tab: endpoint, status, reason, the source it named and a token preview.
/// Never the body.
fn record(i: &Inner, endpoint: &str, status: StatusCode, reason: &str, h: &HeaderMap) {
    let source = header_str(h, "x-quiet-source").filter(|s| crate::tokens_api::valid_source(s));
    let token = header_str(h, "authorization").map(token_preview);
    i.pipeline.system().reject(
        chrono::Utc::now().timestamp_millis(),
        endpoint,
        status.as_u16(),
        reason,
        source,
        token,
    );
}

/// `Bearer qi_…1a77` → `qi_••••1a77` (enough to tell tokens apart).
fn token_preview(auth: &str) -> String {
    let t = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or(auth)
        .trim();
    let tail: String = t
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let head = if t.starts_with("qi_") { "qi_" } else { "" };
    format!("{head}••••{tail}")
}

async fn ingest(
    i: &Inner,
    kind: SourceKind,
    format: Format,
    h: &HeaderMap,
    body: Body,
) -> Result<Response, Reject> {
    let received = chrono::Utc::now().timestamp_millis();

    // 1. Who is sending.
    let auth = header_str(h, "authorization");
    let token: Option<Arc<TokenEntry>> = if auth.is_some() || i.config.auth == IngestAuth::Token {
        Some(
            i.tokens
                .check(auth, received)
                .map_err(|e| Reject(StatusCode::UNAUTHORIZED, e.message().into()))?,
        )
    } else {
        None
    };

    // 2. The body, capped before and after decompression.
    let bytes = read_body(h, body, i.config.max_body).await?;

    // 3. Lines with their sources.
    let header_source = header_str(h, "x-quiet-source")
        .filter(|s| crate::tokens_api::valid_source(s))
        .map(str::to_string);
    let fixed = token
        .as_ref()
        .and_then(|t| t.source.clone())
        .or(header_source);
    let raws: Vec<RawLine> = match format {
        Format::Lines(shipper) => {
            let naming = Naming {
                fixed,
                tag: (shipper == Shipper::FluentBit)
                    .then(|| header_str(h, "x-quiet-tag").or_else(|| header_str(h, "fluent-tag")))
                    .flatten()
                    .map(str::to_string),
                default: default_name(kind).into(),
            };
            shippers::parse(&String::from_utf8_lossy(&bytes), shipper, &naming, received)
        }
        Format::Otlp(signal) => {
            let protobuf = header_str(h, "content-type").is_some_and(|c| c.contains("protobuf"));
            otlp::decode(signal, &bytes, protobuf, received)
                .map_err(|e| Reject(StatusCode::BAD_REQUEST, e))?
                .into_iter()
                .map(|l| {
                    let source = fixed
                        .clone()
                        .or(l.service)
                        .unwrap_or_else(|| default_name(kind).into());
                    RawLine::new(l.json, source, received)
                })
                .collect()
        }
    };

    // 4. The token's line budget (all or nothing, so a retry resends the batch).
    let limit = token.as_ref().map_or(&i.open_limit, |t| &t.limit);
    if let Err(secs) = limit.take(raws.len()) {
        let mut res = Reject(
            StatusCode::TOO_MANY_REQUESTS,
            format!(
                "over the ingest rate ({} lines/s per token); retry in {secs}s",
                i.config.rate
            ),
        )
        .into_response();
        res.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        tracing::warn!(
            lines = raws.len(),
            retry_after = secs,
            "ingest rate limited"
        );
        return Ok(res);
    }

    // 5. Store + fan out.
    let mut sources: Vec<String> = Vec::new();
    for r in &raws {
        if !sources.contains(&r.source) {
            sources.push(r.source.clone());
        }
    }
    let accepted = match i.pipeline.ingest(kind, raws).await {
        Ok(lines) => lines.len(),
        Err(e) => {
            tracing::error!(error = %e, "ingest failed");
            return Err(Reject(
                StatusCode::SERVICE_UNAVAILABLE,
                "store unavailable".into(),
            ));
        }
    };
    Ok(match format {
        // OTLP clients expect 200 with an (empty) Export*ServiceResponse.
        Format::Otlp(_) => {
            if header_str(h, "content-type").is_some_and(|c| c.contains("protobuf")) {
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/x-protobuf")],
                    Bytes::new(),
                )
                    .into_response()
            } else {
                (StatusCode::OK, Json(json!({}))).into_response()
            }
        }
        Format::Lines(_) => (
            StatusCode::ACCEPTED,
            Json(json!({ "accepted": accepted, "sources": sources })),
        )
            .into_response(),
    })
}

fn too_large(max: u64) -> Reject {
    Reject(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("body over the ingest limit of {max} bytes; send smaller batches"),
    )
}

/// Read the body (at most `max` bytes), then undo `Content-Encoding`
/// (at most `max` bytes again, so a gzip bomb stops at the cap).
async fn read_body(h: &HeaderMap, body: Body, max: u64) -> Result<Bytes, Reject> {
    if header_str(h, "content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > max)
    {
        return Err(too_large(max));
    }
    let raw = axum::body::to_bytes(body, max as usize)
        .await
        .map_err(|_| too_large(max))?;
    let encoding = header_str(h, "content-encoding")
        .unwrap_or("identity")
        .to_ascii_lowercase();
    let gzip_magic = raw.starts_with(&[0x1f, 0x8b]);
    let decoder: Box<dyn Read> = match encoding.as_str() {
        "gzip" | "x-gzip" => Box::new(flate2::read::MultiGzDecoder::new(&raw[..])),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(&raw[..])),
        "identity" | "" if gzip_magic => Box::new(flate2::read::MultiGzDecoder::new(&raw[..])),
        "identity" | "" => return Ok(raw),
        other => {
            return Err(Reject(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                format!("unsupported Content-Encoding `{other}`; use gzip or none"),
            ))
        }
    };
    let mut out = Vec::new();
    decoder.take(max + 1).read_to_end(&mut out).map_err(|e| {
        Reject(
            StatusCode::BAD_REQUEST,
            format!("could not decompress the body: {e}"),
        )
    })?;
    if out.len() as u64 > max {
        return Err(too_large(max));
    }
    Ok(Bytes::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Hub;
    use crate::store::MemoryStore;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::io::Write;
    use tower::ServiceExt;

    struct T {
        app: Router,
        pipeline: Arc<Pipeline>,
        tokens: Arc<IngestTokens>,
    }

    fn setup(config: IngestConfig) -> T {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new());
        let tokens = Arc::new(IngestTokens::open(None, config.rate).unwrap());
        let app = HttpReceiver::new(pipeline.clone(), tokens.clone(), config).routes();
        T {
            app,
            pipeline,
            tokens,
        }
    }

    fn token(t: &T, source: Option<&str>) -> String {
        format!("Bearer {}", t.tokens.create("t", source, 0).unwrap().secret)
    }

    async fn send(t: &T, req: Request<Body>) -> (StatusCode, HeaderMap, Bytes) {
        let res = t.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        (
            parts.status,
            parts.headers,
            body.collect().await.unwrap().to_bytes(),
        )
    }

    async fn tail(t: &T, source: &str) -> Vec<String> {
        t.pipeline
            .store()
            .tail(source, 100)
            .await
            .unwrap()
            .iter()
            .map(|l| l.raw.clone())
            .collect()
    }

    fn gzip(b: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(b).unwrap();
        e.finish().unwrap()
    }

    #[tokio::test]
    async fn vector_ndjson_with_token() {
        let t = setup(IngestConfig::default());
        let auth = token(&t, None);
        let body = concat!(
            r#"{"container_name":"api","message":"{\"msg\":\"hi\",\"request_id\":\"r1\"}","source_type":"docker_logs","timestamp":"2026-10-22T14:07:12Z"}"#,
            "\n",
            r#"{"container_name":"worker","message":"plain","source_type":"docker_logs","timestamp":"2026-10-22T14:07:12Z"}"#,
        );
        let (s, _, b) = send(
            &t,
            Request::post("/ingest/vector")
                .header("authorization", &auth)
                .body(Body::from(body))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::ACCEPTED);
        let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["accepted"], 2);
        assert_eq!(v["sources"], json!(["api", "worker"]));
        assert_eq!(
            tail(&t, "api").await,
            vec![r#"{"msg":"hi","request_id":"r1"}"#]
        );
        assert_eq!(
            t.pipeline.hub().source("api").unwrap().kind(),
            SourceKind::Vector
        );
        assert!(t.tokens.list().unwrap()[0].last_used.is_some());
    }

    #[tokio::test]
    async fn fluent_bit_json_lines_gzip_and_tag() {
        let t = setup(IngestConfig::default());
        let auth = token(&t, None);
        let body = gzip(b"{\"date\":1792678032.5,\"log\":\"started\\n\"}\n{\"date\":1792678033.0,\"msg\":\"x\",\"job_id\":\"7\"}\n");
        let (s, _, _) = send(
            &t,
            Request::post("/ingest/fluentbit")
                .header("authorization", &auth)
                .header("content-encoding", "gzip")
                .header("x-quiet-tag", "legivent.cron")
                .body(Body::from(body))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::ACCEPTED);
        let lines = tail(&t, "legivent-cron").await;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "started");
        assert_eq!(
            t.pipeline.hub().source("legivent-cron").unwrap().kind(),
            SourceKind::Fluentbit
        );
    }

    #[tokio::test]
    async fn otlp_protobuf_and_json() {
        let t = setup(IngestConfig::default());
        let auth = token(&t, None);
        let (s, h, b) = send(
            &t,
            Request::post("/v1/logs")
                .header("authorization", &auth)
                .header("content-type", "application/x-protobuf")
                .body(Body::from(otlp::tests::logs_request(
                    "payments-svc",
                    "charge failed",
                )))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(h[header::CONTENT_TYPE], "application/x-protobuf");
        assert!(b.is_empty());
        let line = &t.pipeline.store().tail("payments-svc", 1).await.unwrap()[0];
        assert_eq!(line.msg, "charge failed");
        assert!(
            line.ids.iter().any(|i| i.value == "ab".repeat(16)),
            "trace_id is indexed"
        );
        assert_eq!(
            t.pipeline.hub().source("payments-svc").unwrap().kind(),
            SourceKind::Otlp
        );

        let json_body = json!({ "resourceSpans": [{
            "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "api" } }] },
            "scopeSpans": [{ "spans": [{ "traceId": "11111111111111111111111111111111", "spanId": "2222222222222222",
              "name": "GET /orders", "startTimeUnixNano": "1760000000000000000", "endTimeUnixNano": "1760000000040000000" }] }] }] });
        let (s, _, b) = send(
            &t,
            Request::post("/v1/traces")
                .header("authorization", &auth)
                .header("content-type", "application/json")
                .header("content-encoding", "gzip")
                .body(Body::from(gzip(json_body.to_string().as_bytes())))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(&b[..], b"{}");
        assert_eq!(
            t.pipeline.store().tail("api", 1).await.unwrap()[0].msg,
            "GET /orders"
        );

        let (s, _, _) = send(
            &t,
            Request::post("/v1/logs")
                .header("authorization", &auth)
                .header("content-type", "application/x-protobuf")
                .body(Body::from(vec![0xffu8; 4]))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn bound_token_names_the_source() {
        let t = setup(IngestConfig::default());
        let auth = token(&t, Some("cron"));
        let (s, _, _) = send(
            &t,
            Request::post("/v1/logs")
                .header("authorization", &auth)
                .header("content-type", "application/x-protobuf")
                .body(Body::from(otlp::tests::logs_request("other", "x")))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(tail(&t, "cron").await.len(), 1);
        assert!(t.pipeline.hub().source("other").is_none());
    }

    #[tokio::test]
    async fn bad_tokens_are_401() {
        let t = setup(IngestConfig::default());
        let post = |auth: Option<&str>| {
            let mut r = Request::post("/ingest/ndjson").header("x-quiet-source", "api");
            if let Some(a) = auth {
                r = r.header("authorization", a);
            }
            r.body(Body::from("hello")).unwrap()
        };
        let (s, h, b) = send(&t, post(None)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(h[header::WWW_AUTHENTICATE], "Bearer");
        assert!(String::from_utf8_lossy(&b).contains("missing ingest token"));
        let (s, _, _) = send(&t, post(Some("Bearer qi_wrong"))).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let created = t.tokens.create("t", None, 0).unwrap();
        t.tokens.revoke(created.token.id, 1).unwrap();
        let (s, _, b) = send(&t, post(Some(&format!("Bearer {}", created.secret)))).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert!(String::from_utf8_lossy(&b).contains("revoked"));
        assert!(tail(&t, "api").await.is_empty());
        // Each refusal is counted for the system status and the source's
        // Rejected tab, with a token preview and no body.
        let sys = t.pipeline.system();
        assert_eq!(sys.rejected_since(0, Some("api")), 3);
        let latest = &sys.rejections(Some("api"), 10)[0];
        assert_eq!(
            (latest.status, latest.reason.as_str()),
            (401, "ingest token revoked")
        );
        assert_eq!(
            latest.token.as_deref().map(|t| t.starts_with("qi_••••")),
            Some(true)
        );

        // Open mode takes tokenless lines but still checks a token that is sent.
        let t = setup(IngestConfig {
            auth: IngestAuth::Open,
            ..Default::default()
        });
        assert_eq!(send(&t, post(None)).await.0, StatusCode::ACCEPTED);
        assert_eq!(
            send(&t, post(Some("Bearer qi_wrong"))).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(tail(&t, "api").await, vec!["hello"]);
    }

    #[tokio::test]
    async fn size_cap_before_and_after_gzip() {
        let t = setup(IngestConfig {
            max_body: 1_000,
            ..Default::default()
        });
        let auth = token(&t, Some("api"));
        let big = "x".repeat(2_000);
        let (s, _, b) = send(
            &t,
            Request::post("/ingest/ndjson")
                .header("authorization", &auth)
                .body(Body::from(big.clone()))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(String::from_utf8_lossy(&b).contains("1000 bytes"));
        // Small on the wire, too big once inflated.
        let packed = gzip(big.as_bytes());
        assert!(packed.len() < 1_000);
        let (s, _, _) = send(
            &t,
            Request::post("/ingest/ndjson")
                .header("authorization", &auth)
                .header("content-encoding", "gzip")
                .body(Body::from(packed))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        let (s, _, _) = send(
            &t,
            Request::post("/ingest/ndjson")
                .header("authorization", &auth)
                .header("content-encoding", "br")
                .body(Body::from("x"))
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(tail(&t, "api").await.is_empty());
    }

    #[tokio::test]
    async fn rate_limit_is_429_with_retry_after() {
        let t = setup(IngestConfig {
            rate: 2,
            ..Default::default()
        }); // bursts of 10 lines
        let auth = token(&t, Some("api"));
        let post = |n: usize| {
            Request::post("/ingest/ndjson")
                .header("authorization", &auth)
                .body(Body::from(vec!["line"; n].join("\n")))
                .unwrap()
        };
        assert_eq!(send(&t, post(8)).await.0, StatusCode::ACCEPTED);
        let (s, h, b) = send(&t, post(8)).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
        assert!(
            h[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                >= 1
        );
        assert!(String::from_utf8_lossy(&b).contains("2 lines/s"));
        assert_eq!(
            tail(&t, "api").await.len(),
            8,
            "a limited batch is not half-stored"
        );
    }
}
