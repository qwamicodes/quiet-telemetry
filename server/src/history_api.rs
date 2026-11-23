//! Retained history: destinations, policy, jobs and status (v0.1.1 Phase 5a, 5b).
//!
//! GET    /api/storage/destinations                     { destinations }
//! POST   /api/storage/destinations                     NewDestination → 201 { destination, verify }  (owner)
//! PATCH  /api/storage/destinations/:id                 UpdateDestination → { destination, verify }   (owner)
//! DELETE /api/storage/destinations/:id                 { delete_history? } → 204, or 202 { job }      (owner)
//! POST   /api/storage/destinations/:id/verify          → VerifyResult                                (owner)
//! POST   /api/storage/destinations/:id/activate        { copy_history? } → Destination               (owner)
//! PUT    /api/storage/destinations/:id/capacity        { capacity_bytes } → Destination              (owner)
//! POST   /api/storage/destinations/:id/retry-cleanup   → Destination                                 (owner)
//! GET    /api/storage/history                          HistoryStatus
//! POST   /api/storage/history/backfill                 → 202 HistoryJob                              (owner)
//! POST   /api/storage/history/off                      → 204                                         (owner)
//! POST   /api/storage/jobs/:id/cancel                  → HistoryJob                                  (owner)
//! POST   /api/storage/jobs/:id/retry                   → HistoryJob                                  (owner)
//! GET    /api/settings/history                         HistoryPolicy
//! PUT    /api/settings/history                         { retention_days, at_capacity, confirm? } → HistoryPolicy (owner)
//!                                                      409 confirm_required { preview } when it deletes hours
//! POST   /api/settings/history/preview                 { retention_days } → HistoryPreview
//!
//! Secrets are write-only: responses carry an access key preview, never the
//! secret.

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::history::{
    AtCapacity, Destination, HistoryError, HistoryJob, HistoryPolicy, HistoryPreview,
    HistoryStatus, NewDestination, UpdateDestination, VerifyResult,
};
use crate::settings_api::bad;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/storage/destinations", get(list).post(create))
        .route(
            "/api/storage/destinations/:id",
            axum::routing::patch(update).delete(remove),
        )
        .route("/api/storage/destinations/test", post(test))
        .route("/api/storage/destinations/:id/verify", post(verify))
        .route("/api/storage/destinations/:id/activate", post(activate))
        .route(
            "/api/storage/destinations/:id/capacity",
            axum::routing::put(capacity),
        )
        .route(
            "/api/storage/destinations/:id/retry-cleanup",
            post(retry_cleanup),
        )
        .route("/api/storage/history", get(status))
        .route("/api/storage/history/backfill", post(backfill))
        .route("/api/storage/history/off", post(turn_off))
        .route("/api/storage/jobs/:id/cancel", post(cancel_job))
        .route("/api/storage/jobs/:id/retry", post(retry_job))
        .route("/api/settings/history", get(policy).put(put_policy))
        .route("/api/settings/history/preview", post(preview))
}

#[derive(Debug, Deserialize, TS)]
pub struct PutHistoryPolicy {
    /// Days to keep archived hours; `null`: indefinitely.
    #[ts(type = "number | null")]
    pub retention_days: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub at_capacity: Option<AtCapacity>,
    /// Size limit per connector, bytes; `null` removes it. Absent: unchanged.
    #[serde(default, deserialize_with = "some_option")]
    #[ts(optional, type = "number | null")]
    pub size_limit_bytes: Option<Option<u64>>,
    /// Required when the new window deletes archived hours.
    #[serde(default)]
    #[ts(optional)]
    pub confirm: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
pub struct PreviewRequest {
    #[ts(type = "number | null")]
    pub retention_days: Option<u32>,
}

#[derive(Debug, Deserialize, TS)]
pub struct SetCapacity {
    /// Bytes; `null` clears it.
    #[ts(type = "number | null")]
    pub capacity_bytes: Option<u64>,
}

#[derive(Debug, Serialize, TS)]
pub struct RemoveStarted {
    pub job: HistoryJob,
}

#[derive(Debug, Serialize, TS)]
pub struct DestinationsResponse {
    pub destinations: Vec<Destination>,
}

#[derive(Debug, Serialize, TS)]
pub struct DestinationSaved {
    pub destination: Destination,
    pub verify: VerifyResult,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct ActivateRequest {
    #[serde(default)]
    #[ts(optional)]
    pub copy_history: Option<bool>,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct RemoveDestination {
    #[serde(default)]
    #[ts(optional)]
    pub delete_history: Option<bool>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn failed(e: HistoryError) -> Response {
    match e {
        HistoryError::Invalid(m) => bad(StatusCode::BAD_REQUEST, "invalid", &m),
        HistoryError::NotFound => bad(StatusCode::NOT_FOUND, "not_found", "no such destination"),
        HistoryError::Conflict(code, m) => bad(StatusCode::CONFLICT, code, &m),
        HistoryError::ConfirmRequired(preview) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": format!(
                    "this deletes {} archived hour{}: confirm to continue",
                    preview.hours,
                    if preview.hours == 1 { "" } else { "s" }
                ),
                "code": "confirm_required",
                "preview": preview,
            })),
        )
            .into_response(),
        HistoryError::Failed(e) => {
            tracing::error!(error = %format!("{e:#}"), "history request failed");
            bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "retained history settings could not be read or saved",
            )
        }
    }
}

