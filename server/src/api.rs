//! HTTP + WebSocket API for the UI, plus process probes.
//!
//! GET  /health                      liveness (checks nothing external)
//! GET  /ready                       readiness (503 while shutting down)
//! GET  /api/health                  version, uptime, receiver status (UI footer)
//! GET  /api/sources
//! GET  /api/sources/:name/lines?limit=500
//! GET  /api/stream?source=api&backlog=500&levels=warn,error&q=text%20status:>=400   (WebSocket)
//! GET  /api/search, /api/export, POST /api/export/token       (see `search_api.rs`)
//! /api/export/jobs*  server-side preparing of large exports   (see `export_jobs.rs`)
//! GET  /api/flow, POST /api/flow-summaries                     (see `flow_api.rs`)
//! GET/POST /api/ingest-tokens, DELETE /api/ingest-tokens/:id   (see `tokens_api.rs`)
//! /api/auth/*, /api/account*, /api/members*, /api/invites*       (see `auth_api.rs`)
//!
//! Every `/api` route except the public auth routes needs a session (see
//! `auth.rs`); `/health` and `/ready` stay open. Ingest endpoints belong to
//! their receivers (see `receiver/`) and use `qi_` tokens.

use crate::accounts::Accounts;
use crate::auth::{AuthConfig, LoginLimiter, Viewer};
use crate::export::ExportTokens;
use crate::grouping::{CustomGroup, CustomGroups, GroupKind, GroupMode, Grouping};
use crate::hub::{Line, SourceInfo, SourceKind};
use crate::normalize::LogLine;
use crate::pipeline::Pipeline;
use crate::receiver::{DockerStatus, IngestConfig, IngestInfo};
use crate::store::{LineFilter, Query as StoreQuery};
use crate::tokens::IngestTokens;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

#[derive(Clone)]
pub struct AppState {
    pub pipeline: Arc<Pipeline>,
    pub docker: Arc<Mutex<DockerStatus>>,
    pub started: i64,
    /// False once shutdown begins, so a proxy stops routing here first.
    pub ready: Arc<AtomicBool>,
    /// Cancelled when the drain period ends; open streams close then.
    pub shutdown: CancellationToken,
    /// Read-only `qx_` export tokens (hashed, 15 min, reusable).
    pub tokens: Arc<ExportTokens>,
    /// Send-only `qi_` ingest tokens (hashed, persisted).
    pub ingest_tokens: Arc<IngestTokens>,
    /// How HTTP ingest is gated and limited (shown on the connect screens).
    pub ingest: IngestConfig,
    /// Users, sessions, invites, reset links.
    pub accounts: Arc<Accounts>,
    /// Sign-in on/off, cookie and proxy settings.
    pub auth: Arc<AuthConfig>,
    /// Failed sign-in backoff.
    pub limiter: Arc<LoginLimiter>,
    /// What the first-run page says about this host.
    pub host: HostInfo,
    /// Open live-stream websockets (Settings → About).
    pub live_clients: Arc<AtomicUsize>,
    /// Server-side preparing jobs for very large exports (05.7).
    pub exports: Arc<crate::export_jobs::ExportJobs>,
}

#[derive(Clone, Debug, Default)]
pub struct HostInfo {
    pub data_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(pipeline: Arc<Pipeline>, docker: Arc<Mutex<DockerStatus>>) -> Self {
        AppState {
            pipeline,
            docker,
            started: chrono::Utc::now().timestamp_millis(),
            ready: Arc::new(AtomicBool::new(true)),
            shutdown: CancellationToken::new(),
            tokens: Arc::new(ExportTokens::default()),
            ingest_tokens: Arc::new(IngestTokens::memory()),
            ingest: IngestConfig::default(),
            accounts: Arc::new(Accounts::memory()),
            auth: Arc::new(AuthConfig::default()),
            limiter: Arc::new(LoginLimiter::default()),
            host: HostInfo::default(),
            live_clients: Arc::new(AtomicUsize::new(0)),
            exports: Arc::new(crate::export_jobs::ExportJobs::temp()),
        }
    }

    pub fn with_accounts(mut self, accounts: Arc<Accounts>, auth: AuthConfig) -> Self {
        self.accounts = accounts;
        self.auth = Arc::new(auth);
        self
    }

    /// No sign-in (`QUIET_AUTH=off`; also what most handler tests use).
    #[cfg(test)]
    pub fn auth_off(mut self) -> Self {
        self.auth = Arc::new(AuthConfig::off());
        self
    }

