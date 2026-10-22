//! Settings, storage and system status for the UI.
//!
//! GET    /api/settings                    → everything (any signed-in user)
//! PUT    /api/settings/general            GeneralSettings          (owner)
//! PUT    /api/settings/storage            UpdateStorage            (owner)
//! PUT    /api/settings/flow-ids           FlowIdSettings           (owner)
//! PUT    /api/settings/sources/:name      SourceSettings           (owner)
//! DELETE /api/settings/sources/:name      back to instance defaults (owner)
//! GET    /api/storage                     usage, partitions, volume, projection
//! POST   /api/storage/purge               { source?, confirm }     (owner)
//! GET    /api/sources/:name/activity      rejected requests, paused drops
//! GET    /api/system                      issues for the banners
//!
//! Writes go through the session gate like every `/api` route (cookie +
//! `X-Quiet-Csrf`, same origin); members get 403 `owner_only`.

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::settings::{
    FlowIdSettings, GeneralSettings, SettingsError, SourceSettings, StorageSettings, UpdateStorage,
};
use crate::store::{HourUsage, SourceUsage};
use crate::system::{self, Readings, Rejection};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/settings", get(all))
        .route("/api/settings/general", put(put_general))
        .route("/api/settings/storage", put(put_storage))
        .route("/api/settings/flow-ids", put(put_flow_ids))
        .route(
            "/api/settings/sources/:name",
            put(put_source).delete(reset_source),
        )
        .route("/api/storage", get(storage))
        .route("/api/storage/purge", post(purge))
        .route("/api/sources/:name/activity", get(activity))
        .route("/api/system", get(system_status))
}

fn bad(status: StatusCode, code: &str, msg: &str) -> Response {
    (status, Json(json!({ "error": msg, "code": code }))).into_response()
}

fn failed(e: SettingsError) -> Response {
    match e {
        SettingsError::Invalid(m) => bad(StatusCode::BAD_REQUEST, "invalid", &m),
        SettingsError::Store(e) => {
            tracing::error!(error = %e, "settings write failed");
            bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "settings could not be saved",
            )
        }
    }
}

fn unavailable(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "store read failed");
    bad(
        StatusCode::SERVICE_UNAVAILABLE,
        "store",
        "store unavailable",
    )
}

/// Run a settings write off the async runtime (it is a SQLite write).
/// The error is the finished response, returned as is.
#[allow(clippy::result_large_err)]
async fn write<T: Send + 'static>(
    s: &AppState,
    f: impl FnOnce(&crate::settings::Settings) -> Result<T, SettingsError> + Send + 'static,
) -> Result<T, Response> {
    let settings = s.pipeline.settings().clone();
    match tokio::task::spawn_blocking(move || f(&settings)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(failed(e)),
        Err(e) => Err(failed(SettingsError::Store(e.into()))),
    }
}

async fn all(State(s): State<AppState>) -> Response {
    Json(s.pipeline.settings().all()).into_response()
}

async fn put_general(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<GeneralSettings>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(g)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected GeneralSettings JSON",
        );
    };
    let by = Some(v.user.id);
    match write(&s, move |st| st.put_general(g, by)).await {
        Ok(g) => {
            tracing::info!(by = v.user.id, instance = %g.instance_name, "general settings changed");
            Json(g).into_response()
        }
        Err(r) => r,
    }
}

async fn put_storage(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<UpdateStorage>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(u)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { retention_ms?, max_disk? }",
        );
    };
    let by = Some(v.user.id);
    match write(&s, move |st| st.put_storage(u, by)).await {
        Ok(st) => {
            let st: StorageSettings = st;
            tracing::info!(
                by = v.user.id,
                retention_h = st.retention_ms / 3_600_000,
                max_disk_mb = st.max_disk / 1_000_000,
                "storage settings changed"
            );
            Json(st).into_response()
        }
        Err(r) => r,
    }
}

async fn put_flow_ids(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<FlowIdSettings>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(f)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected FlowIdSettings JSON",
        );
    };
    let by = Some(v.user.id);
    match write(&s, move |st| st.put_flow_ids(f, by)).await {
        Ok(f) => {
            tracing::info!(by = v.user.id, order = ?f.order, match_by = ?f.match_by, "flow id order changed");
            Json(f).into_response()
        }
        Err(r) => r,
    }
}

async fn put_source(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(name): Path<String>,
    body: Option<Json<SourceSettings>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    if !crate::tokens_api::valid_source(&name) {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "source: 1–128 characters",
        );
    }
    let Some(Json(src)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected SourceSettings JSON",
        );
    };
    let by = Some(v.user.id);
    let n = name.clone();
    match write(&s, move |st| st.put_source(&n, src, by)).await {
        Ok(saved) => {
            tracing::info!(by = v.user.id, source = %name, paused = saved.paused, hidden = saved.hidden, "source settings changed");
            Json(saved).into_response()
        }
        Err(r) => r,
    }
}

