//! What's new (plan slice 8, boards v0.1.1-00.1 … 00.4).
//!
//! The list of changes lives in the web app (`web/src/lib/whats-new.ts`);
//! the server keeps, per account and release, which items were seen and
//! whether the one-time banner was dismissed. Markers show only to accounts
//! made before this instance first ran the release, so a fresh install
//! starts clean. A new release id starts a fresh list (nothing seen).
//!
//!   GET /api/whats-new → { release, eligible, since, seen, banner_dismissed }
//!   PUT /api/whats-new   { seen?, banner_dismissed? } → the same

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::api::AppState;
use crate::auth::Viewer;

/// The release whose changes list the app ships. Bump with the list.
pub const RELEASE: &str = "0.1.1";
const MAX_IDS: usize = 200;
const MAX_ID_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, TS)]
pub struct WhatsNew {
    pub release: String,
    /// The account existed before this instance first ran `release`.
    pub eligible: bool,
    /// When this instance first ran `release`, unix ms.
    pub since: i64,
    /// Item ids this account has seen.
    pub seen: Vec<String>,
    pub banner_dismissed: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct WhatsNewUpdate {
    /// Item ids to add to the seen list (it only grows).
    #[ts(optional)]
    pub seen: Option<Vec<String>>,
    #[ts(optional)]
    pub banner_dismissed: Option<bool>,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/whats-new", get(get_state).put(put_state))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn state(s: &AppState, v: &Viewer) -> anyhow::Result<WhatsNew> {
    let since = s.accounts.whats_new_since(RELEASE, now())?;
    let (seen, banner_dismissed) = s.accounts.whats_new_seen(v.user.id, RELEASE)?;
    Ok(WhatsNew {
        release: RELEASE.into(),
        eligible: v.user.created < since,
        since,
        seen,
        banner_dismissed,
    })
}

fn unavailable(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "whats-new read failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "accounts unavailable" })),
    )
        .into_response()
}

async fn get_state(State(s): State<AppState>, Extension(v): Extension<Viewer>) -> Response {
    match state(&s, &v) {
        Ok(w) => Json(w).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn put_state(
    State(s): State<AppState>,
    Extension(v): Extension<Viewer>,
    Json(req): Json<WhatsNewUpdate>,
) -> Response {
    let ids = req.seen.unwrap_or_default();
    if ids.len() > MAX_IDS || ids.iter().any(|i| i.is_empty() || i.len() > MAX_ID_LEN) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "seen: up to 200 ids of 1–64 characters", "code": "invalid" })),
        )
            .into_response();
    }
    let cur = match state(&s, &v) {
        Ok(w) => w,
        Err(e) => return unavailable(e),
    };
    let mut seen = cur.seen;
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen.truncate(MAX_IDS);
    let banner = req.banner_dismissed.unwrap_or(cur.banner_dismissed) || cur.banner_dismissed;
    if let Err(e) = s
        .accounts
        .set_whats_new_seen(v.user.id, RELEASE, &seen, banner, now())
    {
        return unavailable(e);
    }
    match state(&s, &v) {
        Ok(w) => Json(w).into_response(),
        Err(e) => unavailable(e),
    }
}

#[cfg(test)]
mod tests {
    use crate::accounts::Accounts;

    #[test]
    fn since_is_kept_and_seen_is_per_account_and_release() {
        let a = Accounts::memory();
        assert_eq!(a.whats_new_since("0.1.1", 100).unwrap(), 100);
        assert_eq!(a.whats_new_since("0.1.1", 999).unwrap(), 100);
        assert_eq!(a.whats_new_seen(1, "0.1.1").unwrap(), (vec![], false));
        a.set_whats_new_seen(1, "0.1.1", &["guide".into()], true, 5)
            .unwrap();
        assert_eq!(
            a.whats_new_seen(1, "0.1.1").unwrap(),
            (vec!["guide".to_string()], true)
        );
        assert_eq!(a.whats_new_seen(2, "0.1.1").unwrap(), (vec![], false));
        // A new release starts with nothing seen.
        assert_eq!(a.whats_new_seen(1, "0.2.0").unwrap(), (vec![], false));
    }
}
