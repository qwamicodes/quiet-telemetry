//! Custom source groups (Sources → New group, a group's ⋯ menu, a source's
//! ⋯ → Move to group). See `grouping.rs` for how they apply.
//!
//! GET    /api/source-groups               → CustomGroups (any signed-in user)
//! POST   /api/source-groups               CreateSourceGroup → 201 CreatedSourceGroup (owner)
//! PATCH  /api/source-groups/:id           UpdateSourceGroup → CustomGroups (owner; rename / reorder)
//! DELETE /api/source-groups/:id           → CustomGroups (owner; its sources go back to automatic)
//! PUT    /api/source-groups/assign        AssignSources → CustomGroups (owner; `group: null` = Automatic)
//!
//! "Owners and admins can edit": quiet v0.1 has two roles, owner and member,
//! so the owner is the admin; members read and get 403 `owner_only` on
//! writes. `QUIET_GROUP_BY` (the mode lock) does not lock these. No write
//! here touches stored lines.

use crate::api::AppState;
use crate::auth::{require_owner, Viewer};
use crate::grouping::{CustomGroup, CustomGroups};
use crate::settings::{Settings, SettingsError};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, put};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/source-groups", get(list).post(create))
        .route("/api/source-groups/assign", put(assign))
        .route("/api/source-groups/:id", patch(update).delete(remove))
}

/// `POST /api/source-groups`: a name and, optionally, the sources picked in
/// the dialog.
#[derive(Debug, Deserialize, TS)]
pub struct CreateSourceGroup {
    pub name: String,
    #[serde(default)]
    #[ts(optional)]
    pub sources: Option<Vec<String>>,
}

#[derive(Debug, Serialize, TS)]
pub struct CreatedSourceGroup {
    pub group: CustomGroup,
    pub groups: CustomGroups,
}

/// `PATCH /api/source-groups/:id`: rename and/or move to position `order`
/// (0 = first; past the end = last).
#[derive(Debug, Deserialize, TS)]
pub struct UpdateSourceGroup {
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub order: Option<u32>,
}

/// `PUT /api/source-groups/assign`: move `sources` into custom group
/// `group`, or back to automatic grouping with `null`.
#[derive(Debug, Deserialize, TS)]
pub struct AssignSources {
    pub sources: Vec<String>,
    pub group: Option<String>,
}

fn bad(status: StatusCode, code: &str, msg: &str) -> Response {
    (status, Json(json!({ "error": msg, "code": code }))).into_response()
}

fn not_found(id: &str) -> Response {
    bad(
        StatusCode::NOT_FOUND,
        "not_found",
        &format!("no custom group {id:?}"),
    )
}

/// A settings write off the async runtime (SQLite); errors as responses.
#[allow(clippy::result_large_err)]
async fn write<T: Send + 'static>(
    s: &AppState,
    f: impl FnOnce(&Settings) -> Result<T, SettingsError> + Send + 'static,
) -> Result<T, Response> {
    let settings = s.pipeline.settings().clone();
    let failed = |e: SettingsError| match e {
        SettingsError::Invalid(m) => bad(StatusCode::BAD_REQUEST, "invalid", &m),
        SettingsError::NotFound(m) => bad(StatusCode::NOT_FOUND, "not_found", &m),
        SettingsError::Store(e) => {
            tracing::error!(error = %e, "custom group write failed");
            bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "store",
                "settings could not be saved",
            )
        }
    };
    match tokio::task::spawn_blocking(move || f(&settings)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(failed(e)),
        Err(e) => Err(failed(SettingsError::Store(e.into()))),
    }
}

async fn list(State(s): State<AppState>) -> Json<CustomGroups> {
    Json(s.pipeline.settings().custom_groups())
}

async fn create(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<CreateSourceGroup>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(req)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { name, sources? }",
        );
    };
    let by = Some(v.user.id);
    let sources = req.sources.unwrap_or_default();
    let n = sources.len();
    match write(&s, move |st| {
        let g = st.create_group(&req.name, &sources, by)?;
        Ok((g, st.custom_groups()))
    })
    .await
    {
        Ok((group, groups)) => {
            tracing::info!(by = v.user.id, id = %group.id, name = %group.name, sources = n, "custom group created");
            (
                StatusCode::CREATED,
                Json(CreatedSourceGroup { group, groups }),
            )
                .into_response()
        }
        Err(r) => r,
    }
}

async fn update(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
    body: Option<Json<UpdateSourceGroup>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(req)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { name?, order? }",
        );
    };
    if req.name.is_none() && req.order.is_none() {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "nothing to change: send name and/or order",
        );
    }
    let by = Some(v.user.id);
    let gid = id.clone();
    match write(&s, move |st| {
        st.update_group(&gid, req.name.as_deref(), req.order, by)
    })
    .await
    {
        Ok(Some(all)) => {
            tracing::info!(by = v.user.id, id = %id, "custom group changed");
            Json(all).into_response()
        }
        Ok(None) => not_found(&id),
        Err(r) => r,
    }
}

