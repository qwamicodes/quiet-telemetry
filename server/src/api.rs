//! HTTP + WebSocket API.
//!
//! GET  /api/health
//! GET  /api/sources
//! GET  /api/sources/:name/lines?limit=500
//! GET  /api/stream?source=api&backlog=500&level=warn&q=text   (WebSocket)
//! POST /ingest/ndjson     header X-Quiet-Source: <name>      (one JSON/text line per row)

use crate::docker::DockerStatus;
use crate::hub::{Hub, Line, SourceKind};
use crate::normalize::{normalize, Level};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub docker: Arc<Mutex<DockerStatus>>,
    pub started: i64,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/sources", get(sources))
        .route("/api/sources/:name/lines", get(lines))
        .route("/api/stream", get(stream))
        .route("/ingest/ndjson", post(ingest_ndjson))
        .with_state(state)
}

async fn health(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "started": s.started,
        "docker": *s.docker.lock().unwrap(),
    }))
}

async fn sources(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "sources": s.hub.list() }))
}

#[derive(Deserialize)]
struct LinesQuery {
    limit: Option<usize>,
}

async fn lines(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<LinesQuery>,
) -> Response {
    match s.hub.source(&name) {
        Some(src) => {
            Json(json!({ "lines": src.tail(q.limit.unwrap_or(500).min(10_000)) })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "unknown source" })),
        )
            .into_response(),
    }
}

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
    fn min_level(&self) -> Option<Level> {
        self.level.as_deref().and_then(Level::parse_name)
    }

    pub fn matches(&self, line: &Line) -> bool {
        if let Some(min) = self.min_level() {
            match line.level {
                Some(l) if l as u8 >= min as u8 => {}
                _ => return false,
            }
        }
        if let Some(q) = self.q.as_deref().filter(|q| !q.is_empty()) {
            if !line.raw.to_lowercase().contains(&q.to_lowercase()) {
                return false;
            }
        }
        true
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Frame<'a> {
    Backlog {
        lines: Vec<&'a Line>,
    },
    Lines {
        lines: Vec<&'a Line>,
    },
    /// The client fell behind and `dropped` lines were skipped.
    Gap {
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

async fn run_stream(mut ws: WebSocket, s: AppState, f: Filter) {
    // Allow streaming a source before its first line arrives.
    let source = s.hub.ensure_source(&f.source, SourceKind::Http);
    let mut rx = source.subscribe();

    let backlog: Vec<Line> = source
        .tail(10_000)
        .into_iter()
        .filter(|l| f.matches(l))
        .collect();
    let n = f.backlog.unwrap_or(500).min(10_000);
    let start = backlog.len().saturating_sub(n);
    let last_sent = backlog.last().map(|l| l.id).unwrap_or(0);
    if send(
        &mut ws,
        &Frame::Backlog {
            lines: backlog[start..].iter().collect(),
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
                    if line.id > last_sent && f.matches(&line) {
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

async fn ingest_ndjson(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let source = headers
        .get("x-quiet-source")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("http")
        .to_string();
    let received = chrono::Utc::now().timestamp_millis();
    let text = String::from_utf8_lossy(&body);
    let mut accepted = 0usize;
    for raw in text.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        // Vector/Fluent Bit can also send one JSON array; unwrap it.
        if raw.starts_with('[') {
            if let Ok(serde_json::Value::Array(items)) =
                serde_json::from_str::<serde_json::Value>(raw)
            {
                for item in items {
                    s.hub.publish(
                        normalize(&item.to_string(), &source, None, received),
                        SourceKind::Http,
                    );
                    accepted += 1;
                }
                continue;
            }
        }
        s.hub
            .publish(normalize(raw, &source, None, received), SourceKind::Http);
        accepted += 1;
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": accepted, "source": source })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState {
            hub: Hub::new(100),
            docker: Arc::new(Mutex::new(DockerStatus::Disabled)),
            started: 0,
        }
    }

    #[tokio::test]
    async fn ingest_then_read_back() {
        let st = state();
        let app = router(st.clone());
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

        let res = app
            .oneshot(
                Request::get("/api/sources/api/lines")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["level"], "warn");
        assert_eq!(lines[0]["display_id"]["value"], "r1");
        assert_eq!(lines[3]["msg"], "b");
    }

    #[test]
    fn filter_level_and_text() {
        let hub = Hub::new(10);
        let warn = hub.publish(
            normalize(r#"{"level":"warn","msg":"Slow Query"}"#, "a", None, 0),
            SourceKind::Http,
        );
        let info = hub.publish(
            normalize(r#"{"level":"info","msg":"ok"}"#, "a", None, 0),
            SourceKind::Http,
        );
        let bare = hub.publish(normalize("no level", "a", None, 0), SourceKind::Http);
        let f = Filter {
            source: "a".into(),
            level: Some("warn".into()),
            ..Default::default()
        };
        assert!(f.matches(&warn) && !f.matches(&info) && !f.matches(&bare));
        let f = Filter {
            source: "a".into(),
            q: Some("slow query".into()),
            ..Default::default()
        };
        assert!(f.matches(&warn) && !f.matches(&info));
    }
}
