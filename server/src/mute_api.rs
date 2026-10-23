//! Muted lines: rules, "Don't apply here", and what they hide (boards
//! 03.15–03.23, 06.13–06.25, 07.12–07.20).
//!
//! POST   /api/mute/rules                    AddMuteRule → AddedMuteRule      (owner)
//! PATCH  /api/mute/rules/:id                UpdateMuteRule → MuteRule        (owner)
//! DELETE /api/mute/rules/:id                → DeletedMuteRule (for Undo)     (owner)
//! PUT    /api/mute/sources/:name/global/:id { apply } → SourceSettings       (owner)
//! PUT    /api/mute/search                   { include: bool | null }          (owner)
//! GET    /api/mute/stats                    → MuteStats: 24h hits per rule and source
//! POST   /api/mute/preview                  MutePreviewRequest → [MutePreview]
//!
//! Matching happens in the browser for the stream and search; the counts
//! here come from a bounded scan of the stored window (newest lines first,
//! at most [`SCAN_BUDGET`] lines per request, spread over the sources).
//! When a source has more lines than were read, its counts are scaled up
//! and marked `estimated`. Stats are cached for a minute (and dropped on any
//! rule change).

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::mute::{field_text, matches, method_of, ROUTE_KEYS};
use crate::normalize::LogLine;
use crate::search::{Order, SearchQuery, MAX_PAGE};
use crate::settings::{
    clean_rule, AddMuteRule, MuteRule, MuteShape, MutedSearch, SettingsError, UpdateMuteRule,
};
use crate::settings_api::{bad, write};
use crate::store::Store;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{patch, post, put};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use ts_rs::TS;

/// Lines read per request, spread over the sources in scope.
pub const SCAN_BUDGET: usize = 60_000;
/// Every source in scope gets at least this many lines read.
const MIN_PER_SOURCE: usize = 2_000;
const DAY_MS: i64 = 24 * 3_600_000;
const STATS_TTL: Duration = Duration::from_secs(60);
const SAMPLES: usize = 3;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/mute/rules", post(add_rule))
        .route(
            "/api/mute/rules/:id",
            patch(update_rule).delete(delete_rule),
        )
        .route("/api/mute/sources/:name/global/:id", put(set_apply))
        .route("/api/mute/search", put(put_search))
        .route("/api/mute/stats", axum::routing::get(stats))
        .route("/api/mute/preview", post(preview))
}

// ---- wire types ----------------------------------------------------------------------

/// Lines a source had in the window, and how many were read for the counts.
#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct SourceLines {
    pub lines: u64,
    pub scanned: u64,
    /// Fewer read than there are: counts on this source are scaled up.
    pub estimated: bool,
}

/// One rule's matches per source in the window, enabled or not (paused and
/// switched-off rules show what they *would* hide).
#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct RuleHits {
    pub per_source: BTreeMap<String, u64>,
}

/// `GET /api/mute/stats`.
#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct MuteStats {
    pub since: i64,
    pub until: i64,
    pub sources: BTreeMap<String, SourceLines>,
    /// By rule id.
    pub rules: BTreeMap<String, RuleHits>,
}

/// `POST /api/mute/preview`: what these rules would hide, before saving.
#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct MutePreviewRequest {
    /// Draft rules (ids and switches ignored).
    pub rules: Vec<MuteRule>,
    /// Sources in scope; empty = every source (a global rule).
    #[serde(default)]
    #[ts(optional, as = "Option<Vec<String>>")]
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct MethodCount {
    pub method: String,
    pub count: u64,
}

/// One draft rule's preview.
#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct MutePreview {
    /// Matching lines in the window (scaled when `estimated`).
    pub total: u64,
    pub per_source: BTreeMap<String, u64>,
    /// Lines in scope in the window, for "N% of legivent-api".
    pub lines: u64,
    /// Route rules: matches by request method, most first.
    pub by_method: Vec<MethodCount>,
    /// Route rules: matches whose route carried a ?query or #hash.
    pub query_ignored: u64,
    /// Of `total`, lines already hidden by the rules applying now.
    pub already_hidden: u64,
    /// Newest matches.
    pub samples: Vec<LogLine>,
    pub estimated: bool,
    /// The rule could not be read (empty value, bad field): nothing matches.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct SetGlobalApply {
    pub apply: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct PutMutedSearch {
    #[ts(type = "boolean | null")]
    pub include: Option<bool>,
}

// ---- scanning -------------------------------------------------------------------------

