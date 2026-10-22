//! HTTP + WebSocket API for the UI, plus process probes.
//!
//! GET  /health                      liveness (checks nothing external)
//! GET  /ready                       readiness (503 while shutting down)
//! GET  /api/health                  version, uptime, receiver status (UI footer)
//! GET  /api/sources
//! GET  /api/sources/:name/lines?limit=500
//! GET  /api/stream?source=api&backlog=500&level=warn&q=text   (WebSocket)
//! GET  /api/search, /api/export, POST /api/export/token       (see `search_api.rs`)
//! GET  /api/flow, POST /api/flow-summaries                     (see `flow_api.rs`)
//!
//! Ingest endpoints belong to their receivers (see `receiver/`).

use crate::export::ExportTokens;
use crate::hub::{Line, SourceInfo, SourceKind};
use crate::normalize::LogLine;
use crate::pipeline::Pipeline;
use crate::receiver::DockerStatus;
use crate::store::{LineFilter, Query as StoreQuery};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

#[derive(Clone)]
pub struct AppState {
    pub pipeline: Arc<Pipeline>,
    pub docker: Arc<Mutex<DockerStatus>>,
    pub started: i64,
    /// False once shutdown begins, so a proxy stops routing here first.
    pub ready: Arc<AtomicBool>,
    /// Cancelled when the drain period ends; open streams close then.
    pub shutdown: CancellationToken,
    /// How far back search reaches by default (the retention window), ms.
    pub retention_ms: i64,
    /// Read-only `qx_` export tokens (hashed, 15 min, reusable).
    pub tokens: Arc<ExportTokens>,
}

impl AppState {
    pub fn new(pipeline: Arc<Pipeline>, docker: Arc<Mutex<DockerStatus>>) -> Self {
        AppState {
            pipeline,
            docker,
            started: chrono::Utc::now().timestamp_millis(),
            ready: Arc::new(AtomicBool::new(true)),
            shutdown: CancellationToken::new(),
            retention_ms: 24 * 3_600_000,
            tokens: Arc::new(ExportTokens::default()),
        }
    }

    pub fn with_retention(mut self, ms: i64) -> Self {
        self.retention_ms = ms;
        self
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(live))
        .route("/ready", get(ready))
        .route("/api/health", get(health))
        .route("/api/sources", get(sources))
        .route("/api/sources/:name/lines", get(lines))
        .route("/api/stream", get(stream))
        .merge(crate::search_api::routes())
        .merge(crate::flow_api::routes())
        .with_state(state)
}

async fn live() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

async fn ready(State(s): State<AppState>) -> Response {
    if s.ready.load(Ordering::Relaxed) {
        Json(json!({ "ready": true })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ready": false, "reason": "shutting down" })),
        )
            .into_response()
    }
}

/// What the UI shows in its footer.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    /// Process start, unix ms.
    pub started: i64,
    pub docker: DockerStatus,
    /// Where lines are kept: `sqlite` or `memory`.
    pub store: String,
    /// How long lines stay searchable, ms.
    pub retention_ms: i64,
    /// Bytes on disk (0 for the memory store).
    pub disk_bytes: u64,
    /// Lines in the searchable window.
    pub stored_lines: u64,
    /// Oldest stored event time, unix ms.
    pub oldest: Option<i64>,
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    let usage = s.pipeline.store().usage().await.unwrap_or_default();
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
        started: s.started,
        docker: s.docker.lock().unwrap().clone(),
        store: s.pipeline.store().kind().to_string(),
        retention_ms: s.retention_ms,
        disk_bytes: usage.bytes,
        stored_lines: usage.lines,
        oldest: usage.oldest,
    })
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SourcesResponse {
    pub sources: Vec<SourceInfo>,
}

async fn sources(State(s): State<AppState>) -> Json<SourcesResponse> {
    Json(SourcesResponse {
        sources: s.pipeline.hub().list(),
    })
}

#[derive(Deserialize)]
struct LinesQuery {
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct LinesResponse {
    #[ts(as = "Vec<LogLine>")]
    pub lines: Vec<Line>,
}

async fn lines(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<LinesQuery>,
) -> Response {
    if s.pipeline.hub().source(&name).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "unknown source" })),
        )
            .into_response();
    }
    let limit = q.limit.unwrap_or(500).min(10_000);
    match s.pipeline.store().tail(&name, limit).await {
        Ok(lines) => Json(LinesResponse { lines }).into_response(),
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

/// Query string of `/api/stream`.
#[derive(Deserialize, Clone, Default)]
pub struct Filter {
    pub source: String,
    pub backlog: Option<usize>,
    /// Minimum level; lines without a level are kept unless `level` is set.
    pub level: Option<String>,
    /// Case-insensitive substring over the raw line.
    pub q: Option<String>,
}

impl Filter {
    fn line_filter(&self) -> LineFilter {
        LineFilter::new(self.level.as_deref(), self.q.as_deref())
    }

    #[cfg(test)]
    pub fn matches(&self, line: &Line) -> bool {
        self.line_filter().matches(line)
    }
}

/// One WebSocket message from `/api/stream`.
#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(rename = "Frame")]
pub enum Frame<'a> {
    /// Sent once on connect: the newest matching lines, oldest first.
    Backlog {
        #[ts(as = "Vec<LogLine>")]
        lines: Vec<&'a Line>,
    },
    /// New lines, batched every 75 ms.
    Lines {
        #[ts(as = "Vec<LogLine>")]
        lines: Vec<&'a Line>,
    },
    /// The client fell behind and `dropped` lines were skipped.
    Gap {
        #[ts(type = "number")]
        dropped: u64,
    },
    Error {
        message: String,
    },
}

async fn stream(
    State(s): State<AppState>,
    Query(f): Query<Filter>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| run_stream(socket, s, f))
}

