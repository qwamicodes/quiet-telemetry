//! Flows over HTTP.
//!
//! GET  /api/flow?id=<any correlation id>     the stitched flow (404 + close matches)
//! GET  /api/flow?line=<line id>              the flow of that line (one node if it has no ids)
//! POST /api/flow-summaries {"ids":[...]}     header numbers for up to 100 ids at once
//!                                            (search "group by flow", the stream's steps column)
//!
//! Ids go in the query string, not the path, so any id (`/`, `:`, spaces) works.
//! Everything is bounded by the retention window and [`Limits`].

use crate::api::AppState;
use crate::flow::{build, stitch, Flow, FlowSummary, Limits, Seed};
use crate::normalize::{CorrId, IdKey};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/flow", get(flow))
        .route("/api/flow-summaries", post(summaries))
}

/// Longest id accepted (longer is a 400, not a lookup).
pub const MAX_ID_LEN: usize = 256;
/// Ids per summaries request.
pub const MAX_SUMMARIES: usize = 100;
const CLOSE_MATCHES: usize = 5;

/// `?id=` or `?line=`, exactly one.
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
pub struct FlowParams {
    #[ts(optional)]
    pub id: Option<String>,
    #[ts(optional)]
    pub line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowResponse {
    pub flow: Flow,
    /// The window searched, unix ms.
    pub since: i64,
    pub until: i64,
    pub took_ms: u64,
}

/// An id with lines, shown when the one asked for has none.
#[derive(Debug, Clone, Serialize, TS)]
pub struct CloseMatch {
    pub key: IdKey,
    pub value: String,
    /// Its newest line's summary, time and source.
    pub msg: String,
    pub ts: i64,
    pub source: String,
}

/// The 404 body of `/api/flow`.
#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowNotFound {
    pub error: String,
    pub id: String,
    pub close: Vec<CloseMatch>,
    pub since: i64,
    pub until: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
pub struct FlowSummariesRequest {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowSummaryEntry {
    pub id: String,
    /// Null when no line in the window carries the id.
    pub flow: Option<FlowSummary>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowSummariesResponse {
    pub flows: Vec<FlowSummaryEntry>,
}

fn bad(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn unavailable(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "flow read failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "store unavailable" })),
    )
        .into_response()
}

fn window(s: &AppState) -> (i64, i64) {
    let now = chrono::Utc::now().timestamp_millis();
    (now - s.retention_ms, now)
}

fn valid_id(id: &str) -> Result<&str, &'static str> {
    let id = id.trim();
    if id.is_empty() {
        Err("id is empty")
    } else if id.len() > MAX_ID_LEN {
        Err("id is too long")
    } else {
        Ok(id)
    }
}

async fn flow(State(s): State<AppState>, Query(p): Query<FlowParams>) -> Response {
    let started = std::time::Instant::now();
    let store = s.pipeline.store().clone();
    let (since, until) = window(&s);
    // A line from a moment ago should be in its flow.
    if let Err(e) = store.flush().await {
        return unavailable(e);
    }
    let oldest = store.usage().await.ok().and_then(|u| u.oldest);

    let (seed, opened) = match (&p.id, p.line) {
        (Some(id), None) => match valid_id(id) {
            Ok(id) => (Seed::Id(id), Some(id.to_string())),
            Err(e) => return bad(e),
        },
        (None, Some(line_id)) => match store.line(line_id).await {
            Ok(Some(l)) => {
                let opened = l.display_id.as_ref().map(|d| d.value.clone());
                (Seed::Line(l), opened)
            }
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "line not found (expired or never stored)" })),
                )
                    .into_response()
            }
            Err(e) => return unavailable(e),
        },
        _ => return bad("give exactly one of `id` or `line`"),
    };

    let st = match stitch(&*store, seed, since, until, Limits::default()).await {
        Ok(st) => st,
        Err(e) => return unavailable(e),
    };
    if st.lines.is_empty() {
        let id = opened.unwrap_or_default();
        let close = match close_matches(&s, &id, since, until).await {
            Ok(c) => c,
            Err(e) => return unavailable(e),
        };
        return (
            StatusCode::NOT_FOUND,
            Json(FlowNotFound {
                error: "no lines carry this id in the window".into(),
                id,
                close,
                since,
                until,
            }),
        )
            .into_response();
    }
    Json(FlowResponse {
        flow: build(st, opened.as_deref(), oldest),
        since,
        until,
        took_ms: started.elapsed().as_millis() as u64,
    })
    .into_response()
}

async fn close_matches(
    s: &AppState,
    id: &str,
    since: i64,
    until: i64,
) -> anyhow::Result<Vec<CloseMatch>> {
    let store = s.pipeline.store();
    let mut out = Vec::new();
    for (c, line_id) in store.similar_ids(id, since, until, CLOSE_MATCHES).await? {
        let CorrId { key, value } = c;
        let (msg, ts, source) = match store.line(line_id).await? {
            Some(l) => (l.msg.clone(), l.ts, l.source.clone()),
            None => continue,
        };
        out.push(CloseMatch {
            key,
            value,
            msg,
            ts,
            source,
        });
    }
    Ok(out)
}