/// Read up to `cap` of `source`'s newest lines in `[since, until]`, calling
/// `f` on each. Returns (lines in the window, lines read).
async fn scan_source(
    store: &Arc<dyn Store>,
    source: &str,
    since: i64,
    until: i64,
    cap: usize,
    mut f: impl FnMut(&LogLine),
) -> anyhow::Result<(u64, u64)> {
    let mut q = SearchQuery {
        sources: vec![source.to_string()],
        since: Some(since),
        until: Some(until),
        order: Order::Newest,
        limit: MAX_PAGE.min(cap.max(1)),
        histogram: Some(1),
        ..Default::default()
    };
    let mut total = None;
    let mut read = 0u64;
    loop {
        let page = store.search(&q).await?;
        if total.is_none() {
            total = page.total;
        }
        for l in &page.lines {
            f(l);
        }
        read += page.lines.len() as u64;
        match page.next_cursor {
            Some(c) if (read as usize) < cap && !page.lines.is_empty() => {
                q.cursor = Some(c);
                q.histogram = None;
                q.limit = MAX_PAGE.min(cap - read as usize);
            }
            _ => break,
        }
    }
    Ok((total.unwrap_or(read).max(read), read))
}

fn per_source_cap(n: usize) -> usize {
    (SCAN_BUDGET / n.max(1)).max(MIN_PER_SOURCE)
}

fn scale(n: u64, lines: u64, read: u64) -> u64 {
    if read == 0 || lines <= read {
        n
    } else {
        ((n as f64) * (lines as f64) / (read as f64)).round() as u64
    }
}

fn window(s: &AppState) -> (i64, i64) {
    let until = chrono::Utc::now().timestamp_millis();
    let span = DAY_MS.min(s.pipeline.settings().retention_ms());
    (until - span, until)
}

fn source_names(s: &AppState) -> Vec<String> {
    let mut v: Vec<String> = s
        .pipeline
        .hub()
        .list()
        .into_iter()
        .map(|x| x.name)
        .collect();
    v.sort();
    v.dedup();
    v
}

/// Every rule's matches per source (enabled or not).
async fn compute_stats(s: &AppState) -> anyhow::Result<MuteStats> {
    let settings = s.pipeline.settings();
    let global = settings.muted_global();
    let per_source = settings.sources();
    let names = source_names(s);
    let (since, until) = window(s);
    let cap = per_source_cap(names.len());
    let store = s.pipeline.store().clone();
    let mut out = MuteStats {
        since,
        until,
        ..Default::default()
    };
    for r in global
        .iter()
        .chain(per_source.values().flat_map(|x| x.muted.iter()))
    {
        out.rules.entry(r.id.clone()).or_default();
    }
    for name in names {
        let own: Vec<MuteRule> = per_source
            .get(&name)
            .map(|x| x.muted.clone())
            .unwrap_or_default();
        let rules: Vec<&MuteRule> = global.iter().chain(own.iter()).collect();
        let mut counts = vec![0u64; rules.len()];
        let (lines, read) = scan_source(&store, &name, since, until, cap, |l| {
            for (i, r) in rules.iter().enumerate() {
                if matches(l, r) {
                    counts[i] += 1;
                }
            }
        })
        .await?;
        for (i, r) in rules.iter().enumerate() {
            if counts[i] > 0 {
                out.rules
                    .entry(r.id.clone())
                    .or_default()
                    .per_source
                    .insert(name.clone(), scale(counts[i], lines, read));
            }
        }
        out.sources.insert(
            name,
            SourceLines {
                lines,
                scanned: read,
                estimated: lines > read,
            },
        );
    }
    Ok(out)
}

type StatsCache = tokio::sync::Mutex<Option<(u64, Instant, MuteStats)>>;

fn stats_cache() -> &'static StatsCache {
    static C: std::sync::OnceLock<StatsCache> = std::sync::OnceLock::new();
    C.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Changes whenever any rule (or switch) changes, so a cached count never
/// outlives an edit.
fn rules_key(s: &AppState) -> u64 {
    use std::hash::{Hash, Hasher};
    let st = s.pipeline.settings();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&st.muted_global())
        .unwrap_or_default()
        .hash(&mut h);
    for (k, v) in st.sources() {
        k.hash(&mut h);
        serde_json::to_string(&v.muted)
            .unwrap_or_default()
            .hash(&mut h);
    }
    h.finish()
}