async fn list(State(s): State<AppState>) -> Response {
    match s.history.destinations() {
        Ok(destinations) => Json(DestinationsResponse { destinations }).into_response(),
        Err(e) => failed(e.into()),
    }
}

async fn status(State(s): State<AppState>) -> Response {
    match s
        .history
        .status_with(s.pipeline.store().as_ref(), now())
        .await
    {
        Ok(st) => Json::<HistoryStatus>(st).into_response(),
        Err(e) => failed(e.into()),
    }
}

async fn policy(State(s): State<AppState>) -> Response {
    match s.history.catalog.policy() {
        Ok(p) => Json::<HistoryPolicy>(p).into_response(),
        Err(e) => failed(e.into()),
    }
}

async fn put_policy(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<PutHistoryPolicy>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(b)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { retention_days: number | null, at_capacity?: \"evict\" | \"stop\", confirm? }",
        );
    };
    let current = match s.history.catalog.policy() {
        Ok(p) => p,
        Err(e) => return failed(e.into()),
    };
    let size_limit_bytes = b.size_limit_bytes.unwrap_or(current.size_limit_bytes);
    if size_limit_bytes.is_some_and(|b| b < crate::history::MIN_SIZE_LIMIT) {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "size_limit_bytes: at least 1 GB, or null for no limit",
        );
    }
    let p = HistoryPolicy {
        retention_days: b.retention_days,
        at_capacity: b.at_capacity.unwrap_or(current.at_capacity),
        size_limit_bytes,
        saved_by: Some(v.user.name.clone()),
        saved_at: Some(now()),
    };
    match s.history.set_policy(p, b.confirm.unwrap_or(false), now()) {
        Ok(p) => Json(p).into_response(),
        Err(e) => failed(e),
    }
}

async fn preview(State(s): State<AppState>, body: Option<Json<PreviewRequest>>) -> Response {
    let days = body.and_then(|Json(b)| b.retention_days);
    match s.history.preview(days, now()) {
        Ok(p) => Json::<HistoryPreview>(p).into_response(),
        Err(e) => failed(e.into()),
    }
}

async fn backfill(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.backfill(s.pipeline.store().as_ref(), now()).await {
        Ok(j) => (StatusCode::ACCEPTED, Json(j)).into_response(),
        Err(e) => failed(e),
    }
}

async fn turn_off(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.turn_off() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => failed(e),
    }
}

async fn capacity(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
    body: Option<Json<SetCapacity>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(b)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { capacity_bytes: number | null }",
        );
    };
    match s.history.set_capacity(id, b.capacity_bytes) {
        Ok(d) => Json(d).into_response(),
        Err(e) => failed(e),
    }
}

async fn retry_cleanup(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.retry_cleanup(id) {
        Ok(d) => Json(d).into_response(),
        Err(e) => failed(e),
    }
}

async fn cancel_job(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.cancel_job(id, now()) {
        Ok(j) => Json(j).into_response(),
        Err(e) => failed(e),
    }
}

async fn retry_job(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.retry_job(id, now()) {
        Ok(j) => Json(j).into_response(),
        Err(e) => failed(e),
    }
}

async fn create(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<NewDestination>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(n)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { name, kind, endpoint?, region?, bucket, prefix?, path_style?, access_key_id, secret_access_key, activate? }",
        );
    };
    match s.history.create(n, now()).await {
        Ok((destination, verify)) => (
            StatusCode::CREATED,
            Json(DestinationSaved {
                destination,
                verify,
            }),
        )
            .into_response(),
        Err(e) => failed(e),
    }
}

async fn update(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
    body: Option<Json<UpdateDestination>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let u = body.map(|Json(u)| u).unwrap_or_default();
    match s.history.update(id, u, now()).await {
        Ok((destination, verify)) => Json(DestinationSaved {
            destination,
            verify,
        })
        .into_response(),
        Err(e) => failed(e),
    }
}

async fn remove(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
    body: Option<Json<RemoveDestination>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let delete = body.and_then(|Json(b)| b.delete_history).unwrap_or(false);
    match s.history.remove(id, delete, now()) {
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(job)) => (StatusCode::ACCEPTED, Json(RemoveStarted { job })).into_response(),
        Err(e) => failed(e),
    }
}

/// Test a connection without saving it (v1.1-05/06).
async fn test(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<NewDestination>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(n)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected the same body as POST /api/storage/destinations",
        );
    };
    match s.history.test(&n, now()).await {
        Ok(r) => Json::<VerifyResult>(r).into_response(),
        Err(e) => failed(e),
    }
}

async fn verify(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    match s.history.verify(id, now()).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => failed(e),
    }
}

async fn activate(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<i64>,
    body: Option<Json<ActivateRequest>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let copy = body.and_then(|Json(b)| b.copy_history).unwrap_or(false);
    match s.history.activate(id, copy, now()).await {
        Ok(d) => {
            // The hours still in the local window are copied to the new
            // destination in the background (v1.1-12, -13); older history
            // stays where it is, searchable while connected.
            let _ = s.history.backfill(s.pipeline.store().as_ref(), now()).await;
            Json(d).into_response()
        }
        Err(e) => failed(e),
    }
}

/// `"k": null` → `Some(None)`; absent → `None` (with `#[serde(default)]`).
fn some_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}
