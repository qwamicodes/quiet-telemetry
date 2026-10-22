//! The web UI, compiled into the binary.
//!
//! `web/dist` is embedded at build time (release) or read from disk (debug),
//! so `quiet` ships as one file. Hashed files under `/assets/` are cached for
//! a year; everything else revalidates by ETag. Unknown paths without a file
//! extension get `index.html` so client-side routes (`/flow/:id`) deep-link.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use rust_embed::RustEmbed;
use std::path::PathBuf;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

#[derive(RustEmbed)]
// Relative to server/Cargo.toml.
#[folder = "../web/dist"]
#[allow_missing = true]
struct Assets;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const REVALIDATE: &str = "no-cache";

/// Attach the UI as the router's fallback. `dir` overrides the embedded copy
/// (handy while working on the UI against a release binary).
pub fn attach(app: Router, dir: Option<PathBuf>) -> Router {
    if let Some(dir) = dir.filter(|d| d.join("index.html").exists()) {
        tracing::info!(dir = %dir.display(), "serving web ui from disk");
        let index = dir.join("index.html");
        return app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    if Assets::get("index.html").is_none() {
        tracing::warn!("web ui not built into this binary; run `bun run build` in web/");
    }
    app.fallback(serve).layer(CompressionLayer::new())
}

async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("ingest/") || path == "api" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    if !path.is_empty() {
        if let Some(file) = Assets::get(path) {
            return respond(path, file, &headers);
        }
        // A missing file is a 404, never index.html served as JS.
        let last = path.rsplit('/').next().unwrap_or(path);
        if last.contains('.') {
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
    }
    match Assets::get("index.html") {
        Some(index) => respond("index.html", index, &headers),
        None => not_built(),
    }
}

fn respond(path: &str, file: rust_embed::EmbeddedFile, headers: &HeaderMap) -> Response {
    let etag = format!("\"{}\"", hex(&file.metadata.sha256_hash()[..16]));
    let cache = if path.starts_with("assets/") {
        IMMUTABLE
    } else {
        REVALIDATE
    };
    let mut res = if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag))
    {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut r = Response::new(Body::from(file.data.into_owned()));
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(file.metadata.mimetype())
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        r
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    res
}

fn not_built() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><title>quiet</title><body style=\"font:14px ui-monospace,monospace;padding:2rem\">\
         <p>quiet is running, but this build has no web UI.</p>\
         <p>Build it with <code>cd web &amp;&amp; bun install &amp;&amp; bun run build</code>, then rebuild the server, \
         or use <code>bun run dev</code>.</p></body>",
    )
        .into_response()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app() -> Router {
        attach(Router::new(), None)
    }

    async fn get(path: &str, inm: Option<&str>) -> Response {
        let mut req = Request::get(path);
        if let Some(t) = inm {
            req = req.header(header::IF_NONE_MATCH, t);
        }
        app()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn spa_fallback_and_api_404() {
        let res = get("/flow/req_1", None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        assert_eq!(get("/api/nope", None).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            get("/assets/missing-abc.js", None).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn hashed_assets_are_immutable_and_etag_revalidates() {
        // Only meaningful when the UI was built before the server. CI builds it
        // first and sets QUIET_EXPECT_UI=1 so a broken embed fails loudly.
        let expect = std::env::var("QUIET_EXPECT_UI").is_ok_and(|v| v == "1");
        let Some(asset) = Assets::iter().find(|p| p.starts_with("assets/") && p.ends_with(".js"))
        else {
            assert!(!expect, "web/dist is not embedded");
            return;
        };
        let res = get(&format!("/{asset}"), None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CACHE_CONTROL], IMMUTABLE);
        assert!(res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        let etag = res.headers()[header::ETAG].to_str().unwrap().to_string();
        let res = get(&format!("/{asset}"), Some(&etag)).await;
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);

        let res = get("/", None).await;
        assert_eq!(res.headers()[header::CACHE_CONTROL], REVALIDATE);
    }
}