async fn reset_source(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(name): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let by = Some(v.user.id);
    let n = name.clone();
    match write(&s, move |st| st.reset_source(&n, by)).await {
        Ok(()) => {
            tracing::info!(by = v.user.id, source = %name, "source settings reset");
            StatusCode::NO_CONTENT.into_response()
        }
        Err(r) => r,
    }
}

/// One source's share of the window.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceVolume {
    pub source: String,
    #[ts(type = "number")]
    pub lines: u64,
    /// Raw line bytes.
    #[ts(type = "number")]
    pub bytes: u64,
    /// Estimated share of the database on disk (its raw share × used bytes).
    #[ts(type = "number")]
    pub disk: u64,
    /// 0…1 of all raw bytes.
    pub share: f64,
}

/// `GET /api/storage`: Settings → Storage.
#[derive(Debug, Clone, Serialize, TS)]
pub struct StorageReport {
    pub settings: StorageSettings,
    /// `sqlite` or `memory`.
    pub store: String,
    /// The database file, when on disk.
    pub path: Option<String>,
    /// Bytes the database uses (pages in use + WAL); 0 for memory.
    pub used: u64,
    pub ratio: f64,
    #[ts(type = "number")]
    pub lines: u64,
    /// Oldest stored event time, unix ms.
    pub oldest: Option<i64>,
    pub fs_free: Option<u64>,
    /// Hourly partitions, oldest first.
    pub hours: Vec<HourUsage>,
    /// Biggest first.
    pub sources: Vec<SourceVolume>,
    /// Disk bytes one hour of lines takes at the recent rate (≤ 3 full hours).
    pub bytes_per_hour: Option<u64>,
    /// Where the database settles with this window at that rate.
    pub steady_bytes: Option<u64>,
    /// When the cap will start dropping hours early, ms from now; `null`
    /// when the window fits under the cap at the recent rate.
    pub cap_in_ms: Option<i64>,
    pub now: i64,
}

const HOUR: i64 = 3_600_000;

/// Recent raw bytes per hour: the average of the last (up to) three full
/// hours, or the current hour scaled up when it is the only one.
pub fn raw_per_hour(hours: &[HourUsage], now: i64) -> Option<f64> {
    let current = now.div_euclid(HOUR) * HOUR;
    let full: Vec<&HourUsage> = hours
        .iter()
        .filter(|h| h.start < current && h.start >= current - 3 * HOUR)
        .collect();
    if !full.is_empty() {
        return Some(full.iter().map(|h| h.bytes as f64).sum::<f64>() / full.len() as f64);
    }
    let cur = hours.iter().find(|h| h.start == current)?;
    let elapsed = ((now - current) as f64 / HOUR as f64).max(1.0 / 60.0);
    Some(cur.bytes as f64 / elapsed)
}

async fn storage(State(s): State<AppState>) -> Response {
    let store = s.pipeline.store();
    let (usage, detail) = match tokio::try_join!(store.usage(), store.storage()) {
        Ok(v) => v,
        Err(e) => return unavailable(e),
    };
    let settings = s.pipeline.settings().storage();
    let now = chrono::Utc::now().timestamp_millis();
    let raw_total: u64 = detail.sources.iter().map(|x| x.bytes).sum();
    let used = usage.bytes;
    // Disk bytes per raw byte (indexes, FTS, page slack).
    let overhead = (raw_total > 0 && used > 0).then(|| used as f64 / raw_total as f64);
    let sources = detail
        .sources
        .iter()
        .map(|x: &SourceUsage| {
            let share = if raw_total == 0 {
                0.0
            } else {
                x.bytes as f64 / raw_total as f64
            };
            SourceVolume {
                source: x.source.clone(),
                lines: x.lines,
                bytes: x.bytes,
                disk: (share * used as f64) as u64,
                share,
            }
        })
        .collect();
    let bytes_per_hour = match (raw_per_hour(&detail.hours, now), overhead) {
        (Some(r), Some(o)) => Some((r * o) as u64),
        _ => None,
    };
    let window_h = settings.retention_ms / HOUR;
    let steady_bytes = bytes_per_hour.map(|b| b * window_h as u64);
    let cap_in_ms = match (bytes_per_hour, steady_bytes) {
        (Some(b), Some(steady)) if b > 0 && steady > settings.max_disk => {
            let left = settings.max_disk.saturating_sub(used) as f64;
            Some((left / b as f64 * HOUR as f64) as i64)
        }
        _ => None,
    };
    let ratio = if settings.max_disk == 0 {
        0.0
    } else {
        used as f64 / settings.max_disk as f64
    };
    let path = (store.kind() == "sqlite")
        .then(|| {
            s.host
                .data_dir
                .as_ref()
                .map(|d| d.join("quiet.db").display().to_string())
        })
        .flatten();
    Json(StorageReport {
        store: store.kind().to_string(),
        path,
        used,
        ratio,
        lines: usage.lines,
        oldest: usage.oldest,
        fs_free: s
            .host
            .data_dir
            .as_deref()
            .and_then(system::fs_space)
            .map(|f| f.0),
        hours: detail.hours,
        sources,
        bytes_per_hour,
        steady_bytes,
        cap_in_ms,
        settings,
        now,
    })
    .into_response()
}

