//! Server-side preparation for very large exports (board v0.1-05.7/05.8).
//!
//! POST   /api/export/jobs                { "query": "<export query string>" } → 202 ExportJob
//! GET    /api/export/jobs/:id            → ExportJob (poll for progress)
//! GET    /api/export/jobs/:id/download   → the file, once `ready`
//! DELETE /api/export/jobs/:id            → cancel (or discard a ready file)
//!
//! Over ~100k lines (the UI's `LARGE` in `export-dialog.tsx`) the export dialog asks the server
//! to write the file first instead of streaming it into the browser. The
//! query string is the same one `/api/export` takes, so filters, format,
//! columns, gzip and masking mean the same thing.
//!
//! Rules:
//! - A session is required; a `qx_` token never works here (tokens stay
//!   read-only on `GET /api/export` for the one query they were issued for).
//! - Members always get PII masked, whatever the query says.
//! - A job belongs to the user who started it: anyone else gets 404.
//! - The range is fixed when the job starts (`until` = now), and the
//!   retention window does not expire lines while a job is preparing, so
//!   lines that would expire meanwhile are still included. The disk cap still
//!   applies (it protects the host).
//! - Files live in `<data dir>/exports` (a temp dir without one), are deleted
//!   on cancel, on failure, an hour after they are ready, and at startup.
//! - At most [`MAX_ACTIVE`] jobs prepare at once ([`MAX_PER_USER`] per user).

use crate::api::AppState;
use crate::auth::Viewer;
use crate::export::Formatter;
use crate::search::SearchQuery;
use crate::search_api::{content_type, plan, ExportParams, Plan, SearchParams};
use crate::store::Store;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use bytes::Bytes;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// A ready file is kept this long, ms.
pub const JOB_TTL_MS: i64 = 60 * 60_000;
pub const MAX_ACTIVE: usize = 4;
pub const MAX_PER_USER: usize = 2;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/export/jobs", post(create))
        .route("/api/export/jobs/:id", get(status).delete(cancel))
        .route("/api/export/jobs/:id/download", get(download))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ExportJobState {
    Preparing,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ExportJobRequest {
    /// The export query string (as for `/api/export`, no leading `?`).
    pub query: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ExportJob {
    pub id: String,
    pub state: ExportJobState,
    /// Lines written so far.
    pub done: u64,
    /// Lines that match (counted when the job started).
    pub total: u64,
    /// Bytes written so far (the file size once ready).
    pub bytes: u64,
    pub file_name: String,
    /// Unix ms.
    pub started: i64,
    pub finished: Option<i64>,
    /// Rough time left, ms, while preparing (from the pace so far).
    pub eta_ms: Option<i64>,
    /// When a ready file is deleted, unix ms.
    pub expires_at: Option<i64>,
    /// PII masked in the file.
    pub masked: bool,
    pub error: Option<String>,
}

struct Job {
    owner: i64,
    path: PathBuf,
    content_type: &'static str,
    cancel: CancellationToken,
    info: Mutex<ExportJob>,
}

impl Job {
    fn snapshot(&self, now: i64) -> ExportJob {
        let mut j = self.info.lock().unwrap().clone();
        if j.state == ExportJobState::Preparing && j.done > 0 && j.total > j.done {
            let spent = (now - j.started).max(1);
            j.eta_ms = Some(spent * (j.total - j.done) as i64 / j.done as i64);
        }
        j
    }
}

/// The running and finished jobs, plus the hold the retention job reads.
pub struct ExportJobs {
    dir: PathBuf,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    /// > 0 while a job is preparing: retention skips window expiry.
    hold: Arc<AtomicUsize>,
}

impl ExportJobs {
    /// Files under `dir` (created; leftovers from an earlier run are removed).
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("job-") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        ExportJobs {
            dir,
            jobs: Mutex::new(HashMap::new()),
            hold: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// A private temp directory (no data dir: tests, `--store memory` setups).
    pub fn temp() -> Self {
        let r: u64 = rand::random();
        Self::new(std::env::temp_dir().join(format!("quiet-exports-{r:016x}")))
    }

    /// Read by the retention job.
    pub fn hold(&self) -> Arc<AtomicUsize> {
        self.hold.clone()
    }

    fn get(&self, id: &str, owner: i64) -> Option<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap()
            .get(id)
            .filter(|j| j.owner == owner)
            .cloned()
    }

    /// Drop expired ready files and old finished jobs.
    fn sweep(&self, now: i64) {
        let mut map = self.jobs.lock().unwrap();
        map.retain(|_, j| {
            let i = j.info.lock().unwrap();
            let keep = match i.state {
                ExportJobState::Preparing => true,
                ExportJobState::Ready => i.expires_at.is_some_and(|e| e > now),
                _ => i.finished.is_some_and(|f| f + JOB_TTL_MS > now),
            };
            if !keep {
                let _ = std::fs::remove_file(&j.path);
            }
            keep
        });
    }

    fn preparing(&self, owner: Option<i64>) -> usize {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| owner.is_none_or(|o| j.owner == o))
            .filter(|j| j.info.lock().unwrap().state == ExportJobState::Preparing)
            .count()
    }
}

impl Drop for ExportJobs {
    fn drop(&mut self) {
        for j in self.jobs.get_mut().unwrap().values() {
            j.cancel.cancel();
            let _ = std::fs::remove_file(&j.path);
        }
    }
}

fn err(status: StatusCode, code: &str, msg: &str) -> Response {
    crate::auth::error(status, code, msg)
}

fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "not_found", "no such export")
}