async fn summaries(State(s): State<AppState>, Json(req): Json<FlowSummariesRequest>) -> Response {
    if req.ids.len() > MAX_SUMMARIES {
        return bad("at most 100 ids per request");
    }
    let mut ids = Vec::with_capacity(req.ids.len());
    for id in &req.ids {
        match valid_id(id) {
            Ok(id) => ids.push(id.to_string()),
            Err(e) => return bad(e),
        }
    }
    let store = s.pipeline.store().clone();
    let (since, until) = window(&s);
    if let Err(e) = store.flush().await {
        return unavailable(e);
    }
    // Ids of one flow share its summary: stitch once, answer for all of them.
    let mut done: HashMap<String, Option<FlowSummary>> = HashMap::new();
    let mut flows = Vec::with_capacity(ids.len());
    for id in ids {
        if !done.contains_key(&id) {
            let st = match stitch(&*store, Seed::Id(&id), since, until, Limits::default()).await {
                Ok(st) => st,
                Err(e) => return unavailable(e),
            };
            if st.lines.is_empty() {
                done.insert(id.clone(), None);
            } else {
                let followed: Vec<String> = st.ids.iter().map(|i| i.value.clone()).collect();
                let summary = build(st, Some(&id), None).summary;
                for v in followed {
                    done.entry(v).or_insert_with(|| Some(summary.clone()));
                }
                done.entry(id.clone()).or_insert(Some(summary));
            }
        }
        flows.push(FlowSummaryEntry {
            flow: done.get(&id).cloned().flatten(),
            id,
        });
    }
    Json(FlowSummariesResponse { flows }).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    async fn state() -> AppState {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new());
        let now = chrono::Utc::now().timestamp_millis();
        pipeline
            .ingest(
                SourceKind::Http,
                [
                    RawLine::new(
                        r#"{"level":30,"method":"POST","path":"/orders","status":201,"duration_ms":40,"request_id":"req_abc123"}"#,
                        "api",
                        now - 1000,
                    ),
                    RawLine::new(
                        r#"{"level":30,"phase":"picked_up","job_id":"ord/1","request_id":"req_abc123"}"#,
                        "worker",
                        now - 900,
                    ),
                    RawLine::new(
                        r#"{"level":50,"phase":"confirm","job_id":"ord/1","outcome":"failed"}"#,
                        "worker",
                        now - 800,
                    ),
                    RawLine::new("plain text, no ids", "api", now - 700),
                ],
            )
            .await
            .unwrap();
        AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled)))
    }

    async fn call(st: &AppState, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = routes().with_state(st.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap_or_default())
    }

    fn get(uri: &str) -> Request<Body> {
        Request::get(uri).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn flow_by_id_any_key_and_by_line() {
        let st = state().await;
        let (code, v) = call(&st, get("/api/flow?id=ord%2F1")).await;
        assert_eq!(code, StatusCode::OK);
        let f = &v["flow"];
        assert_eq!(f["lines"].as_array().unwrap().len(), 3);
        assert_eq!(f["nodes"].as_array().unwrap().len(), 3);
        assert_eq!(f["title"], "POST /orders");
        assert_eq!(f["status"], "error");
        assert_eq!(f["opened"]["key"], "job_id");
        assert_eq!(f["stitched_by"], json!(["job_id", "request_id"]));
        assert_eq!(f["edges"][0]["kind"], "handoff");

        // By line: the plain-text line is a one-node flow.
        let (code, v) = call(&st, get("/api/flow?line=4")).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["flow"]["nodes"].as_array().unwrap().len(), 1);
        assert!(v["flow"]["opened"].is_null());
        let (code, v) = call(&st, get("/api/flow?line=1")).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v["flow"]["lines"].as_array().unwrap().len(), 3);
        assert_eq!(v["flow"]["opened"]["value"], "req_abc123");
    }

    #[tokio::test]
    async fn not_found_bad_params_and_close_matches() {
        let st = state().await;
        let (code, v) = call(&st, get("/api/flow?id=req_abc199")).await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        assert_eq!(v["id"], "req_abc199");
        assert_eq!(v["close"][0]["value"], "req_abc123");
        assert_eq!(v["close"][0]["source"], "worker");

        assert_eq!(call(&st, get("/api/flow")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            call(&st, get("/api/flow?id=a&line=1")).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&st, get("/api/flow?id=%20")).await.0,
            StatusCode::BAD_REQUEST
        );
        let long = "x".repeat(MAX_ID_LEN + 1);
        assert_eq!(
            call(&st, get(&format!("/api/flow?id={long}"))).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&st, get("/api/flow?line=nope")).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&st, get("/api/flow?line=99")).await.0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn summaries_share_one_flow_across_its_ids() {
        let st = state().await;
        let req = Request::post("/api/flow-summaries")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"ids":["req_abc123","ord/1","nope"]}"#))
            .unwrap();
        let (code, v) = call(&st, req).await;
        assert_eq!(code, StatusCode::OK);
        let flows = v["flows"].as_array().unwrap();
        assert_eq!(flows.len(), 3);
        assert_eq!(flows[0]["flow"]["key"], flows[1]["flow"]["key"]);
        assert_eq!(flows[0]["flow"]["line_count"], 3);
        assert_eq!(flows[0]["flow"]["steps"], 3);
        assert!(flows[2]["flow"].is_null());

        let many = serde_json::to_string(&FlowSummariesRequest {
            ids: (0..=MAX_SUMMARIES).map(|i| format!("id{i}")).collect(),
        })
        .unwrap();
        let req = Request::post("/api/flow-summaries")
            .header("content-type", "application/json")
            .body(Body::from(many))
            .unwrap();
        assert_eq!(call(&st, req).await.0, StatusCode::BAD_REQUEST);
    }
}
