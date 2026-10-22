//! Search and export over the stored window.
//!
//! GET  /api/search?q=&source=a,b&level=&since=&until=&id=&order=&cursor=&limit=&buckets=
//! GET  /api/export?<same filters>&format=ndjson|json|csv&gzip=1&mask=pii&raw=1&columns=a,b
//! POST /api/export/token  { "query": "<the export query string>" }  → qx_ token
//!
//! `/api/export` accepts `Authorization: Bearer qx_…` (from "Copy curl"): the
//! token must match the exact query it was issued for, works once, and lasts
//! 15 minutes. Without a header the export is open like the rest of the API
//! until accounts land (slice 5; quiet binds loopback until then).

use crate::api::AppState;
use crate::export::{canonical_query, ExportFormat, Formatter, TokenError, TOKEN_TTL_MS};
use crate::hub::Line;
use crate::normalize::{Level, LogLine};
use crate::search::{Bucket, Cursor, Order, SearchQuery, MAX_PAGE};
use axum::body::Body;
use axum::extract::{Query, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Write;
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search", get(search))
        .route("/api/export", get(export))
        .route("/api/export/token", post(issue_token))
}

/// Filters shared by search and export (the query string).
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
pub struct SearchParams {
    /// Free text plus `key:value` filters (see `search.rs`).
    #[ts(optional)]
    pub q: Option<String>,
    /// Comma-separated source names; empty = all.
    #[ts(optional)]
    pub source: Option<String>,
    /// Minimum level.
    #[ts(optional)]
    pub level: Option<String>,
    /// Event time bounds, unix ms, inclusive.
    #[ts(optional)]
    pub since: Option<i64>,
    #[ts(optional)]
    pub until: Option<i64>,
    /// A correlation id (any key).
    #[ts(optional)]
    pub id: Option<String>,
    #[ts(optional)]
    pub order: Option<Order>,
    #[ts(optional)]
    pub cursor: Option<String>,
    #[ts(optional)]
    pub limit: Option<usize>,
    /// Histogram bars for the first page (max 240).
    #[ts(optional)]
    pub buckets: Option<usize>,
}