    pub fn with_host(mut self, host: HostInfo) -> Self {
        self.host = host;
        self
    }

    pub fn with_exports(mut self, exports: Arc<crate::export_jobs::ExportJobs>) -> Self {
        self.exports = exports;
        self
    }

    pub fn with_ingest(mut self, tokens: Arc<IngestTokens>, config: IngestConfig) -> Self {
        self.ingest_tokens = tokens;
        self.ingest = config;
        self
    }

    /// How far back search and flows reach (the live retention window), ms.
    pub fn retention_ms(&self) -> i64 {
        self.pipeline.settings().retention_ms()
    }
}

pub fn router(state: AppState) -> Router {
    // Everything here needs a session (or a qx_ token on /api/export).
    let protected = Router::new()
        .route("/api/health", get(health))
        .route("/api/about", get(about))
        .route("/api/sources", get(sources))
        .route("/api/sources/grouping-preview", get(grouping_preview))
        .route("/api/sources/:name/lines", get(lines))
        .route("/api/stream", get(stream))
        .merge(crate::search_api::routes())
        .merge(crate::export_jobs::routes())
        .merge(crate::stream_api::routes())
        .merge(crate::lint::routes())
        .merge(crate::flow_api::routes())
        .merge(crate::tokens_api::routes())
        .merge(crate::settings_api::routes())
        .merge(crate::mute_api::routes())
        .merge(crate::source_groups_api::routes())
        .merge(crate::auth_api::session_routes())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::gate,
        ));
    // Setup, sign in, invite and reset links: no session, same-origin only.
    let public = crate::auth_api::public_routes().route_layer(middleware::from_fn_with_state(
        state.clone(),
        crate::auth::origin_gate,
    ));
    Router::new()
        .route("/health", get(live))
        .route("/ready", get(ready))
        .merge(public)
        .merge(protected)
        .with_state(state)
}

async fn live() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

async fn ready(State(s): State<AppState>) -> Response {
    if s.ready.load(Ordering::Relaxed) {
        Json(json!({ "ready": true })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ready": false, "reason": "shutting down" })),
        )
            .into_response()
    }
}

/// What the UI shows in its footer.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    /// Process start, unix ms.
    pub started: i64,
    pub docker: DockerStatus,
    /// Where lines are kept: `sqlite` or `memory`.
    pub store: String,
    /// How long lines stay searchable, ms.
    pub retention_ms: i64,
    /// Bytes on disk (0 for the memory store).
    pub disk_bytes: u64,
    /// Lines in the searchable window.
    pub stored_lines: u64,
    /// Oldest stored event time, unix ms.
    pub oldest: Option<i64>,
    /// HTTP ingest: auth mode, limits, whether remote shippers can reach it.
    pub ingest: IngestInfo,
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    let usage = s.pipeline.store().usage().await.unwrap_or_default();
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
        started: s.started,
        docker: s.docker.lock().unwrap().clone(),
        store: s.pipeline.store().kind().to_string(),
        retention_ms: s.retention_ms(),
        disk_bytes: usage.bytes,
        stored_lines: usage.lines,
        oldest: usage.oldest,
        ingest: s.ingest.info(s.ingest_tokens.active()),
    })
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SourcesResponse {
    pub sources: Vec<SourceInfo>,
    /// Custom groups made on the Sources page, in display order (above the
    /// automatic groups). Kept, and listed, when grouping is off too.
    pub custom_groups: Vec<CustomGroup>,
}

async fn sources(State(s): State<AppState>) -> Json<SourcesResponse> {
    let settings = s.pipeline.settings();
    let custom = settings.custom_groups();
    let per_source = settings.sources();
    let mut sources = s.pipeline.hub().list();
    for src in &mut sources {
        if let Some(st) = per_source.get(&src.name) {
            src.display_name = st.display_name.clone();
            src.hidden = st.hidden;
            src.paused = st.paused;
        }
        // No name of its own: the friendly label (`api · rch-prod`).
        if src.display_name.is_none() {
            src.display_name = src.meta.label.clone();
        }
    }
    apply_custom_groups(&mut sources, &custom);
    Json(SourcesResponse {
        sources,
        custom_groups: custom.groups,
    })
}