async fn create(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Json(r): Json<ExportJobRequest>,
) -> Response {
    let (p, e) = match (
        serde_urlencoded::from_str::<SearchParams>(&r.query),
        serde_urlencoded::from_str::<ExportParams>(&r.query),
    ) {
        (Ok(p), Ok(e)) => (p, e),
        (Err(e), _) | (_, Err(e)) => {
            return err(StatusCode::BAD_REQUEST, "bad_query", &e.to_string())
        }
    };
    let Plan {
        mut q,
        fmt,
        name,
        gzip,
        format,
    } = match plan(&s, p, &e, !v.is_owner()) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, "bad_query", &e),
    };
    let now = chrono::Utc::now().timestamp_millis();
    let jobs = s.exports.clone();
    jobs.sweep(now);
    if jobs.preparing(None) >= MAX_ACTIVE || jobs.preparing(Some(v.user.id)) >= MAX_PER_USER {
        return err(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_exports",
            "other exports are still being prepared; try again when one finishes",
        );
    }
    if let Err(e) = s.pipeline.store().flush().await {
        tracing::error!(error = %e, "store flush failed");
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "store unavailable",
        );
    }
    // Count first so progress has a denominator.
    let mut count = q.clone();
    count.limit = 1;
    count.histogram = Some(1);
    let total = match s.pipeline.store().search(&count).await {
        Ok(p) => p.total.unwrap_or(0),
        Err(e) => {
            tracing::error!(error = %e, "export count failed");
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "store unavailable",
            );
        }
    };
    q.cursor = None;

    let bytes: [u8; 12] = rand::random();
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let info = ExportJob {
        id: id.clone(),
        state: ExportJobState::Preparing,
        done: 0,
        total,
        bytes: 0,
        file_name: name,
        started: now,
        finished: None,
        eta_ms: None,
        expires_at: None,
        masked: fmt.mask,
        error: None,
    };
    let job = Arc::new(Job {
        owner: v.user.id,
        path: jobs.dir.join(format!("job-{id}")),
        content_type: content_type(format, gzip),
        cancel: CancellationToken::new(),
        info: Mutex::new(info),
    });
    jobs.jobs.lock().unwrap().insert(id, job.clone());
    let hold = HoldGuard::new(jobs.hold());
    let store = s.pipeline.store().clone();
    let snapshot = job.snapshot(now);
    tokio::spawn(async move {
        let _hold = hold;
        prepare(store, job, q, fmt, gzip).await;
    });
    (StatusCode::ACCEPTED, Json(snapshot)).into_response()
}

/// Keeps retention's window expiry off while a job prepares.
struct HoldGuard(Arc<AtomicUsize>);

impl HoldGuard {
    fn new(h: Arc<AtomicUsize>) -> Self {
        h.fetch_add(1, Ordering::SeqCst);
        HoldGuard(h)
    }
}

impl Drop for HoldGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

enum Out {
    Plain(BufWriter<std::fs::File>),
    Gz(GzEncoder<BufWriter<std::fs::File>>),
}