async fn remove(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let by = Some(v.user.id);
    let gid = id.clone();
    match write(&s, move |st| st.delete_group(&gid, by)).await {
        Ok(Some(all)) => {
            tracing::info!(by = v.user.id, id = %id, "custom group deleted; its sources are back to automatic");
            Json(all).into_response()
        }
        Ok(None) => not_found(&id),
        Err(r) => r,
    }
}

async fn assign(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    body: Option<Json<AssignSources>>,
) -> Response {
    if let Err(r) = require_owner(&v) {
        return r;
    }
    let Some(Json(req)) = body else {
        return bad(
            StatusCode::BAD_REQUEST,
            "invalid",
            "expected { sources: [..], group: id | null }",
        );
    };
    let by = Some(v.user.id);
    let (n, to) = (req.sources.len(), req.group.clone());
    match write(&s, move |st| {
        st.assign_sources(&req.sources, req.group.as_deref(), by)
    })
    .await
    {
        Ok(all) => {
            tracing::info!(by = v.user.id, sources = n, group = ?to, "sources moved");
            Json(all).into_response()
        }
        Err(r) => r,
    }
}

#[cfg(test)]
mod tests {
    use crate::api::AppState;
    use crate::hub::{Hub, SourceKind};
    use crate::pipeline::{Pipeline, RawLine};
    use crate::receiver::DockerStatus;
    use crate::store::MemoryStore;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
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

    /// Docker sources the way Dokploy / Swarm leave them: no Compose
    /// project, so Standalone; one in a Compose project.
    fn docker(st: &AppState, name: &str, compose: Option<&str>) {
        let src = st.pipeline.hub().ensure_source(name, SourceKind::Docker);
        if let Some(p) = compose {
            src.update_meta(|m| {
                m.labels
                    .insert(crate::grouping::COMPOSE_PROJECT.into(), p.into());
            });
        }
    }