/// A source moved into a custom group shows under it instead of its
/// automatic group (kept in `auto_group` for "Automatic" and the "N moved to"
/// note). Grouping off (`group` is `null`): left flat.
pub fn apply_custom_groups(sources: &mut [SourceInfo], custom: &CustomGroups) {
    for src in sources {
        if src.meta.group_kind.is_none() {
            continue;
        }
        if let Some(g) = custom.group_for(&src.name) {
            src.meta.auto_group = src.meta.group.replace(g.name.clone());
            src.meta.auto_group_kind = src.meta.group_kind.replace(GroupKind::Manual);
            src.meta.group_id = Some(g.id.clone());
        }
    }
}

#[derive(Deserialize)]
struct PreviewQuery {
    mode: Option<GroupMode>,
    label: Option<String>,
}

/// One group in the Settings → Source grouping preview.
#[derive(Debug, Serialize, TS)]
pub struct PreviewGroup {
    pub name: String,
    pub kind: GroupKind,
    pub sources: Vec<String>,
}

/// `GET /api/sources/grouping-preview?mode=&label=`: how sources would group
/// (Settings → General, live as the owner types). Labels stay on the server.
#[derive(Debug, Serialize, TS)]
pub struct GroupingPreview {
    pub groups: Vec<PreviewGroup>,
    /// Docker sources carrying `label` (the "found on N of M" hint).
    #[ts(type = "number")]
    pub found: u64,
    #[ts(type = "number")]
    pub docker: u64,
    #[ts(type = "number")]
    pub total: u64,
}

async fn grouping_preview(
    State(s): State<AppState>,
    Query(q): Query<PreviewQuery>,
) -> Json<GroupingPreview> {
    let current = crate::grouping::current();
    let g = Grouping {
        mode: q.mode.unwrap_or(current.mode),
        label: q
            .label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or(current.label),
    };
    let custom = s.pipeline.settings().custom_groups();
    Json(preview(&s.pipeline.hub().labels(), &g, &custom))
}

pub fn preview(
    sources: &[(
        String,
        SourceKind,
        std::collections::HashMap<String, String>,
    )],
    g: &Grouping,
    custom: &CustomGroups,
) -> GroupingPreview {
    let mut sorted: Vec<_> = sources.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut groups: Vec<PreviewGroup> = Vec::new();
    for (name, kind, labels) in &sorted {
        if let Some((gname, gkind, _)) = g.place(name, *kind, labels, custom) {
            match groups
                .iter_mut()
                .find(|x| x.name == gname && x.kind == gkind)
            {
                Some(x) => x.sources.push(name.clone()),
                None => groups.push(PreviewGroup {
                    name: gname,
                    kind: gkind,
                    sources: vec![name.clone()],
                }),
            }
        }
    }
    // Custom groups first, in their own order; then projects and stacks by
    // name, then Standalone, then Ingest.
    let custom_at = |p: &PreviewGroup| {
        custom
            .groups
            .iter()
            .position(|c| p.kind == GroupKind::Manual && c.name == p.name)
            .unwrap_or(0)
    };
    let rank = |k: GroupKind| match k {
        GroupKind::Manual => 0,
        GroupKind::Standalone => 2,
        GroupKind::Ingest => 3,
        _ => 1,
    };
    groups.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then(custom_at(a).cmp(&custom_at(b)))
            .then(a.name.cmp(&b.name))
    });
    let docker: Vec<_> = sorted
        .iter()
        .filter(|s| s.1 == SourceKind::Docker)
        .collect();
    GroupingPreview {
        groups,
        found: docker
            .iter()
            .filter(|s| s.2.get(&g.label).is_some_and(|v| !v.trim().is_empty()))
            .count() as u64,
        docker: docker.len() as u64,
        total: sorted.len() as u64,
    }
}

#[derive(Deserialize)]
struct LinesQuery {
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct LinesResponse {
    #[ts(as = "Vec<LogLine>")]
    pub lines: Vec<Line>,
}

async fn lines(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<LinesQuery>,
) -> Response {
    if s.pipeline.hub().source(&name).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "unknown source" })),
        )
            .into_response();
    }
    let limit = q.limit.unwrap_or(500).min(10_000);
    match s.pipeline.store().tail(&name, limit).await {
        Ok(lines) => Json(LinesResponse { lines }).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "store read failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "store unavailable" })),
            )
                .into_response()
        }
    }
}

