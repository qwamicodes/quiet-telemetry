//! Retained history: destinations and status (v0.1.1 Phase 5a).
//!
//! GET    /api/storage/destinations               { destinations }
//! POST   /api/storage/destinations               NewDestination → 201 { destination, verify }   (owner)
//! PATCH  /api/storage/destinations/:id           UpdateDestination → { destination, verify }   (owner)
//! DELETE /api/storage/destinations/:id           { delete_history? } → 204                      (owner)
//! POST   /api/storage/destinations/:id/verify    → VerifyResult                                 (owner)
//! POST   /api/storage/destinations/:id/activate  { copy_history? } → Destination                (owner)
//! GET    /api/storage/history                    HistoryStatus
//!
//! Secrets are write-only: responses carry an access key preview, never the
//! secret. `copy_history` / `delete_history` answer 501 `not_yet` (5b).

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::history::{
    Destination, HistoryError, HistoryStatus, NewDestination, UpdateDestination, VerifyResult,
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
        .route("/api/storage/destinations/:id/verify", post(verify))
        .route("/api/storage/destinations/:id/activate", post(activate))
        .route("/api/storage/history", get(status))
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
        HistoryError::NotYet(m) => bad(StatusCode::NOT_IMPLEMENTED, "not_yet", m),
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
    match s.history.status() {
        Ok(st) => Json::<HistoryStatus>(st).into_response(),
        Err(e) => failed(e.into()),
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
    match s.history.remove(id, delete) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
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
        Ok(d) => Json(d).into_response(),
        Err(e) => failed(e),
    }
}
