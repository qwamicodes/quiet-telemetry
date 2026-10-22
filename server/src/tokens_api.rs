//! Ingest token management for the UI.
//!
//! GET    /api/ingest-tokens        → { tokens }
//! POST   /api/ingest-tokens        { name, source? } → { token, secret }   (201)
//! DELETE /api/ingest-tokens/:id    → the revoked token
//! POST   /api/ingest-tokens/:id/restore → the token, working again
//!        (Undo; only within `UNDO_REVOKE_MS` of the revoke, else 409)
//!
//! Needs a session like the rest of `/api`. Anyone signed in can list tokens
//! (previews only, never secrets); only owners can create or revoke them.

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::tokens::{CreateIngestToken, IngestTokensResponse, Restore};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde_json::json;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/ingest-tokens", get(list).post(create))
        .route("/api/ingest-tokens/:id", delete(revoke))
        .route("/api/ingest-tokens/:id/restore", post(restore))
}

fn bad(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

fn store_error(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "ingest token store failed");
    bad(StatusCode::SERVICE_UNAVAILABLE, "token store unavailable")
}

async fn list(State(s): State<AppState>) -> Response {
    match s.ingest_tokens.list() {
        Ok(tokens) => Json(IngestTokensResponse { tokens }).into_response(),
        Err(e) => store_error(e),
    }
}

/// A source name as the UI and the hub accept it.
pub fn valid_source(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 128 && !s.chars().any(char::is_control)
}

async fn create(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<CreateIngestToken>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(req)) = body else {
        return bad(StatusCode::BAD_REQUEST, "expected JSON { name, source? }");
    };
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return bad(StatusCode::BAD_REQUEST, "name: 1–80 characters");
    }
    let source = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if source.is_some_and(|v| !valid_source(v)) {
        return bad(StatusCode::BAD_REQUEST, "source: 1–128 characters");
    }
    let now = chrono::Utc::now().timestamp_millis();
    match s.ingest_tokens.create(name, source, now) {
        Ok(created) => {
            tracing::info!(id = created.token.id, by = v.user.id, name, source = ?source, "ingest token created");
            (StatusCode::CREATED, Json(created)).into_response()
        }
        Err(e) => store_error(e),
    }
}

async fn revoke(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Ok(id) = id.parse::<i64>() else {
        return bad(StatusCode::BAD_REQUEST, "token id must be a number");
    };
    let now = chrono::Utc::now().timestamp_millis();
    match s.ingest_tokens.revoke(id, now) {
        Ok(Some(t)) => {
            tracing::info!(id, by = v.user.id, "ingest token revoked");
            Json(t).into_response()
        }
        Ok(None) => bad(StatusCode::NOT_FOUND, "no such token"),
        Err(e) => store_error(e),
    }
}

async fn restore(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Ok(id) = id.parse::<i64>() else {
        return bad(StatusCode::BAD_REQUEST, "token id must be a number");
    };
    let now = chrono::Utc::now().timestamp_millis();
    match s.ingest_tokens.restore(id, now) {
        Ok(Restore::Restored(t)) => {
            tracing::info!(id, by = v.user.id, "ingest token restored (undo revoke)");
            Json(t).into_response()
        }
        Ok(Restore::TooLate) => bad(
            StatusCode::CONFLICT,
            "too late to undo: revoked more than a minute ago",
        ),
        Ok(Restore::NotFound) => bad(StatusCode::NOT_FOUND, "no such token"),
        Err(e) => store_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Hub;
    use crate::pipeline::Pipeline;
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    async fn call(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn create_list_revoke() {
        let st = AppState::new(
            Pipeline::new(Arc::new(MemoryStore::new(10)), Hub::new()),
            Arc::new(Mutex::new(DockerStatus::Disabled)),
        )
        .auth_off();
        let app = crate::api::router(st);
        let post = |b: &str| {
            Request::post("/api/ingest-tokens")
                .header("content-type", "application/json")
                .body(Body::from(b.to_string()))
                .unwrap()
        };
        let (s, v) = call(&app, post(r#"{"name":"  vector · edge ","source":" "}"#)).await;
        assert_eq!(s, StatusCode::CREATED);
        assert!(v["secret"].as_str().unwrap().starts_with("qi_"));
        assert_eq!(v["token"]["name"], "vector · edge");
        assert_eq!(v["token"]["source"], serde_json::Value::Null);
        let id = v["token"]["id"].as_i64().unwrap();

        let (s, _) = call(&app, post(r#"{"name":""}"#)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _) = call(&app, post("nope")).await;
        assert!(s.is_client_error());

        let (s, v) = call(
            &app,
            Request::get("/api/ingest-tokens")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["tokens"].as_array().unwrap().len(), 1);
        assert!(
            v.to_string().find("secret").is_none(),
            "the list never carries a secret"
        );

        let del = |p: String| Request::delete(p).body(Body::empty()).unwrap();
        let (s, v) = call(&app, del(format!("/api/ingest-tokens/{id}"))).await;
        assert_eq!(s, StatusCode::OK);
        assert!(v["revoked"].as_i64().is_some());
        let (s, _) = call(&app, del("/api/ingest-tokens/999".into())).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(&app, del("/api/ingest-tokens/x".into())).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // Undo within the window brings it back.
        let restore = |p: String| Request::post(p).body(Body::empty()).unwrap();
        let (s, v) = call(&app, restore(format!("/api/ingest-tokens/{id}/restore"))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["revoked"], serde_json::Value::Null);
        let (s, _) = call(&app, restore("/api/ingest-tokens/999/restore".into())).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(&app, restore("/api/ingest-tokens/x/restore".into())).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn restore_after_the_window_is_409() {
        let st = AppState::new(
            Pipeline::new(Arc::new(MemoryStore::new(10)), Hub::new()),
            Arc::new(Mutex::new(DockerStatus::Disabled)),
        )
        .auth_off();
        let c = st.ingest_tokens.create("old", None, 0).unwrap();
        // Revoked long ago (well before now).
        st.ingest_tokens.revoke(c.token.id, 1_000).unwrap();
        let app = crate::api::router(st);
        let (s, v) = call(
            &app,
            Request::post(format!("/api/ingest-tokens/{}/restore", c.token.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert!(v["error"].as_str().unwrap().contains("too late"));
    }
}