/// `POST /api/storage/purge`. `confirm` must repeat the source name, or
/// `purge` for everything (the dialog's type-to-confirm).
#[derive(Debug, Clone, Deserialize, TS)]
pub struct PurgeRequest {
    #[ts(optional)]
    pub source: Option<String>,
    pub confirm: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Purged {
    #[ts(type = "number")]
    pub lines: u64,
    pub source: Option<String>,
}

async fn purge(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<PurgeRequest>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(req)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { source?, confirm }",
        );
    };
    let source = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|x| !x.is_empty());
    let expected = source.unwrap_or("purge");
    if req.confirm.trim() != expected {
        return bad(
            StatusCode::BAD_REQUEST,
            "confirm",
            &format!("type `{expected}` to confirm"),
        );
    }
    let store = s.pipeline.store();
    // Lines a moment old are still queued for the writer: flush, then purge.
    if let Err(e) = store.flush().await {
        return unavailable(e);
    }
    match store.purge(source).await {
        Ok(lines) => {
            let hub = s.pipeline.hub();
            match source {
                Some(name) => {
                    if let Some(src) = hub.source(name) {
                        src.update_meta(|m| m.lines = 0);
                    }
                }
                None => {
                    for info in hub.list() {
                        if let Some(src) = hub.source(&info.name) {
                            src.update_meta(|m| m.lines = 0);
                        }
                    }
                }
            }
            tracing::warn!(by = v.user.id, source = ?source, lines, "stored lines purged");
            Json(Purged {
                lines,
                source: source.map(str::to_string),
            })
            .into_response()
        }
        Err(e) => unavailable(e),
    }
}

/// `GET /api/sources/:name/activity`: what the source's Rejected tab and
/// paused banner show.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceActivity {
    pub source: String,
    /// Newest first, grouped per minute, last 24h (at most 100 groups).
    pub rejections: Vec<Rejection>,
    #[ts(type = "number")]
    pub rejected_15m: u64,
    /// Lines dropped while ingest was paused (since the server started).
    #[ts(type = "number")]
    pub paused_dropped: u64,
}

async fn activity(State(s): State<AppState>, Path(name): Path<String>) -> Response {
    let sys = s.pipeline.system();
    let now = chrono::Utc::now().timestamp_millis();
    Json(SourceActivity {
        rejections: sys.rejections(Some(&name), 100),
        rejected_15m: sys.rejected_since(now - 15 * 60_000, Some(&name)),
        paused_dropped: sys.paused_dropped(&name),
        source: name,
    })
    .into_response()
}

