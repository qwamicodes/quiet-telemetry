//! Ingest token management for the UI.
//!
//! GET    /api/ingest-tokens        → { tokens }
//! POST   /api/ingest-tokens        { name, source? } → { token, secret }   (201)
//! DELETE /api/ingest-tokens/:id    → the revoked token
//!
//! Open until accounts land (slice 5), like the rest of `/api`: whoever can
//! reach the UI can mint a token. Keep quiet on loopback (the default) or
//! behind an authenticating proxy until then.

use crate::api::AppState;
use crate::tokens::{CreateIngestToken, IngestTokensResponse};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde_json::json;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/ingest-tokens", get(list).post(create))
        .route("/api/ingest-tokens/:id", delete(revoke))
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

async fn create(State(s): State<AppState>, body: Option<Json<CreateIngestToken>>) -> Response {
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
            tracing::info!(id = created.token.id, name, source = ?source, "ingest token created");
            (StatusCode::CREATED, Json(created)).into_response()
        }
        Err(e) => store_error(e),
    }
}

async fn revoke(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(id) = id.parse::<i64>() else {
        return bad(StatusCode::BAD_REQUEST, "token id must be a number");
    };
    let now = chrono::Utc::now().timestamp_millis();
    match s.ingest_tokens.revoke(id, now) {
        Ok(Some(t)) => {
            tracing::info!(id, "ingest token revoked");
            Json(t).into_response()
        }
        Ok(None) => bad(StatusCode::NOT_FOUND, "no such token"),
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
        );
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
    }
}