    fn group_of<'a>(sources: &'a Value, name: &str) -> &'a Value {
        sources["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name)
            .unwrap()
    }

    #[test]
    fn apply_custom_groups_leaves_off_mode_flat() {
        use crate::grouping::{CustomGroup, CustomGroups, GroupKind};
        let hub = Hub::new();
        hub.ensure_source("a", SourceKind::Docker);
        hub.ensure_source("b", SourceKind::Docker);
        let mut list = hub.list();
        // Off: the hub leaves `group` empty.
        list[1].meta.group = None;
        list[1].meta.group_kind = None;
        let custom = CustomGroups {
            groups: vec![CustomGroup {
                id: "g_1".into(),
                name: "Mine".into(),
                order: 0,
            }],
            assigned: [
                ("a".to_string(), "g_1".to_string()),
                ("b".to_string(), "g_1".to_string()),
            ]
            .into(),
        };
        crate::api::apply_custom_groups(&mut list, &custom);
        assert_eq!(list[0].meta.group.as_deref(), Some("Mine"));
        assert_eq!(list[0].meta.group_kind, Some(GroupKind::Manual));
        assert_eq!(list[0].meta.auto_group_kind, Some(GroupKind::Standalone));
        assert!(list[1].meta.group.is_none() && list[1].meta.group_id.is_none());
    }

    #[tokio::test]
    async fn custom_groups_round_trip_through_the_api_and_regroup_sources() {
        let st = state();
        docker(&st, "staging-api", None);
        docker(&st, "staging-bot", None);
        docker(&st, "api", Some("thelegiventos-applications"));
        st.pipeline
            .ingest(
                SourceKind::Http,
                [RawLine::new(r#"{"msg":"a"}"#, "cron", 1)],
            )
            .await
            .unwrap();

        let (code, v) = call(&st, Method::GET, "/api/source-groups", None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(v, json!({"groups": [], "assigned": {}}));

        // New group with two picked sources.
        let (code, v) = call(
            &st,
            Method::POST,
            "/api/source-groups",
            Some(json!({"name": "Legivent staging", "sources": ["staging-api", "staging-bot"]})),
        )
        .await;
        assert_eq!(code, StatusCode::CREATED, "{v}");
        let id = v["group"]["id"].as_str().unwrap().to_string();
        assert_eq!(v["group"]["order"], 0);
        assert_eq!(v["groups"]["assigned"]["staging-api"], id.as_str());

        // /api/sources: the custom group wins, the automatic one is kept.
        let (_, s) = call(&st, Method::GET, "/api/sources", None).await;
        let bot = group_of(&s, "staging-bot");
        assert_eq!(bot["group"], "Legivent staging");
        assert_eq!(bot["group_kind"], "manual");
        assert_eq!(bot["group_id"], id.as_str());
        assert_eq!(bot["auto_group"], "Standalone");
        assert_eq!(bot["auto_group_kind"], "standalone");
        let api = group_of(&s, "api");
        assert_eq!(api["group_kind"], "compose");
        assert!(api.get("group_id").is_none() && api.get("auto_group").is_none());
        assert_eq!(s["custom_groups"][0]["name"], "Legivent staging");

        // Duplicate name (any case): 400; empty or too long: 400.
        for name in ["legivent STAGING", " ", &"x".repeat(49)] {
            let (code, v) = call(
                &st,
                Method::POST,
                "/api/source-groups",
                Some(json!({ "name": name })),
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST, "{name}: {v}");
            assert_eq!(v["code"], "invalid");
        }
        let (code, _) = call(&st, Method::POST, "/api/source-groups", None).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);

        // A second group, then move it up (rename + reorder).
        let (_, v) = call(
            &st,
            Method::POST,
            "/api/source-groups",
            Some(json!({"name": "Edge"})),
        )
        .await;
        let edge = v["group"]["id"].as_str().unwrap().to_string();
        assert_eq!(v["group"]["order"], 1);
        let (code, v) = call(
            &st,
            Method::PATCH,
            &format!("/api/source-groups/{edge}"),
            Some(json!({"name": "Edge proxies", "order": 0})),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{v}");
        assert_eq!(v["groups"][0]["name"], "Edge proxies");
        assert_eq!(v["groups"][1]["order"], 1);
        let (_, s) = call(&st, Method::GET, "/api/sources", None).await;
        assert_eq!(s["custom_groups"][0]["id"], edge.as_str());
        let (code, _) = call(
            &st,
            Method::PATCH,
            &format!("/api/source-groups/{edge}"),
            Some(json!({})),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        let (code, v) = call(
            &st,
            Method::PATCH,
            "/api/source-groups/g_nope",
            Some(json!({"name": "x"})),
        )
        .await;
        assert_eq!(
            (code, v["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found"))
        );

        // Move a pushed source and a compose source in; Automatic resets one.
        let (code, v) = call(
            &st,
            Method::PUT,
            "/api/source-groups/assign",
            Some(json!({"sources": ["cron", "api"], "group": edge})),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{v}");
        let (_, s) = call(&st, Method::GET, "/api/sources", None).await;
        assert_eq!(group_of(&s, "cron")["group"], "Edge proxies");
        assert_eq!(group_of(&s, "cron")["auto_group_kind"], "ingest");
        assert_eq!(
            group_of(&s, "api")["auto_group"],
            "thelegiventos-applications"
        );
        call(
            &st,
            Method::PUT,
            "/api/source-groups/assign",
            Some(json!({"sources": ["api"], "group": null})),
        )
        .await;
        let (_, s) = call(&st, Method::GET, "/api/sources", None).await;
        assert_eq!(group_of(&s, "api")["group_kind"], "compose");
        let (code, _) = call(
            &st,
            Method::PUT,
            "/api/source-groups/assign",
            Some(json!({"sources": ["api"], "group": "g_nope"})),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);

        // The grouping preview shows custom groups first.
        let (_, p) = call(&st, Method::GET, "/api/sources/grouping-preview", None).await;
        let kinds: Vec<_> = p["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (g["name"].as_str().unwrap(), g["kind"].as_str().unwrap()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Edge proxies", "manual"),
                ("Legivent staging", "manual"),
                ("thelegiventos-applications", "compose"),
            ]
        );

        // Grouping off: the custom groups are kept and still listed (the
        // flat list itself is `apply_custom_groups_leaves_off_mode_flat`).
        let (code, _) = call(
            &st,
            Method::PUT,
            "/api/settings/grouping",
            Some(json!({"mode": "off", "label": ""})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let (_, g) = call(&st, Method::GET, "/api/source-groups", None).await;
        assert_eq!(g["groups"].as_array().unwrap().len(), 2);
        assert_eq!(g["assigned"]["staging-bot"], id.as_str());
        call(
            &st,
            Method::PUT,
            "/api/settings/grouping",
            Some(Value::Null),
        )
        .await;

        // Delete: its sources go back to automatic; no lines are deleted.
        let lines_before = st.pipeline.store().usage().await.unwrap().lines;
        let (code, v) = call(
            &st,
            Method::DELETE,
            &format!("/api/source-groups/{id}"),
            None,
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{v}");
        assert_eq!(v["groups"].as_array().unwrap().len(), 1);
        let (_, s) = call(&st, Method::GET, "/api/sources", None).await;
        assert_eq!(group_of(&s, "staging-bot")["group"], "Standalone");
        assert_eq!(group_of(&s, "staging-bot")["group_kind"], "standalone");
        assert_eq!(
            st.pipeline.store().usage().await.unwrap().lines,
            lines_before
        );
        let (code, _) = call(
            &st,
            Method::DELETE,
            &format!("/api/source-groups/{id}"),
            None,
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);
    }
}