async fn system_status(State(s): State<AppState>) -> Response {
    let store = s.pipeline.store();
    let usage = match store.usage().await {
        Ok(u) => u,
        Err(e) => return unavailable(e),
    };
    let st = s.pipeline.settings().storage();
    let fs = s.host.data_dir.as_deref().and_then(system::fs_space);
    let status = system::status(
        s.pipeline.system(),
        Readings {
            now: chrono::Utc::now().timestamp_millis(),
            docker: s.docker.lock().unwrap().clone(),
            store_kind: store.kind().to_string(),
            store_health: store.health(),
            used: usage.bytes,
            oldest: usage.oldest,
            cap: st.max_disk,
            window_ms: st.retention_ms,
            fs,
        },
    );
    Json(status).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    fn state() -> AppState {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(100)), Hub::new());
        AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled))).auth_off()
    }

    async fn call(
        st: &AppState,
        m: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut r = Request::builder().method(m).uri(path);
        let body = match body {
            Some(b) => {
                r = r.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = crate::api::router(st.clone())
            .oneshot(r.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[test]
    fn hourly_rate_uses_recent_full_hours() {
        let now = 10 * HOUR + HOUR / 2;
        let h = |n: i64, bytes| HourUsage {
            start: n * HOUR,
            lines: 1,
            bytes,
        };
        assert_eq!(
            raw_per_hour(&[h(5, 999), h(8, 100), h(9, 300), h(10, 1)], now),
            Some(200.0)
        );
        // Only the current half hour: scaled to a full hour.
        assert_eq!(raw_per_hour(&[h(10, 50)], now), Some(100.0));
        assert_eq!(raw_per_hour(&[], now), None);
    }

    #[tokio::test]
    async fn settings_round_trip_and_storage_report() {
        let st = state();
        st.pipeline
            .ingest(
                SourceKind::Http,
                [
                    RawLine::new(r#"{"msg":"a"}"#, "api", 1),
                    RawLine::new(r#"{"msg":"bb"}"#, "web", 1),
                ],
            )
            .await
            .unwrap();
        let (s, v) = call(&st, Method::GET, "/api/settings", None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["general"]["instance_name"], "quiet");
        assert_eq!(v["storage"]["retention_ms"], 24 * HOUR);
        assert_eq!(v["storage"]["retention_origin"], "default");

        let (s, v) = call(
            &st,
            Method::PUT,
            "/api/settings/storage",
            Some(json!({"retention_ms": 3 * 24 * HOUR})),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["retention_origin"], "setting");
        assert_eq!(
            st.retention_ms(),
            3 * 24 * HOUR,
            "search/flows see it at once"
        );
        let (s, _) = call(
            &st,
            Method::PUT,
            "/api/settings/storage",
            Some(json!({"retention_ms": 8 * 24 * HOUR})),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        let (s, v) = call(
            &st,
            Method::PUT,
            "/api/settings/sources/web",
            Some(json!({"display_name":"Website","hidden":true,"default_level":"warn"})),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        let (_, v) = call(&st, Method::GET, "/api/sources", None).await;
        let web = v["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["name"] == "web")
            .unwrap()
            .clone();
        assert_eq!(web["display_name"], "Website");
        assert_eq!(web["hidden"], true);

        let (s, v) = call(&st, Method::GET, "/api/storage", None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["store"], "memory");
        assert_eq!(v["sources"][0]["source"], "web", "biggest first");
        assert_eq!(v["settings"]["retention_ms"], 3 * 24 * HOUR);

        let (s, _) = call(&st, Method::DELETE, "/api/settings/sources/web", None).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert_eq!(
            st.pipeline.settings().source("web"),
            SourceSettings::default()
        );
    }

    #[tokio::test]
    async fn purge_needs_the_confirm_word() {
        let st = state();
        st.pipeline
            .ingest(
                SourceKind::Http,
                [RawLine::new("x", "api", 1), RawLine::new("y", "web", 1)],
            )
            .await
            .unwrap();
        let (s, v) = call(
            &st,
            Method::POST,
            "/api/storage/purge",
            Some(json!({"source":"api","confirm":"purge"})),
        )
        .await;
        assert_eq!(
            (s, v["code"].as_str()),
            (StatusCode::BAD_REQUEST, Some("confirm"))
        );
        let (s, v) = call(
            &st,
            Method::POST,
            "/api/storage/purge",
            Some(json!({"source":"api","confirm":"api"})),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["lines"], 1);
        assert_eq!(st.pipeline.hub().source("api").unwrap().meta().lines, 0);
        let (_, v) = call(
            &st,
            Method::POST,
            "/api/storage/purge",
            Some(json!({"confirm":"purge"})),
        )
        .await;
        assert_eq!(v["lines"], 1);
        assert!(st
            .pipeline
            .store()
            .tail("web", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn system_reports_docker_rejections_and_paused_drops() {
        let st = state();
        *st.docker.lock().unwrap() = DockerStatus::Unavailable {
            error: "permission denied".into(),
        };
        let now = chrono::Utc::now().timestamp_millis();
        st.pipeline
            .system()
            .reject(now, "ndjson", 401, "token revoked", Some("api"), None);
        st.pipeline.system().paused_drop("api", 7);
        let (s, v) = call(&st, Method::GET, "/api/system", None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["ok"], false);
        let kinds: Vec<_> = v["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(kinds, vec!["docker_unavailable", "ingest_rejected"]);
        assert_eq!(v["ingest"]["rejected_15m"], 1);
        assert_eq!(v["ingest"]["paused"][0]["dropped"], 7);

        let (_, v) = call(&st, Method::GET, "/api/sources/api/activity", None).await;
        assert_eq!(v["rejected_15m"], 1);
        assert_eq!(v["paused_dropped"], 7);
        assert_eq!(v["rejections"][0]["reason"], "token revoked");
    }
}