impl Out {
    fn write(&mut self, b: &[u8]) -> std::io::Result<()> {
        match self {
            Out::Plain(w) => w.write_all(b),
            Out::Gz(w) => w.write_all(b),
        }
    }

    fn finish(self) -> std::io::Result<()> {
        match self {
            Out::Plain(mut w) => w.flush(),
            Out::Gz(w) => w.finish()?.flush(),
        }
    }
}

/// Write every matching line to the job's file, oldest first.
async fn prepare(
    store: Arc<dyn Store>,
    job: Arc<Job>,
    mut q: SearchQuery,
    fmt: Formatter,
    gzip: bool,
) {
    let fail = |job: &Job, msg: &str| {
        let _ = std::fs::remove_file(&job.path);
        let mut i = job.info.lock().unwrap();
        if i.state == ExportJobState::Preparing {
            i.state = ExportJobState::Failed;
            i.error = Some(msg.to_string());
            i.finished = Some(chrono::Utc::now().timestamp_millis());
        }
    };
    let file = match std::fs::File::create(&job.path) {
        Ok(f) => f,
        Err(e) => {
            tracing::error!(error = %e, "export file create failed");
            return fail(&job, "could not write the export file");
        }
    };
    let w = BufWriter::new(file);
    let mut out = if gzip {
        Out::Gz(GzEncoder::new(w, Compression::default()))
    } else {
        Out::Plain(w)
    };
    let mut written: u64 = 0;
    let mut first = true;
    let header = fmt.header();
    if out.write(header.as_bytes()).is_err() {
        return fail(&job, "could not write the export file");
    }
    written += header.len() as u64;
    loop {
        if job.cancel.is_cancelled() {
            let _ = std::fs::remove_file(&job.path);
            return;
        }
        let page = match store.search(&q).await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "export read failed");
                return fail(&job, "store read failed");
            }
        };
        let mut chunk = String::new();
        for l in &page.lines {
            chunk.push_str(&fmt.line(l, first));
            first = false;
        }
        if out.write(chunk.as_bytes()).is_err() {
            return fail(&job, "could not write the export file (disk full?)");
        }
        written += chunk.len() as u64;
        {
            let mut i = job.info.lock().unwrap();
            i.done += page.lines.len() as u64;
            // Lines can arrive inside the range after the count (late timestamps).
            i.total = i.total.max(i.done);
            i.bytes = written;
        }
        match page.next_cursor {
            Some(c) => q.cursor = Some(c),
            None => break,
        }
        tokio::task::yield_now().await;
    }
    let footer = fmt.footer(!first);
    if out.write(footer.as_bytes()).is_err() || out.finish().is_err() {
        return fail(&job, "could not write the export file (disk full?)");
    }
    if job.cancel.is_cancelled() {
        let _ = std::fs::remove_file(&job.path);
        return;
    }
    let size = std::fs::metadata(&job.path).map(|m| m.len()).unwrap_or(0);
    let now = chrono::Utc::now().timestamp_millis();
    let mut i = job.info.lock().unwrap();
    i.state = ExportJobState::Ready;
    i.bytes = size;
    i.total = i.done;
    i.finished = Some(now);
    i.expires_at = Some(now + JOB_TTL_MS);
}

async fn status(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    let now = chrono::Utc::now().timestamp_millis();
    s.exports.sweep(now);
    match s.exports.get(&id, v.user.id) {
        Some(j) => Json(j.snapshot(now)).into_response(),
        None => not_found(),
    }
}

async fn cancel(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    let Some(j) = s.exports.get(&id, v.user.id) else {
        return not_found();
    };
    j.cancel.cancel();
    {
        let mut i = j.info.lock().unwrap();
        if i.state == ExportJobState::Preparing {
            i.state = ExportJobState::Cancelled;
            i.finished = Some(chrono::Utc::now().timestamp_millis());
        }
    }
    // A ready file is discarded; a preparing one is removed by its task.
    let _ = std::fs::remove_file(&j.path);
    s.exports.jobs.lock().unwrap().remove(&id);
    StatusCode::NO_CONTENT.into_response()
}

