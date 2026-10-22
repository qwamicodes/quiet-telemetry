//! HTTP NDJSON ingest: Vector `http` sink (json/ndjson), Fluent Bit `http`
//! output (json_lines), or plain `curl`.
//!
//! POST /ingest/ndjson   header X-Quiet-Source: <name>   one JSON or text line per row

use super::Receiver;
use crate::hub::SourceKind;
use crate::pipeline::{Pipeline, RawLine};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;

pub struct NdjsonReceiver {
    pipeline: Arc<Pipeline>,
}

impl NdjsonReceiver {
    pub fn new(pipeline: Arc<Pipeline>) -> Self {
        NdjsonReceiver { pipeline }
    }
}

#[async_trait::async_trait]
impl Receiver for NdjsonReceiver {
    fn name(&self) -> &'static str {
        "http-ndjson"
    }

    fn routes(&self) -> Router {
        Router::new()
            .route("/ingest/ndjson", post(ingest))
            .with_state(self.pipeline.clone())
    }
}

/// Split a body into raw lines. Vector/Fluent Bit can also send one JSON
/// array per row; it is unwrapped into one line per item.
pub fn split_body(body: &str, source: &str, received: i64) -> Vec<RawLine> {
    let mut out = Vec::new();
    for raw in body.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if raw.starts_with('[') {
            if let Ok(serde_json::Value::Array(items)) =
                serde_json::from_str::<serde_json::Value>(raw)
            {
                out.extend(
                    items
                        .into_iter()
                        .map(|item| RawLine::new(item.to_string(), source, received)),
                );
                continue;
            }
        }
        out.push(RawLine::new(raw, source, received));
    }
    out
}

async fn ingest(State(p): State<Arc<Pipeline>>, headers: HeaderMap, body: Bytes) -> Response {
    let source = headers
        .get("x-quiet-source")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("http")
        .to_string();
    let received = chrono::Utc::now().timestamp_millis();
    let raws = split_body(&String::from_utf8_lossy(&body), &source, received);
    match p.ingest(SourceKind::Http, raws).await {
        Ok(lines) => (
            StatusCode::ACCEPTED,
            Json(json!({ "accepted": lines.len(), "source": source })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, %source, "ingest failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "store unavailable" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_rows_and_unwraps_arrays() {
        let raws = split_body(
            "{\"a\":1}\n\n  plain  \n[{\"msg\":\"x\"},{\"msg\":\"y\"}]\n[not json",
            "api",
            1,
        );
        let texts: Vec<_> = raws.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "{\"a\":1}",
                "plain",
                "{\"msg\":\"x\"}",
                "{\"msg\":\"y\"}",
                "[not json"
            ]
        );
    }
}
