//! Garage as the in-house default (`deploy/docker-compose.local.yml`,
//! service `garage`). With `QUIET_GARAGE_*` set, quiet sets Garage up on
//! first start through its admin API (v1): a single-node layout when none
//! exists, the bucket, an access key with read/write, then connects it as
//! the active destination `garage-local`. Runs in the background and retries
//! while Garage is still starting; once `garage-local` exists it does nothing.

use super::{DestinationKind, History, NewDestination};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const NAME: &str = "garage-local";

#[derive(Debug, Clone)]
pub struct GarageEnv {
    /// S3 API, e.g. `http://garage:3900`.
    pub endpoint: String,
    /// Admin API, e.g. `http://garage:3903`.
    pub admin_endpoint: String,
    pub admin_token: String,
    pub bucket: String,
}

impl GarageEnv {
    /// `QUIET_GARAGE_ENDPOINT`, `QUIET_GARAGE_ADMIN_ENDPOINT`,
    /// `QUIET_GARAGE_ADMIN_TOKEN` (all three needed), `QUIET_GARAGE_BUCKET`
    /// (default `quiet-history`).
    pub fn from_env() -> Option<Self> {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Some(GarageEnv {
            endpoint: get("QUIET_GARAGE_ENDPOINT")?,
            admin_endpoint: get("QUIET_GARAGE_ADMIN_ENDPOINT")?,
            admin_token: get("QUIET_GARAGE_ADMIN_TOKEN")?,
            bucket: get("QUIET_GARAGE_BUCKET").unwrap_or_else(|| "quiet-history".into()),
        })
    }
}

struct Admin {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Admin {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(u16, Value)> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base.trim_end_matches('/')))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let v = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok((status, v))
    }

    async fn ok(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let (status, v) = self.call(method, path, body).await?;
        if !(200..300).contains(&status) {
            anyhow::bail!("garage admin {path}: HTTP {status}: {v}");
        }
        Ok(v)
    }
}

/// One attempt. `Ok(true)`: connected (or already there).
pub async fn bootstrap_once(history: &History, env: &GarageEnv, now: i64) -> anyhow::Result<bool> {
    if history
        .catalog
        .destinations()?
        .iter()
        .any(|d| d.name == NAME)
    {
        return Ok(true);
    }
    use reqwest::Method;
    super::remote::init_tls();
    let admin = Admin {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?,
        base: env.admin_endpoint.clone(),
        token: env.admin_token.clone(),
    };
    let status = admin.ok(Method::GET, "/v1/status", None).await?;
    let layout = admin.ok(Method::GET, "/v1/layout", None).await?;
    let has_roles = layout["roles"].as_array().is_some_and(|r| !r.is_empty());
    if !has_roles {
        let node = status["node"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("garage status has no node id"))?;
        admin
            .ok(
                Method::POST,
                "/v1/layout",
                Some(json!([{ "id": node, "zone": "dc1", "capacity": 100_000_000_000u64, "tags": ["quiet"] }])),
            )
            .await?;
        let version = layout["version"].as_i64().unwrap_or(0) + 1;
        admin
            .ok(
                Method::POST,
                "/v1/layout/apply",
                Some(json!({ "version": version })),
            )
            .await?;
    }
    let (code, found) = admin
        .call(
            Method::GET,
            &format!("/v1/bucket?globalAlias={}", env.bucket),
            None,
        )
        .await?;
    let bucket_id = if code == 200 {
        found["id"].as_str().map(str::to_string)
    } else {
        let made = admin
            .ok(
                Method::POST,
                "/v1/bucket",
                Some(json!({ "globalAlias": env.bucket })),
            )
            .await?;
        made["id"].as_str().map(str::to_string)
    }
    .ok_or_else(|| anyhow::anyhow!("garage returned no bucket id"))?;
    let key = admin
        .ok(Method::POST, "/v1/key", Some(json!({ "name": "quiet" })))
        .await?;
    let (Some(kid), Some(secret)) = (key["accessKeyId"].as_str(), key["secretAccessKey"].as_str())
    else {
        anyhow::bail!("garage returned no access key");
    };
    admin
        .ok(
            Method::POST,
            "/v1/bucket/allow",
            Some(json!({
                "bucketId": bucket_id,
                "accessKeyId": kid,
                "permissions": { "read": true, "write": true, "owner": true }
            })),
        )
        .await?;
    let made = history
        .create(
            NewDestination {
                name: NAME.into(),
                kind: DestinationKind::Garage,
                endpoint: Some(env.endpoint.clone()),
                region: Some("garage".into()),
                bucket: env.bucket.clone(),
                prefix: None,
                path_style: Some(true),
                access_key_id: kid.into(),
                secret_access_key: secret.into(),
                activate: Some(true),
            },
            now,
        )
        .await;
    match made {
        Ok((d, _)) if d.active => {
            tracing::info!(bucket = %env.bucket, "history: connected garage-local");
            Ok(true)
        }
        Ok((_, v)) => anyhow::bail!(
            "garage-local saved but Verify failed: {}",
            v.steps
                .iter()
                .filter_map(|s| s.error.clone())
                .collect::<Vec<_>>()
                .join("; ")
        ),
        Err(e) => anyhow::bail!("saving garage-local failed: {e:?}"),
    }
}

/// Retry for about two minutes while Garage starts.
pub async fn bootstrap(history: Arc<History>, env: GarageEnv) {
    for attempt in 1..=24 {
        let now = chrono::Utc::now().timestamp_millis();
        match bootstrap_once(&history, &env, now).await {
            Ok(_) => return,
            Err(e) => {
                tracing::info!(attempt, error = %format!("{e:#}"), "history: garage not ready yet");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
    tracing::warn!("history: gave up setting up garage-local; connect it in Settings → Storage");
}