/// Query string of `/api/stream`.
#[derive(Deserialize, Clone, Default)]
pub struct Filter {
    pub source: String,
    pub backlog: Option<usize>,
    /// Minimum level; lines without a level are kept unless `level` is set.
    pub level: Option<String>,
    /// Exactly these level chips, comma-separated (`info,warn`).
    pub levels: Option<String>,
    /// Words, phrases and `key:value` filters (the search language).
    pub q: Option<String>,
}

impl Filter {
    fn line_filter(&self) -> LineFilter {
        LineFilter::with_levels(
            self.level.as_deref(),
            self.levels.as_deref(),
            self.q.as_deref(),
        )
    }

    #[cfg(test)]
    pub fn matches(&self, line: &Line) -> bool {
        self.line_filter().matches(line)
    }
}

/// One WebSocket message from `/api/stream`.
#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(rename = "Frame")]
pub enum Frame<'a> {
    /// Sent once on connect: the newest matching lines, oldest first.
    Backlog {
        #[ts(as = "Vec<LogLine>")]
        lines: Vec<&'a Line>,
    },
    /// New lines, batched every 75 ms.
    Lines {
        #[ts(as = "Vec<LogLine>")]
        lines: Vec<&'a Line>,
    },
    /// The client fell behind and `dropped` lines were skipped.
    Gap {
        #[ts(type = "number")]
        dropped: u64,
    },
    Error {
        message: String,
    },
}

async fn stream(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Query(f): Query<Filter>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        let clients = s.live_clients.clone();
        clients.fetch_add(1, Ordering::Relaxed);
        run_stream(socket, s, f, v.session_id).await;
        clients.fetch_sub(1, Ordering::Relaxed);
    })
}

/// `GET /api/about` (Settings → About, board 07.6).
#[derive(Debug, Serialize, TS)]
pub struct About {
    pub version: String,
    /// Git commit the binary was built from (`QUIET_GIT_SHA` at build time).
    pub commit: Option<String>,
    /// Build date (`QUIET_BUILD_DATE` at build time, `YYYY-MM-DD`).
    pub built: Option<String>,
    /// Process start, unix ms.
    pub started: i64,
    pub now: i64,
    /// `sqlite` or `memory`.
    pub store: String,
    /// The bundled SQLite library version.
    pub sqlite_version: String,
    /// Database size on disk, bytes.
    #[ts(type = "number")]
    pub db_bytes: u64,
    pub data_dir: Option<String>,
    /// Open live-stream connections.
    #[ts(type = "number")]
    pub live_clients: u64,
    /// People with an account.
    #[ts(type = "number")]
    pub members: u64,
    pub docker: DockerStatus,
}

async fn about(State(s): State<AppState>) -> Json<About> {
    let usage = s.pipeline.store().usage().await.unwrap_or_default();
    let members = s.accounts.members().map(|m| m.len() as u64).unwrap_or(0);
    Json(About {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: option_env!("QUIET_GIT_SHA")
            .filter(|c| !c.is_empty())
            .map(|c| c.chars().take(7).collect()),
        built: option_env!("QUIET_BUILD_DATE")
            .filter(|d| !d.is_empty())
            .map(String::from),
        started: s.started,
        now: chrono::Utc::now().timestamp_millis(),
        store: s.pipeline.store().kind().to_string(),
        sqlite_version: rusqlite::version().to_string(),
        db_bytes: usage.bytes,
        data_dir: s.host.data_dir.as_ref().map(|d| d.display().to_string()),
        live_clients: s.live_clients.load(Ordering::Relaxed) as u64,
        members,
        docker: s.docker.lock().unwrap().clone(),
    })
}

/// The newest `limit` lines of `source` matching `filter` in the window, oldest first.
async fn filtered_backlog(
    s: &AppState,
    source: &str,
    filter: &LineFilter,
    limit: usize,
) -> anyhow::Result<Vec<Line>> {
    let store = s.pipeline.store();
    store.flush().await?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut q = filter.query.clone().unwrap_or_default();
    q.sources = vec![source.to_string()];
    if filter.min_level.is_some() {
        q.min_level = filter.min_level;
    }
    q.since = Some(now - s.retention_ms());
    q.until = None;
    q.limit = limit.min(crate::search::MAX_PAGE);
    let mut lines = store.search(&q).await?.lines;
    lines.reverse();
    Ok(lines)
}