/// Batch window: lines arriving within it go out in one frame.
const BATCH: Duration = Duration::from_millis(75);
const MAX_BATCH: usize = 2000;
/// WebSocket close code 1012: service restart. The UI reconnects.
const CLOSE_RESTART: u16 = 1012;

async fn run_stream(mut ws: WebSocket, s: AppState, f: Filter) {
    // Allow streaming a source before its first line arrives.
    let source = s.pipeline.hub().ensure_source(&f.source, SourceKind::Http);
    let filter = f.line_filter();
    // Subscribe before reading the backlog so nothing slips between the two.
    let mut rx = source.subscribe();

    let backlog = s
        .pipeline
        .store()
        .query(&StoreQuery {
            source: f.source.clone(),
            filter: filter.clone(),
            limit: f.backlog.unwrap_or(500).min(10_000),
            ..Default::default()
        })
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "backlog read failed");
            Vec::new()
        });
    let last_sent = backlog.last().map(|l| l.id).unwrap_or(0);
    if send(
        &mut ws,
        &Frame::Backlog {
            lines: backlog.iter().collect(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let mut buf: Vec<Line> = Vec::new();
    let mut tick = tokio::time::interval(BATCH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(line) => {
                    if line.id > last_sent && filter.matches(&line) {
                        buf.push(line);
                        if buf.len() >= MAX_BATCH && flush(&mut ws, &mut buf).await.is_err() {
                            return;
                        }
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    if flush(&mut ws, &mut buf).await.is_err() { return; }
                    if send(&mut ws, &Frame::Gap { dropped: n }).await.is_err() { return; }
                }
                Err(RecvError::Closed) => {
                    let _ = send(&mut ws, &Frame::Error { message: "source closed".into() }).await;
                    return;
                }
            },
            _ = tick.tick() => {
                if flush(&mut ws, &mut buf).await.is_err() { return; }
            }
            _ = s.shutdown.cancelled() => {
                let _ = flush(&mut ws, &mut buf).await;
                let _ = ws
                    .send(Message::Close(Some(CloseFrame {
                        code: CLOSE_RESTART,
                        reason: "server restarting".into(),
                    })))
                    .await;
                return;
            }
            incoming = ws.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {} // pings are answered by axum; filters change by reconnecting (for now)
            }
        }
    }
}

async fn flush(ws: &mut WebSocket, buf: &mut Vec<Line>) -> Result<(), axum::Error> {
    if buf.is_empty() {
        return Ok(());
    }
    let r = send(
        ws,
        &Frame::Lines {
            lines: buf.iter().collect(),
        },
    )
    .await;
    buf.clear();
    r
}

async fn send(ws: &mut WebSocket, frame: &Frame<'_>) -> Result<(), axum::Error> {
    let text = serde_json::to_string(frame).expect("frames serialize");
    ws.send(Message::Text(text)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Hub;
    use crate::pipeline::RawLine;
    use crate::receiver::{NdjsonReceiver, Receiver};
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> AppState {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new());
        AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled)))
    }

    fn app(st: &AppState) -> Router {
        router(st.clone()).merge(NdjsonReceiver::new(st.pipeline.clone()).routes())
    }

    async fn json_of(res: Response) -> serde_json::Value {
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn ingest_then_read_back() {
        let st = state();
        let app = app(&st);
        let body = "{\"level\":40,\"msg\":\"slow\",\"request_id\":\"r1\"}\nplain text\n\n[{\"msg\":\"a\"},{\"msg\":\"b\"}]\n";
        let res = app
            .clone()
            .oneshot(
                Request::post("/ingest/ndjson")
                    .header("x-quiet-source", "api")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(json_of(res).await["accepted"], 4);

        let res = app
            .oneshot(
                Request::get("/api/sources/api/lines")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_of(res).await;
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["level"], "warn");
        assert_eq!(lines[0]["display_id"]["key"], "request_id");
        assert_eq!(lines[0]["display_id"]["value"], "r1");
        assert_eq!(lines[3]["msg"], "b");
    }

    #[tokio::test]
    async fn unknown_source_is_404_and_health_is_typed() {
        let st = state();
        let res = app(&st)
            .oneshot(
                Request::get("/api/sources/nope/lines")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        let res = app(&st)
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let v = json_of(res).await;
        assert_eq!(v["docker"]["state"], "disabled");
        assert_eq!(v["store"], "memory");
    }

    #[tokio::test]
    async fn ready_flips_to_503_on_shutdown_but_health_stays_up() {
        let st = state();
        let get = |p: &'static str| app(&st).oneshot(Request::get(p).body(Body::empty()).unwrap());
        assert_eq!(get("/ready").await.unwrap().status(), StatusCode::OK);
        st.ready.store(false, Ordering::Relaxed);
        assert_eq!(
            get("/ready").await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(get("/health").await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn filter_level_and_text() {
        let st = state();
        let lines = st
            .pipeline
            .ingest(
                SourceKind::Http,
                [
                    RawLine::new(r#"{"level":"warn","msg":"Slow Query"}"#, "a", 0),
                    RawLine::new(r#"{"level":"info","msg":"ok"}"#, "a", 0),
                    RawLine::new("no level", "a", 0),
                ],
            )
            .await
            .unwrap();
        let (warn, info, bare) = (&lines[0], &lines[1], &lines[2]);
        let f = Filter {
            source: "a".into(),
            level: Some("warn".into()),
            ..Default::default()
        };
        assert!(f.matches(warn) && !f.matches(info) && !f.matches(bare));
        let f = Filter {
            source: "a".into(),
            q: Some("slow query".into()),
            ..Default::default()
        };
        assert!(f.matches(warn) && !f.matches(info));
    }
}