async fn download(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    let now = chrono::Utc::now().timestamp_millis();
    s.exports.sweep(now);
    let Some(j) = s.exports.get(&id, v.user.id) else {
        return not_found();
    };
    let info = j.snapshot(now);
    if info.state != ExportJobState::Ready {
        return err(
            StatusCode::CONFLICT,
            "not_ready",
            "the export is not ready yet",
        );
    }
    let file = match std::fs::File::open(&j.path) {
        Ok(f) => f,
        Err(_) => return not_found(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::task::spawn_blocking(move || {
        let mut file = file;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match file.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => {
                    if tx
                        .blocking_send(Ok(Bytes::copy_from_slice(&buf[..n])))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    return;
                }
            }
        }
    });
    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    let mut res = Response::new(body);
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(j.content_type),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(info.bytes));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", info.file_name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::Role;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::io::Read;
    use tower::ServiceExt;

    async fn state(n: usize) -> AppState {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100_000)), Hub::new());
        let st = AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled))).auth_off();
        let now = chrono::Utc::now().timestamp_millis();
        let lines: Vec<RawLine> = (0..n)
            .map(|i| {
                let raw = format!(
                    r#"{{"level":30,"msg":"order {i}","request_id":"req_{i}","email":"u{i}@ex.com"}}"#
                );
                let mut r = RawLine::new(raw, "api", now - 10_000 + i as i64);
                r.collector_ts = None;
                r
            })
            .collect();
        st.pipeline.ingest(SourceKind::Http, lines).await.unwrap();
        st
    }

    fn viewer(id: i64, role: Role) -> Viewer {
        let mut v = Viewer::local();
        v.user.id = id;
        v.user.role = role;
        v
    }

    /// The jobs router with a fixed viewer (the session gate's job in production).
    fn app(st: &AppState, v: Viewer) -> Router {
        routes().layer(axum::Extension(v)).with_state(st.clone())
    }

    async fn call(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let res = app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        (
            parts.status,
            parts.headers,
            body.collect().await.unwrap().to_bytes().to_vec(),
        )
    }
    use axum::http::HeaderMap;

    fn start(query: &str) -> Request<Body> {
        Request::post("/api/export/jobs")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({ "query": query }).to_string(),
            ))
            .unwrap()
    }

    async fn wait_ready(app: &Router, id: &str) -> serde_json::Value {
        for _ in 0..200 {
            let (st, _, body) = call(
                app,
                Request::get(format!("/api/export/jobs/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(st, StatusCode::OK);
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if v["state"] != "preparing" {
                return v;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("job never finished");
    }

    #[tokio::test]
    async fn prepares_the_file_with_progress_then_downloads_it_once_ready() {
        let st = state(2_500).await;
        let owner = app(&st, viewer(1, Role::Owner));
        let (code, _, body) = call(&owner, start("source=api&format=ndjson&gzip=1")).await;
        assert_eq!(code, StatusCode::ACCEPTED);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["total"], 2_500);
        assert_eq!(v["masked"], false);
        let id = v["id"].as_str().unwrap().to_string();
        let file = v["file_name"].as_str().unwrap();
        assert!(
            file.starts_with("quiet-api-") && file.ends_with(".ndjson.gz"),
            "{file}"
        );

        let done = wait_ready(&owner, &id).await;
        assert_eq!(done["state"], "ready");
        assert_eq!(done["done"], 2_500);
        assert!(done["expires_at"].as_i64().unwrap() > done["finished"].as_i64().unwrap());

        let (code, h, body) = call(
            &owner,
            Request::get(format!("/api/export/jobs/{id}/download"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(h["content-type"], "application/gzip");
        assert_eq!(h["content-length"], body.len().to_string().as_str());
        assert!(h["content-disposition"].to_str().unwrap().contains(file));
        let mut text = String::new();
        flate2::read::GzDecoder::new(&body[..])
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text.lines().count(), 2_500);
        assert!(
            text.lines().next().unwrap().contains("order 0"),
            "oldest first"
        );
        assert!(text.contains("u7@ex.com"), "owner asked for no masking");

        // Someone else cannot see or fetch it.
        let other = app(&st, viewer(2, Role::Owner));
        let (code, _, _) = call(
            &other,
            Request::get(format!("/api/export/jobs/{id}/download"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);

        // Discarding removes the file.
        let path = st.exports.get(&id, 1).unwrap().path.clone();
        assert!(path.exists());
        let (code, _, _) = call(
            &owner,
            Request::delete(format!("/api/export/jobs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(code, StatusCode::NO_CONTENT);
        assert!(!path.exists());
        assert_eq!(st.exports.hold().load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn members_always_get_pii_masked() {
        let st = state(20).await;
        let member = app(&st, viewer(5, Role::Member));
        let (code, _, body) = call(
            &member,
            start("source=api&format=csv&columns=request_id,email"),
        )
        .await;
        assert_eq!(code, StatusCode::ACCEPTED);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["masked"], true);
        let id = v["id"].as_str().unwrap().to_string();
        assert_eq!(wait_ready(&member, &id).await["state"], "ready");
        let (_, _, body) = call(
            &member,
            Request::get(format!("/api/export/jobs/{id}/download"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        let csv = String::from_utf8(body).unwrap();
        assert!(!csv.contains("@ex.com"), "{csv}");
        assert!(csv.contains("req_3,[masked]"));
    }

    #[tokio::test]
    async fn cancel_stops_the_job_and_removes_the_file_and_not_ready_is_a_conflict() {
        let st = state(5_000).await;
        let owner = app(&st, viewer(1, Role::Owner));
        let (_, _, body) = call(&owner, start("source=api")).await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let id = v["id"].as_str().unwrap().to_string();
        let job = st.exports.get(&id, 1).unwrap();
        // Download before it is ready (if it still prepares) is a conflict.
        if job.info.lock().unwrap().state == ExportJobState::Preparing {
            let (code, _, _) = call(
                &owner,
                Request::get(format!("/api/export/jobs/{id}/download"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert!(code == StatusCode::CONFLICT || code == StatusCode::OK);
        }
        let (code, _, _) = call(
            &owner,
            Request::delete(format!("/api/export/jobs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(code, StatusCode::NO_CONTENT);
        assert!(job.cancel.is_cancelled());
        for _ in 0..100 {
            if st.exports.hold().load(Ordering::SeqCst) == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(st.exports.hold().load(Ordering::SeqCst), 0);
        assert!(!job.path.exists());
        let (code, _, _) = call(
            &owner,
            Request::get(format!("/api/export/jobs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn bad_queries_and_too_many_jobs_are_refused() {
        let st = state(10).await;
        let owner = app(&st, viewer(1, Role::Owner));
        let (code, _, _) = call(&owner, start("level=loud")).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        // Two preparing jobs per user: fake them as still preparing.
        for _ in 0..MAX_PER_USER {
            let (code, _, body) = call(&owner, start("source=api")).await;
            assert_eq!(code, StatusCode::ACCEPTED);
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let j = st.exports.get(v["id"].as_str().unwrap(), 1).unwrap();
            j.cancel.cancel(); // stop the real work…
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let mut i = j.info.lock().unwrap();
            i.state = ExportJobState::Preparing; // …but count it as preparing
            i.finished = None;
        }
        let (code, _, _) = call(&owner, start("source=api")).await;
        assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
        // Another user still can.
        let other = app(&st, viewer(2, Role::Owner));
        let (code, _, _) = call(&other, start("source=api")).await;
        assert_eq!(code, StatusCode::ACCEPTED);
    }

    #[test]
    fn ready_files_expire_and_leftovers_are_cleared_at_startup() {
        let dir =
            std::env::temp_dir().join(format!("quiet-exports-test-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("job-old"), b"x").unwrap();
        std::fs::write(dir.join("keep.txt"), b"x").unwrap();
        let jobs = ExportJobs::new(dir.clone());
        assert!(!dir.join("job-old").exists());
        assert!(dir.join("keep.txt").exists());
        let path = dir.join("job-a");
        std::fs::write(&path, b"data").unwrap();
        let job = Arc::new(Job {
            owner: 1,
            path: path.clone(),
            content_type: "application/x-ndjson",
            cancel: CancellationToken::new(),
            info: Mutex::new(ExportJob {
                id: "a".into(),
                state: ExportJobState::Ready,
                done: 1,
                total: 1,
                bytes: 4,
                file_name: "f".into(),
                started: 0,
                finished: Some(10),
                eta_ms: None,
                expires_at: Some(10 + JOB_TTL_MS),
                masked: false,
                error: None,
            }),
        });
        jobs.jobs.lock().unwrap().insert("a".into(), job);
        jobs.sweep(10 + JOB_TTL_MS - 1);
        assert!(path.exists());
        jobs.sweep(10 + JOB_TTL_MS);
        assert!(!path.exists());
        assert!(jobs.get("a", 1).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