/// Batch window: lines arriving within it go out in one frame.
const BATCH: Duration = Duration::from_millis(75);
const MAX_BATCH: usize = 2000;
/// WebSocket close code 1012: service restart. The UI reconnects.
const CLOSE_RESTART: u16 = 1012;
/// Close code when the session behind a stream ends (signed out, removed,
/// expired). The UI shows "session expired" instead of reconnecting.
pub const CLOSE_SIGNED_OUT: u16 = 4401;
/// How often an open stream re-checks its session.
const SESSION_CHECK: Duration = Duration::from_secs(30);

async fn run_stream(mut ws: WebSocket, s: AppState, f: Filter, session: Option<i64>) {
    // Allow streaming a source before its first line arrives.
    let source = s.pipeline.hub().ensure_source(&f.source, SourceKind::Http);
    let filter = f.line_filter();
    // Subscribe before reading the backlog so nothing slips between the two.
    let mut rx = source.subscribe();

    let limit = f.backlog.unwrap_or(500).min(10_000);
    let backlog = if filter.is_empty() {
        s.pipeline
            .store()
            .query(&StoreQuery {
                source: f.source.clone(),
                filter: filter.clone(),
                limit,
                ..Default::default()
            })
            .await
    } else {
        // Filtered: the newest matches in the whole window, not just the
        // ring, so "98 of 1,284 lines match" shows all 98.
        filtered_backlog(&s, &f.source, &filter, limit).await
    }
    .unwrap_or_else(|e| {
        tracing::warn!(error = %e, "backlog read failed");
        Vec::new()
    });
    let last_sent = backlog.last().map(|l| l.id).unwrap_or(0);
    if send(
        &mut ws,
        &Frame::Backlog {
            lines: backlog.iter().collect(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let mut buf: Vec<Line> = Vec::new();
    let mut tick = tokio::time::interval(BATCH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut recheck = tokio::time::interval(SESSION_CHECK);
    recheck.tick().await; // the first tick is immediate; the gate just checked
    loop {
        tokio::select! {
            _ = recheck.tick(), if session.is_some() => {
                let (accounts, id) = (s.accounts.clone(), session.unwrap_or_default());
                let now = chrono::Utc::now().timestamp_millis();
                let alive = tokio::task::spawn_blocking(move || accounts.session_active(id, now))
                    .await
                    .unwrap_or(true);
                if !alive {
                    let _ = ws
                        .send(Message::Close(Some(CloseFrame {
                            code: CLOSE_SIGNED_OUT,
                            reason: "signed out".into(),
                        })))
                        .await;
                    return;
                }
            }
            msg = rx.recv() => match msg {
                Ok(line) => {
                    if line.id > last_sent && filter.matches(&line) {
                        buf.push(line);
                        if buf.len() >= MAX_BATCH && flush(&mut ws, &mut buf).await.is_err() {
                            return;
                        }
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    if flush(&mut ws, &mut buf).await.is_err() { return; }
                    if send(&mut ws, &Frame::Gap { dropped: n }).await.is_err() { return; }
                }
                Err(RecvError::Closed) => {
                    let _ = send(&mut ws, &Frame::Error { message: "source closed".into() }).await;
                    return;
                }
            },
            _ = tick.tick() => {
                if flush(&mut ws, &mut buf).await.is_err() { return; }
            }
            _ = s.shutdown.cancelled() => {
                let _ = flush(&mut ws, &mut buf).await;
                let _ = ws
                    .send(Message::Close(Some(CloseFrame {
                        code: CLOSE_RESTART,
                        reason: "server restarting".into(),
                    })))
                    .await;
                return;
            }
            incoming = ws.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {} // pings are answered by axum; filters change by reconnecting (for now)
            }
        }
    }
}

async fn flush(ws: &mut WebSocket, buf: &mut Vec<Line>) -> Result<(), axum::Error> {
    if buf.is_empty() {
        return Ok(());
    }
    let r = send(
        ws,
        &Frame::Lines {
            lines: buf.iter().collect(),
        },
    )
    .await;
    buf.clear();
    r
}

async fn send(ws: &mut WebSocket, frame: &Frame<'_>) -> Result<(), axum::Error> {
    let text = serde_json::to_string(frame).expect("frames serialize");
    ws.send(Message::Text(text)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Hub;
    use crate::pipeline::RawLine;
    use crate::receiver::{HttpReceiver, Receiver};
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> AppState {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new());
        AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled))).auth_off()
    }

    fn app(st: &AppState) -> Router {
        let open = IngestConfig {
            auth: crate::receiver::IngestAuth::Open,
            ..Default::default()
        };
        router(st.clone())
            .merge(HttpReceiver::new(st.pipeline.clone(), st.ingest_tokens.clone(), open).routes())
    }

    async fn json_of(res: Response) -> serde_json::Value {
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn ingest_then_read_back() {
        let st = state();
        let app = app(&st);
        let body = "{\"level\":40,\"msg\":\"slow\",\"request_id\":\"r1\"}\nplain text\n\n[{\"msg\":\"a\"},{\"msg\":\"b\"}]\n";
        let res = app
            .clone()
            .oneshot(
                Request::post("/ingest/ndjson")
                    .header("x-quiet-source", "api")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(json_of(res).await["accepted"], 4);

        let res = app
            .oneshot(
                Request::get("/api/sources/api/lines")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_of(res).await;
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["level"], "warn");
        assert_eq!(lines[0]["display_id"]["key"], "request_id");
        assert_eq!(lines[0]["display_id"]["value"], "r1");
        assert_eq!(lines[3]["msg"], "b");
    }

    #[test]
    fn grouping_preview_groups_by_the_draft_label() {
        use crate::grouping::GroupMode;
        let l = |p: &[(&str, &str)]| {
            p.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<std::collections::HashMap<_, _>>()
        };
        let src = vec![
            (
                "api".to_string(),
                SourceKind::Docker,
                l(&[
                    ("quiet.group", "platform"),
                    (crate::grouping::COMPOSE_PROJECT, "apps"),
                ]),
            ),
            (
                "worker".to_string(),
                SourceKind::Docker,
                l(&[(crate::grouping::COMPOSE_PROJECT, "apps")]),
            ),
            ("redis".to_string(), SourceKind::Docker, l(&[])),
            ("cron".to_string(), SourceKind::Fluentbit, l(&[])),
        ];
        let g = Grouping {
            mode: GroupMode::Label,
            label: "quiet.group".into(),
        };
        let p = preview(&src, &g, &CustomGroups::default());
        let names: Vec<_> = p
            .groups
            .iter()
            .map(|g| (g.name.as_str(), g.sources.len()))
            .collect();
        assert_eq!(
            names,
            vec![("platform", 1), ("Standalone", 2), ("Ingest", 1)]
        );
        assert_eq!((p.found, p.docker, p.total), (1, 3, 4));
        let off = Grouping {
            mode: GroupMode::Off,
            ..Default::default()
        };
        assert!(preview(&src, &off, &CustomGroups::default())
            .groups
            .is_empty());
    }

    #[tokio::test]
    async fn about_reports_version_store_and_clients() {
        let st = state();
        let res = app(&st)
            .oneshot(Request::get("/api/about").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v = json_of(res).await;
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["store"], "memory");
        assert_eq!(v["live_clients"], 0);
        assert!(v["sqlite_version"].as_str().unwrap().starts_with('3'));
    }

    #[tokio::test]
    async fn unknown_source_is_404_and_health_is_typed() {
        let st = state();
        let res = app(&st)
            .oneshot(
                Request::get("/api/sources/nope/lines")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        let res = app(&st)
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let v = json_of(res).await;
        assert_eq!(v["docker"]["state"], "disabled");
        assert_eq!(v["store"], "memory");
    }

    #[tokio::test]
    async fn ready_flips_to_503_on_shutdown_but_health_stays_up() {
        let st = state();
        let get = |p: &'static str| app(&st).oneshot(Request::get(p).body(Body::empty()).unwrap());
        assert_eq!(get("/ready").await.unwrap().status(), StatusCode::OK);
        st.ready.store(false, Ordering::Relaxed);
        assert_eq!(
            get("/ready").await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(get("/health").await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn filter_level_and_text() {
        let st = state();
        let lines = st
            .pipeline
            .ingest(
                SourceKind::Http,
                [
                    RawLine::new(r#"{"level":"warn","msg":"Slow Query"}"#, "a", 0),
                    RawLine::new(r#"{"level":"info","msg":"ok"}"#, "a", 0),
                    RawLine::new("no level", "a", 0),
                ],
            )
            .await
            .unwrap();
        let (warn, info, bare) = (&lines[0], &lines[1], &lines[2]);
        let f = Filter {
            source: "a".into(),
            level: Some("warn".into()),
            ..Default::default()
        };
        assert!(f.matches(warn) && !f.matches(info) && !f.matches(bare));
        let f = Filter {
            source: "a".into(),
            q: Some("slow query".into()),
            ..Default::default()
        };
        assert!(f.matches(warn) && !f.matches(info));
    }
}