impl SearchParams {
    pub fn to_query(&self, default_order: Order) -> Result<SearchQuery, String> {
        let mut q = SearchQuery::default().parse_q(self.q.as_deref().unwrap_or(""));
        if let Some(s) = &self.source {
            q.sources.extend(
                s.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            );
        }
        if let Some(l) = self.level.as_deref().filter(|l| !l.is_empty()) {
            q.min_level = Some(Level::parse_name(l).ok_or_else(|| format!("unknown level `{l}`"))?);
        }
        if let Some(id) = self.id.as_deref().filter(|i| !i.is_empty()) {
            q.ids.push(id.to_string());
        }
        q.since = self.since;
        q.until = self.until;
        q.order = self.order.unwrap_or(default_order);
        q.cursor = match self.cursor.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => Some(Cursor::decode(c).ok_or("bad cursor")?),
            None => None,
        };
        q.limit = self.limit.unwrap_or(200).clamp(1, MAX_PAGE);
        q.histogram = self.buckets.map(|b| b.clamp(1, 240));
        Ok(q)
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SearchResponse {
    #[ts(as = "Vec<LogLine>")]
    pub lines: Vec<Line>,
    /// Pass back as `cursor` for the next page; null on the last page.
    pub next_cursor: Option<String>,
    /// Matches in the whole range (first page, when `buckets` is set).
    pub total: Option<u64>,
    /// Raw bytes of those matches (export size estimate).
    pub bytes: Option<u64>,
    pub histogram: Option<Vec<Bucket>>,
    /// Lines stored in the hours that were searched.
    pub searched: u64,
    pub took_ms: u64,
    /// The range searched (the window when none was given), unix ms.
    pub since: i64,
    pub until: i64,
}

fn bad(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn unavailable(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "store read failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "store unavailable" })),
    )
        .into_response()
}

/// Missing bounds default to the retention window ending now.
fn bound(s: &AppState, q: &mut SearchQuery) {
    let now = chrono::Utc::now().timestamp_millis();
    q.until.get_or_insert(now);
    q.since.get_or_insert(now - s.retention_ms);
}

async fn search(State(s): State<AppState>, Query(p): Query<SearchParams>) -> Response {
    let started = std::time::Instant::now();
    let mut q = match p.to_query(Order::Newest) {
        Ok(q) => q,
        Err(e) => return bad(e),
    };
    bound(&s, &mut q);
    match s.pipeline.store().search(&q).await {
        Ok(page) => Json(SearchResponse {
            lines: page.lines,
            next_cursor: page.next_cursor.map(|c| c.encode()),
            total: page.total,
            bytes: page.bytes,
            histogram: page.histogram,
            searched: page.searched,
            took_ms: started.elapsed().as_millis() as u64,
            since: q.since.unwrap_or_default(),
            until: q.until.unwrap_or_default(),
        })
        .into_response(),
        Err(e) => unavailable(e),
    }
}

/// Export-only options (the rest of the query string is [`SearchParams`]).
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
pub struct ExportParams {
    #[ts(optional)]
    pub format: Option<ExportFormat>,
    /// `1`/`true` gzips the file.
    #[ts(optional)]
    pub gzip: Option<String>,
    /// `pii` (or `1`/`true`) masks email, phone, name, IP and user-agent fields.
    #[ts(optional)]
    pub mask: Option<String>,
    /// `1`/`true` adds the raw line.
    #[ts(optional)]
    pub raw: Option<String>,
    /// CSV columns, comma-separated, in order.
    #[ts(optional)]
    pub columns: Option<String>,
}

fn on(v: &Option<String>) -> bool {
    matches!(
        v.as_deref().map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on" | "pii")
    )
}

/// What to name the file: one source's name, else `search`.
fn file_name(p: &SearchQuery, fmt: ExportFormat, gzip: bool) -> String {
    let label = match p.sources.as_slice() {
        [one] => one
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect(),
        _ => "search".to_string(),
    };
    let day = chrono::Utc::now().format("%Y-%m-%d");
    format!(
        "quiet-{label}-{day}.{}{}",
        fmt.ext(),
        if gzip { ".gz" } else { "" }
    )
}

async fn export(
    State(s): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
    Query(p): Query<SearchParams>,
    Query(e): Query<ExportParams>,
) -> Response {
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        let token = auth
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| t.starts_with("qx_"));
        let Some(token) = token else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "export needs a qx_ token" })),
            )
                .into_response();
        };
        let now = chrono::Utc::now().timestamp_millis();
        if let Err(err) = s
            .tokens
            .redeem(token, raw_query.as_deref().unwrap_or(""), now)
        {
            let msg = match err {
                TokenError::Unknown => "unknown token",
                TokenError::Expired => "token expired; copy a new curl",
                TokenError::WrongQuery => "token was issued for a different query",
            };
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": msg }))).into_response();
        }
    }

    let mut q = match p.to_query(Order::Oldest) {
        Ok(q) => q,
        Err(e) => return bad(e),
    };
    bound(&s, &mut q);
    q.limit = MAX_PAGE;
    q.histogram = None;
    let format = e.format.unwrap_or_default();
    let gzip = on(&e.gzip);
    let fmt = Formatter {
        format,
        mask: on(&e.mask),
        raw: on(&e.raw),
        columns: e
            .columns
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(String::from)
            .collect(),
    };
    let name = file_name(&q, format, gzip);
    // Lines appended a moment ago should be in the file.
    if let Err(e) = s.pipeline.store().flush().await {
        return unavailable(e);
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let store = s.pipeline.store().clone();
    tokio::spawn(async move {
        let mut out = Sink::new(gzip);
        out.push(fmt.header().as_bytes());
        let mut first = true;
        loop {
            let page = match store.search(&q).await {
                Ok(p) => p,
                Err(err) => {
                    tracing::error!(error = %err, "export read failed");
                    let _ = tx
                        .send(Err(std::io::Error::other("store read failed")))
                        .await;
                    return;
                }
            };
            for l in &page.lines {
                out.push(fmt.line(l, first).as_bytes());
                first = false;
            }
            if tx.send(Ok(out.take())).await.is_err() {
                return; // client went away
            }
            match page.next_cursor {
                Some(c) => q.cursor = Some(c),
                None => break,
            }
        }
        out.push(fmt.footer(!first).as_bytes());
        let _ = tx.send(Ok(out.finish())).await;
    });

    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    let content_type = if gzip {
        "application/gzip"
    } else {
        format.content_type()
    };
    let mut res = Response::new(body);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Bytes out, gzipped on the fly when asked.
struct Sink {
    gz: Option<GzEncoder<Vec<u8>>>,
    buf: Vec<u8>,
}

impl Sink {
    fn new(gzip: bool) -> Self {
        Sink {
            gz: gzip.then(|| GzEncoder::new(Vec::new(), Compression::default())),
            buf: Vec::new(),
        }
    }

    fn push(&mut self, b: &[u8]) {
        match &mut self.gz {
            Some(gz) => gz.write_all(b).expect("writing to a Vec"),
            None => self.buf.extend_from_slice(b),
        }
    }

    fn take(&mut self) -> Bytes {
        match &mut self.gz {
            Some(gz) => Bytes::from(std::mem::take(gz.get_mut())),
            None => Bytes::from(std::mem::take(&mut self.buf)),
        }
    }

    fn finish(self) -> Bytes {
        match self.gz {
            Some(gz) => Bytes::from(gz.finish().expect("writing to a Vec")),
            None => Bytes::from(self.buf),
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ExportTokenRequest {
    /// The export query string the token is for (no leading `?`).
    pub query: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ExportTokenResponse {
    /// `qx_…`, shown once. Read-only, this query only, reusable for 15 minutes.
    pub token: String,
    /// Unix ms.
    pub expires_at: i64,
    /// `/api/export?<canonical query>`; the server's origin goes in front.
    pub path: String,
}

async fn issue_token(State(s): State<AppState>, Json(r): Json<ExportTokenRequest>) -> Response {
    // Validate now so a broken curl never gets a token.
    let parsed = (
        serde_urlencoded::from_str::<SearchParams>(&r.query),
        serde_urlencoded::from_str::<ExportParams>(&r.query),
    );
    match parsed {
        (Ok(p), Ok(_)) => {
            if let Err(e) = p.to_query(Order::Oldest) {
                return bad(e);
            }
        }
        (Err(e), _) | (_, Err(e)) => return bad(e.to_string()),
    }
    let now = chrono::Utc::now().timestamp_millis();
    let (token, expires_at) = s.tokens.issue(&r.query, now);
    debug_assert_eq!(expires_at - now, TOKEN_TTL_MS);
    Json(ExportTokenResponse {
        token,
        expires_at,
        path: format!("/api/export?{}", canonical_query(&r.query)),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::io::Read;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    async fn app() -> (AppState, Router) {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(1000)), Hub::new());
        let st = AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled)));
        let now = chrono::Utc::now().timestamp_millis();
        let raws = [
            (
                r#"{"level":40,"msg":"GET /dealers/88 slow","request_id":"req_1","status":200,"email":"a@b.co"}"#,
                "api",
            ),
            (
                r#"{"level":30,"msg":"GET /health","request_id":"req_2","status":200}"#,
                "api",
            ),
            (
                r#"{"level":50,"msg":"payout failed","job_id":"payout:88","data":{"request_id":"req_1"}}"#,
                "worker",
            ),
        ];
        for (i, (raw, src)) in raws.iter().enumerate() {
            let mut r = RawLine::new(*raw, *src, now - 1000 + i as i64);
            r.collector_ts = None;
            st.pipeline.ingest(SourceKind::Http, [r]).await.unwrap();
        }
        let app = crate::api::router(st.clone());
        (st, app)
    }

    async fn get(app: &Router, uri: &str, auth: Option<&str>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = Request::get(uri);
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (parts, body) = res.into_parts();
        (
            parts.status,
            parts.headers,
            body.collect().await.unwrap().to_bytes().to_vec(),
        )
    }

    #[tokio::test]
    async fn search_pages_with_histogram_and_filters() {
        let (_, app) = app().await;
        let (st, _, body) = get(
            &app,
            "/api/search?q=request_id:req_1&limit=1&buckets=10",
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["lines"][0]["msg"], "payout failed");
        assert_eq!(v["total"], 2);
        assert_eq!(v["histogram"].as_array().unwrap().len(), 10);
        let cursor = v["next_cursor"].as_str().unwrap().to_string();
        let (_, _, body) = get(
            &app,
            &format!("/api/search?q=request_id:req_1&limit=1&cursor={cursor}"),
            None,
        )
        .await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["lines"][0]["display_id"]["value"], "req_1");
        assert!(v["next_cursor"].is_null());
        assert!(v["total"].is_null());

        let (_, _, body) = get(&app, "/api/search?source=api&level=warn", None).await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["lines"].as_array().unwrap().len(), 1);
        assert_eq!(
            get(&app, "/api/search?cursor=zzz", None).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(&app, "/api/search?level=loud", None).await.0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn export_formats_gzip_and_mask() {
        let (_, app) = app().await;
        let (st, h, body) = get(&app, "/api/export?source=api", None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(h["content-type"], "application/x-ndjson");
        assert!(h["content-disposition"]
            .to_str()
            .unwrap()
            .contains("quiet-api-"));
        let text = String::from_utf8(body).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().next().unwrap().contains("a@b.co")); // oldest first, raw

        let (_, h, body) = get(
            &app,
            "/api/export?format=csv&mask=pii&gzip=1&columns=level,request_id,email",
            None,
        )
        .await;
        assert_eq!(h["content-type"], "application/gzip");
        assert!(h["content-disposition"]
            .to_str()
            .unwrap()
            .ends_with(".csv.gz\""));
        let mut csv = String::new();
        flate2::read::GzDecoder::new(&body[..])
            .read_to_string(&mut csv)
            .unwrap();
        assert_eq!(
            csv,
            "level,request_id,email\r\nwarn,req_1,[masked]\r\ninfo,req_2,\r\nerror,req_1,\r\n"
        );

        let (_, _, body) = get(&app, "/api/export?format=json&q=payout", None).await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["job_id"], "payout:88");
    }

    #[tokio::test]
    async fn copy_curl_token_is_read_only_scoped_and_reusable() {
        let (_, app) = app().await;
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/export/token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"query":"source=api&format=ndjson"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let token = v["token"].as_str().unwrap();
        assert!(token.starts_with("qx_"));
        assert_eq!(v["path"], "/api/export?format=ndjson&source=api");
        let bearer = format!("Bearer {token}");

        // A different query is refused.
        assert_eq!(
            get(&app, "/api/export?source=worker", Some(&bearer))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let (st, _, body) = get(&app, "/api/export?format=ndjson&source=api", Some(&bearer)).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(String::from_utf8(body).unwrap().lines().count(), 2);
        // Reusable within its 15 minutes.
        assert_eq!(
            get(&app, "/api/export?format=ndjson&source=api", Some(&bearer))
                .await
                .0,
            StatusCode::OK
        );
        // Not a qx_ token (e.g. an ingest token): refused.
        assert_eq!(
            get(&app, "/api/export?source=api", Some("Bearer qi_x"))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        // A bad query never gets a token.
        let res = app
            .oneshot(
                Request::post("/api/export/token")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"query":"level=loud"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }
}