async fn stats(State(s): State<AppState>) -> Response {
    let key = rules_key(&s);
    let mut cache = stats_cache().lock().await;
    if let Some((k, at, st)) = cache.as_ref() {
        if *k == key && at.elapsed() < STATS_TTL {
            return Json(st.clone()).into_response();
        }
    }
    match compute_stats(&s).await {
        Ok(st) => {
            *cache = Some((key, Instant::now(), st.clone()));
            Json(st).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "mute stats failed");
            bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "store unavailable",
            )
        }
    }
}

fn route_had_query(l: &LogLine) -> bool {
    ROUTE_KEYS
        .iter()
        .any(|k| field_text(l, k).is_some_and(|v| v.contains('?') || v.contains('#')))
}

/// What each draft rule would hide on `sources` (empty = all).
pub async fn compute_preview(
    s: &AppState,
    req: MutePreviewRequest,
) -> anyhow::Result<Vec<MutePreview>> {
    let settings = s.pipeline.settings();
    let mut out: Vec<MutePreview> = Vec::with_capacity(req.rules.len());
    let mut drafts: Vec<Option<MuteRule>> = Vec::with_capacity(req.rules.len());
    for mut r in req.rules.into_iter().take(8) {
        r.id = String::new();
        r.enabled = true;
        match clean_rule(r) {
            Ok(r) => {
                drafts.push(Some(r));
                out.push(MutePreview::default());
            }
            Err(e) => {
                drafts.push(None);
                out.push(MutePreview {
                    invalid: Some(match e {
                        SettingsError::Invalid(m) | SettingsError::NotFound(m) => m,
                        SettingsError::Store(e) => e.to_string(),
                    }),
                    ..Default::default()
                });
            }
        }
    }
    let known = source_names(s);
    let mut names: Vec<String> = if req.sources.is_empty() {
        known
    } else {
        req.sources
            .into_iter()
            .filter(|n| known.contains(n))
            .take(200)
            .collect()
    };
    names.dedup();
    let (since, until) = window(s);
    let cap = per_source_cap(names.len());
    let store = s.pipeline.store().clone();
    let mut methods: Vec<HashMap<String, u64>> = vec![HashMap::new(); drafts.len()];
    for name in names {
        let effective = settings.mute_rules(&name);
        let n = drafts.len();
        let mut hits = vec![0u64; n];
        let mut hidden = vec![0u64; n];
        let mut query = vec![0u64; n];
        let mut by_method: Vec<HashMap<String, u64>> = vec![HashMap::new(); n];
        let mut samples: Vec<Vec<LogLine>> = vec![Vec::new(); n];
        let (lines, read) = scan_source(&store, &name, since, until, cap, |l| {
            let mut already = None;
            for (i, d) in drafts.iter().enumerate() {
                let Some(d) = d else { continue };
                if !matches(l, d) {
                    continue;
                }
                hits[i] += 1;
                if *already.get_or_insert_with(|| effective.iter().any(|r| matches(l, r))) {
                    hidden[i] += 1;
                }
                if matches!(d.shape, MuteShape::Route | MuteShape::MethodRoute) {
                    if route_had_query(l) {
                        query[i] += 1;
                    }
                    let m = method_of(l).unwrap_or_else(|| "—".into());
                    *by_method[i].entry(m).or_default() += 1;
                }
                if samples[i].len() < SAMPLES {
                    samples[i].push(l.clone());
                }
            }
        })
        .await?;
        for i in 0..n {
            let p = &mut out[i];
            p.lines += lines;
            p.estimated |= lines > read && hits[i] > 0;
            let total = scale(hits[i], lines, read);
            if total > 0 {
                p.per_source.insert(name.clone(), total);
            }
            p.total += total;
            p.already_hidden += scale(hidden[i], lines, read);
            p.query_ignored += scale(query[i], lines, read);
            for (m, c) in by_method[i].drain() {
                *methods[i].entry(m).or_default() += scale(c, lines, read);
            }
            // Newest first across sources.
            p.samples.append(&mut samples[i]);
            p.samples.sort_by(|a, b| b.ts.cmp(&a.ts));
            p.samples.truncate(SAMPLES);
        }
    }
    for (i, m) in methods.into_iter().enumerate() {
        let mut v: Vec<MethodCount> = m
            .into_iter()
            .map(|(method, count)| MethodCount { method, count })
            .collect();
        v.sort_by(|a, b| b.count.cmp(&a.count).then(a.method.cmp(&b.method)));
        out[i].by_method = v;
    }
    Ok(out)
}

async fn preview(State(s): State<AppState>, body: Option<Json<MutePreviewRequest>>) -> Response {
    let Some(Json(req)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { rules: MuteRule[], sources?: string[] }",
        );
    };
    match compute_preview(&s, req).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "mute preview failed");
            bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "store unavailable",
            )
        }
    }
}

