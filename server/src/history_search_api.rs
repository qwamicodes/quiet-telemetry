//! Searching retained history (v0.1.1 Phase 5c).
//!
//! POST   /api/search/history             { "query": "<search query string>" } → 202 HistorySearchJob
//! GET    /api/search/history/:id?offset=&limit=   → HistorySearchJob (poll; a page of matches)
//! DELETE /api/search/history/:id         cancel; what was found stays
//! GET    /api/search/history/:id/export?format=&gzip=&mask=&raw=&columns=
//!
//! Jobs are per user and live in memory. The query is the same string
//! `/api/search` takes; the job searches only the part of its range older
//! than the local window. Exports use the job's matches, which are the
//! archived (already sanitized) lines; members always get PII masked.

use crate::api::AppState;
use crate::auth::Viewer;
use crate::history::search::{HistorySearchJob, JobError, SearchJobState};
use crate::search::Order;
use crate::search_api::{bound, content_type, plan, ExportParams, SearchParams};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::io::Write;
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search/history", post(start))
        .route("/api/search/history/:id", get(view).delete(cancel))
        .route("/api/search/history/:id/export", get(export))
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct HistorySearchRequest {
    /// The search query string (`q=…&since=…&until=…&source=…`).
    pub query: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Page {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

fn err(status: StatusCode, code: &str, msg: impl std::fmt::Display) -> Response {
    (
        status,
        Json(json!({ "error": msg.to_string(), "code": code })),
    )
        .into_response()
}

fn job_err(e: JobError) -> Response {
    match e {
        JobError::NotFound(_) => err(StatusCode::NOT_FOUND, "not_found", e),
        JobError::NothingToSearch => err(StatusCode::BAD_REQUEST, "nothing_to_search", e),
    }
}

/// The first hour still in the local window, if any.
pub(crate) async fn local_first(s: &AppState) -> Option<i64> {
    s.pipeline.store().hours().await.ok()?.into_iter().min()
}

async fn start(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Json(r): Json<HistorySearchRequest>,
) -> Response {
    let p = match serde_urlencoded::from_str::<SearchParams>(&r.query) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, "invalid", e),
    };
    let mut q = match p.to_query(Order::Newest) {
        Ok(q) => q,
        Err(e) => return err(StatusCode::BAD_REQUEST, "invalid", e),
    };
    bound(&s, &mut q);
    let now = chrono::Utc::now().timestamp_millis();
    let first = local_first(&s).await;
    match s
        .history_search
        .start(s.history.clone(), q, first, v.user.id, now)
    {
        Ok(job) => (StatusCode::ACCEPTED, Json(job.view(0, 200))).into_response(),
        Err(e) => match e.downcast::<JobError>() {
            Ok(je) => job_err(je),
            Err(e) => err(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                format!("{e:#}"),
            ),
        },
    }
}

async fn view(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
    Query(p): Query<Page>,
) -> Response {
    match s.history_search.job(&id, v.user.id) {
        Ok(j) => Json::<HistorySearchJob>(
            j.view(p.offset.unwrap_or(0), p.limit.unwrap_or(200).clamp(1, 1000)),
        )
        .into_response(),
        Err(e) => job_err(e),
    }
}

async fn cancel(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    match s.history_search.cancel(&id, v.user.id) {
        Ok(j) => Json(j.view(0, 200)).into_response(),
        Err(e) => job_err(e),
    }
}

async fn export(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
    Query(e): Query<ExportParams>,
) -> Response {
    let job = match s.history_search.job(&id, v.user.id) {
        Ok(j) => j,
        Err(e) => return job_err(e),
    };
    if job.state() == SearchJobState::Retrieving {
        return err(
            StatusCode::CONFLICT,
            "retrieving",
            "the history job is still retrieving; export once it is done or cancelled",
        );
    }
    let plan = match plan(&s, SearchParams::default(), &e, !v.is_owner()) {
        Ok(p) => p,
        Err(m) => return err(StatusCode::BAD_REQUEST, "invalid", m),
    };
    let fmt = plan.fmt;
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(fmt.header().as_bytes());
    let mut first = true;
    // Oldest first, like every export.
    for (_, l) in job.matches().iter().rev().filter(|(_, l)| fmt.keeps(l)) {
        body.extend_from_slice(fmt.line(l, first).as_bytes());
        first = false;
    }
    body.extend_from_slice(fmt.footer(!first).as_bytes());
    if plan.gzip {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        if gz.write_all(&body).is_err() {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "export_failed",
                "gzip failed",
            );
        }
        body = match gz.finish() {
            Ok(b) => b,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, "export_failed", e),
        };
    }
    let day = chrono::Utc::now().format("%Y-%m-%d");
    let name = format!(
        "quiet-history-{day}.{}{}",
        plan.format.ext(),
        if plan.gzip { ".gz" } else { "" }
    );
    let mut res = Response::new(axum::body::Body::from(body));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(plan.format, plan.gzip)),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}