// ---- writes ---------------------------------------------------------------------------

async fn invalidate() {
    *stats_cache().lock().await = None;
}

async fn add_rule(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<AddMuteRule>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(mut add)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected AddMuteRule JSON",
        );
    };
    if add.rule.id.is_empty() || add.rule.created_by.is_none() {
        add.rule.created_by = Some(v.user.name.clone());
    }
    if add.rule.id.is_empty() || add.rule.created_at.is_none() {
        add.rule.created_at = Some(chrono::Utc::now().timestamp_millis());
    }
    let by = Some(v.user.id);
    match write(&s, move |st| st.add_mute_rule(add, by)).await {
        Ok(a) => {
            invalidate().await;
            tracing::info!(by = v.user.id, rule = %a.rule.id, scope = ?a.rule.scope, "muted-lines rule added");
            (StatusCode::CREATED, Json(a)).into_response()
        }
        Err(r) => r,
    }
}

async fn update_rule(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
    body: Option<Json<UpdateMuteRule>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(u)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected UpdateMuteRule JSON",
        );
    };
    let by = Some(v.user.id);
    match write(&s, move |st| st.update_mute_rule(&id, u, by)).await {
        Ok(r) => {
            invalidate().await;
            Json(r).into_response()
        }
        Err(r) => r,
    }
}

async fn delete_rule(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let by = Some(v.user.id);
    match write(&s, move |st| st.delete_mute_rule(&id, by)).await {
        Ok(d) => {
            invalidate().await;
            tracing::info!(by = v.user.id, rule = %d.rule.id, "muted-lines rule deleted");
            Json(d).into_response()
        }
        Err(r) => r,
    }
}

async fn set_apply(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path((name, id)): Path<(String, String)>,
    body: Option<Json<SetGlobalApply>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(b)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { apply: boolean }",
        );
    };
    let by = Some(v.user.id);
    let who = Some(v.user.name.clone());
    match write(&s, move |st| {
        st.set_global_apply(&name, &id, b.apply, who, by)
    })
    .await
    {
        Ok(src) => {
            invalidate().await;
            Json(src).into_response()
        }
        Err(r) => r,
    }
}

async fn put_search(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<PutMutedSearch>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(b)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { include: boolean | null }",
        );
    };
    let by = Some(v.user.id);
    match write(&s, move |st| st.put_muted_search(b.include, by)).await {
        Ok(m) => Json::<MutedSearch>(m).into_response(),
        Err(r) => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::settings::{MuteScope, MuteShape};
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::Mutex;
    use tower::ServiceExt;

    async fn app() -> (AppState, Router) {
        let pipeline = Pipeline::new(Arc::new(MemoryStore::new(1000)), Hub::new());
        let st = AppState::new(pipeline, Arc::new(Mutex::new(DockerStatus::Disabled))).auth_off();
        let now = chrono::Utc::now().timestamp_millis();
        let mut raws = Vec::new();
        for i in 0..6 {
            raws.push((format!(r#"{{"msg":"request completed","method":"GET","path":"/api/v1/health?probe={i}"}}"#), "api"));
        }
        raws.push((
            r#"{"msg":"request completed","method":"HEAD","path":"/api/v1/health"}"#.into(),
            "api",
        ));
        raws.push((
            r#"{"msg":"request completed","method":"POST","path":"/api/v1/orders"}"#.into(),
            "api",
        ));
        raws.push((r#"{"msg":"heartbeat ok"}"#.into(), "worker"));
        raws.push((
            r#"{"msg":"probe","req":{"url":"http://w/api/v1/health","method":"GET"}}"#.into(),
            "worker",
        ));
        for (i, (raw, src)) in raws.iter().enumerate() {
            let mut r = RawLine::new(raw.as_str(), *src, now - 5000 + i as i64);
            r.collector_ts = None;
            st.pipeline.ingest(SourceKind::Http, [r]).await.unwrap();
        }
        let app = crate::api::router(st.clone());
        (st, app)
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn rule(shape: MuteShape, value: &str, method: Option<&str>) -> MuteRule {
        MuteRule {
            shape,
            value: value.into(),
            method: method.map(String::from),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn preview_counts_methods_queries_samples_and_sources() {
        let (st, _) = app().await;
        let p = compute_preview(
            &st,
            MutePreviewRequest {
                rules: vec![
                    rule(MuteShape::Route, "/api/v1/health", None),
                    rule(MuteShape::MethodRoute, "/api/v1/health", Some("GET")),
                    rule(MuteShape::Message, "request completed", None),
                    rule(MuteShape::Route, "", None),
                ],
                sources: vec!["api".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(p[0].total, 7);
        assert_eq!(p[0].lines, 8);
        assert_eq!(p[0].query_ignored, 6);
        assert_eq!(p[0].by_method[0].method, "GET");
        assert_eq!(p[0].by_method[0].count, 6);
        assert_eq!(p[0].by_method[1].method, "HEAD");
        assert_eq!(p[0].samples.len(), 3);
        assert!(p[0].samples[0].ts >= p[0].samples[1].ts, "newest first");
        assert_eq!(p[1].total, 6);
        assert_eq!(p[2].total, 8);
        assert!(p[3].invalid.is_some() && p[3].total == 0);
        assert!(!p[0].estimated);
        // Every source (a global rule).
        let all = compute_preview(
            &st,
            MutePreviewRequest {
                rules: vec![rule(MuteShape::Route, "/api/v1/health", None)],
                sources: vec![],
            },
        )
        .await
        .unwrap();
        assert_eq!(all[0].total, 8);
        assert_eq!(all[0].per_source.get("worker"), Some(&1));
        assert_eq!(all[0].lines, 10);
    }

    #[tokio::test]
    async fn rules_round_trip_over_http_and_stats_follow_them() {
        let (st, app) = app().await;
        let (code, added) = call(
            &app,
            "POST",
            "/api/mute/rules",
            serde_json::json!({ "rule": { "shape": "route", "value": "/api/v1/health?probe=1", "field": "path", "origin": "hover" }, "source": "api" }),
        )
        .await;
        assert_eq!(code, StatusCode::CREATED, "{added}");
        let id = added["rule"]["id"].as_str().unwrap().to_string();
        assert_eq!(added["rule"]["value"], "/api/v1/health");
        assert_eq!(added["rule"]["origin"], "hover");
        assert!(added["rule"]["created_at"].is_number());
        let (_, g) = call(
            &app,
            "POST",
            "/api/mute/rules",
            serde_json::json!({ "rule": { "shape": "message", "value": "msg:\"heartbeat ok\"", "scope": "global" } }),
        )
        .await;
        let gid = g["rule"]["id"].as_str().unwrap().to_string();
        assert_eq!(g["rule"]["value"], "heartbeat ok");
        assert_eq!(g["rule"]["scope"], "global");

        let (_, stats) = call(&app, "GET", "/api/mute/stats", serde_json::Value::Null).await;
        assert_eq!(stats["rules"][&id]["per_source"]["api"], 7);
        assert_eq!(stats["rules"][&gid]["per_source"]["worker"], 1);
        assert_eq!(stats["sources"]["api"]["lines"], 8);

        // Don't apply here, then pause, then delete (Undo payload back).
        let (code, src) = call(
            &app,
            "PUT",
            &format!("/api/mute/sources/worker/global/{gid}"),
            serde_json::json!({ "apply": false }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(src["muted_global_off"][0]["id"], gid.as_str());
        assert!(st.pipeline.settings().mute_rules("worker").is_empty());
        let (_, r) = call(
            &app,
            "PATCH",
            &format!("/api/mute/rules/{id}"),
            serde_json::json!({ "enabled": false }),
        )
        .await;
        assert_eq!(r["enabled"], false);
        let (code, d) = call(
            &app,
            "DELETE",
            &format!("/api/mute/rules/{gid}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(d["off_on"][0]["source"], "worker");
        let (code, _) = call(
            &app,
            "DELETE",
            &format!("/api/mute/rules/{gid}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        let (code, back) = call(
            &app,
            "POST",
            "/api/mute/rules",
            serde_json::json!({ "rule": d["rule"], "off_on": d["off_on"] }),
        )
        .await;
        assert_eq!(code, StatusCode::CREATED);
        assert_eq!(back["rule"]["id"], gid.as_str());
        assert_eq!(
            st.pipeline.settings().muted_global()[0].scope,
            MuteScope::Global
        );
        let (code, m) = call(
            &app,
            "PUT",
            "/api/mute/search",
            serde_json::json!({ "include": true }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(m["include"], true);
        let (code, _) = call(
            &app,
            "POST",
            "/api/mute/rules",
            serde_json::json!({ "rule": { "shape": "route", "value": "/x" } }),
        )
        .await;
        assert_eq!(
            code,
            StatusCode::BAD_REQUEST,
            "a source rule needs its source"
        );
    }
}
