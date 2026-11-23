//! Retained history (v0.1.1 Phase 5a, `docs/v0.1.1-storage-design.md`).
//!
//! The local SQLite window is unchanged. When an hour leaves it and a
//! destination is active, the retention job archives the hour first: one
//! SQLite segment (the hour's lines, FTS and id index; already sanitized by
//! redaction before storage), zstd-compressed, uploaded with a manifest,
//! checked with HEAD, recorded in the catalog, and only then dropped
//! locally. When the destination can't be reached the hour waits on local
//! disk (banner, backoff); only the disk cap can drop it then, and that hole
//! is recorded as a gap so search can say "not retained".

pub mod catalog;
pub mod garage;
pub mod remote;
pub mod secret;

use crate::store::Store;
use crate::system::{Issue, IssueKind, Severity, SystemState};
use catalog::{Catalog, DestinationRow};
use object_store::path::Path as ObjPath;
use object_store::{ObjectStoreExt, PutPayload};
use remote::Remote;
use secret::SecretBox;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use ts_rs::TS;

pub const HOUR: i64 = 3_600_000;
/// First retry after a failed upload; doubles up to [`MAX_BACKOFF_MS`].
const BACKOFF_MS: i64 = 30_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DestinationKind {
    Garage,
    R2,
    S3,
    S3Compatible,
}

impl DestinationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DestinationKind::Garage => "garage",
            DestinationKind::R2 => "r2",
            DestinationKind::S3 => "s3",
            DestinationKind::S3Compatible => "s3_compatible",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "garage" => DestinationKind::Garage,
            "r2" => DestinationKind::R2,
            "s3" => DestinationKind::S3,
            "s3_compatible" => DestinationKind::S3Compatible,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum VerifyStepKind {
    Write,
    Read,
    List,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct VerifyStep {
    pub step: VerifyStepKind,
    pub ok: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What Verify found. `ok`: quiet can write, read and list here, so it can
/// be the active destination. `cleanup`: it can also delete (else history
/// retention can't remove old hours: "cleanup blocked").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct VerifyResult {
    pub ok: bool,
    pub cleanup: bool,
    pub steps: Vec<VerifyStep>,
    /// When it ran, unix ms.
    pub at: i64,
}

impl VerifyResult {
    pub fn from_steps(steps: Vec<VerifyStep>, at: i64) -> Self {
        let ok_of = |k| steps.iter().any(|s| s.step == k && s.ok);
        VerifyResult {
            ok: ok_of(VerifyStepKind::Write)
                && ok_of(VerifyStepKind::Read)
                && ok_of(VerifyStepKind::List),
            cleanup: ok_of(VerifyStepKind::Delete),
            steps,
            at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    /// Left the local window while no destination was active (after history
    /// had been turned on once).
    NoDestination,
    /// Waited for an unreachable destination until the disk cap dropped it.
    DestinationUnavailable,
    /// Dropped by the disk cap before it left the window.
    DiskCap,
    /// Every line in it came from sources excluded from history.
    Excluded,
}

impl GapReason {
    pub fn as_str(self) -> &'static str {
        match self {
            GapReason::NoDestination => "no_destination",
            GapReason::DestinationUnavailable => "destination_unavailable",
            GapReason::DiskCap => "disk_cap",
            GapReason::Excluded => "excluded",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "no_destination" => GapReason::NoDestination,
            "destination_unavailable" => GapReason::DestinationUnavailable,
            "disk_cap" => GapReason::DiskCap,
            "excluded" => GapReason::Excluded,
            _ => return None,
        })
    }
}

/// One archived hour in one destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HourRecord {
    pub hour: i64,
    pub destination_id: i64,
    pub key: String,
    pub lines: u64,
    pub bytes_raw: u64,
    pub bytes_stored: u64,
    pub sources: Vec<String>,
    pub min_ts: Option<i64>,
    pub max_ts: Option<i64>,
    pub sha256: String,
    pub archived_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DestinationState {
    /// Active and healthy.
    Ok,
    /// Active, but the last upload failed: hours wait locally.
    Unavailable,
    /// Not active: holds what it archived, searchable, receives nothing new.
    ReadOnly,
}

/// A destination as the API shows it: never the secret.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Destination {
    pub id: i64,
    pub name: String,
    pub kind: DestinationKind,
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub path_style: bool,
    /// `AKIA••••7Q2X`.
    pub access_key_preview: String,
    pub active: bool,
    pub state: DestinationState,
    pub verified_at: Option<i64>,
    pub last_verify: Option<VerifyResult>,
    /// Archived hours it holds.
    #[ts(type = "number")]
    pub hours: u64,
    #[ts(type = "number")]
    pub lines: u64,
    #[ts(type = "number")]
    pub bytes_stored: u64,
    /// Start of the oldest / newest archived hour, unix ms.
    pub first: Option<i64>,
    pub last: Option<i64>,
    /// The last upload error while unavailable, and when it retries.
    pub error: Option<String>,
    pub next_retry: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct NewDestination {
    pub name: String,
    pub kind: DestinationKind,
    #[serde(default)]
    #[ts(optional)]
    pub endpoint: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub region: Option<String>,
    pub bucket: String,
    /// Blank: `quiet/<instance id>/`.
    #[serde(default)]
    #[ts(optional)]
    pub prefix: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub path_style: Option<bool>,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Make it the active destination once Verify passes.
    #[serde(default)]
    #[ts(optional)]
    pub activate: Option<bool>,
}

/// Every field optional; a blank secret keeps the saved one.
#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct UpdateDestination {
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub endpoint: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub region: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub bucket: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub prefix: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub path_style: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub access_key_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub secret_access_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct HistoryGap {
    /// Start of the hour, unix ms.
    pub hour: i64,
    pub reason: GapReason,
    /// When it was recorded.
    pub at: i64,
}

/// `GET /api/storage/history`.
#[derive(Debug, Clone, Serialize, TS)]
pub struct HistoryStatus {
    /// A destination has been active at least once.
    pub enabled: bool,
    pub enabled_at: Option<i64>,
    pub instance_id: String,
    pub active: Option<i64>,
    pub destinations: Vec<Destination>,
    /// Newest first, at most 100.
    pub gaps: Vec<HistoryGap>,
    #[ts(type = "number")]
    pub gap_hours: u64,
    /// Hours past the local window still waiting to be archived.
    #[ts(type = "number")]
    pub waiting_hours: u64,
}

#[derive(Debug)]
pub enum HistoryError {
    Invalid(String),
    NotFound,
    Conflict(&'static str, String),
    /// Copy history / delete history arrive in 5b.
    NotYet(&'static str),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for HistoryError {
    fn from(e: anyhow::Error) -> Self {
        HistoryError::Failed(e)
    }
}

/// How a destination row becomes a client. Tests swap in in-memory stores.
pub type Connector = Arc<dyn Fn(&DestinationRow, &str) -> anyhow::Result<Remote> + Send + Sync>;

#[derive(Debug, Clone)]
struct Unavailable {
    destination_id: i64,
    error: String,
    next_retry: i64,
    attempts: u32,
}

#[derive(Debug, Default)]
struct Runtime {
    unavailable: Option<Unavailable>,
    waiting: u64,
}

pub struct History {
    pub catalog: Catalog,
    secrets: SecretBox,
    tmp: PathBuf,
    connector: Connector,
    runtime: Mutex<Runtime>,
}

/// What one archive pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pass {
    /// Hours uploaded (or recorded as excluded) and dropped locally.
    pub archived: Vec<i64>,
    /// Expiring hours left on local disk: the window must not drop them.
    pub hold: bool,
    /// Hours that are waiting for the destination.
    pub waiting: Vec<i64>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn name_ok(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && s.chars().count() <= 64 && !s.chars().any(char::is_control)
}

impl History {
    /// History next to the store: catalog in `quiet.db`, the key in
    /// `secret.key`, segments built in `history-tmp/`.
    pub fn open(data_dir: &Path) -> anyhow::Result<Self> {
        let h = History {
            catalog: Catalog::open(Some(&data_dir.join("quiet.db")))?,
            secrets: SecretBox::open(&data_dir.join("secret.key"))?,
            tmp: data_dir.join("history-tmp"),
            connector: Arc::new(remote::connect),
            runtime: Mutex::new(Runtime::default()),
        };
        h.catalog.instance_id()?;
        Ok(h)
    }

    pub fn memory() -> Self {
        History {
            catalog: Catalog::memory(),
            secrets: SecretBox::ephemeral(),
            tmp: std::env::temp_dir().join(format!("quiet-history-{:08x}", rand::random::<u32>())),
            connector: Arc::new(remote::connect),
            runtime: Mutex::new(Runtime::default()),
        }
    }

    #[cfg(test)]
    pub fn with_connector(mut self, c: Connector) -> Self {
        self.connector = c;
        self
    }

    fn remote(&self, d: &DestinationRow) -> anyhow::Result<Remote> {
        let secret = self.secrets.open_sealed(&d.secret_enc)?;
        (self.connector)(d, &secret)
    }

    fn find(&self, id: i64) -> Result<DestinationRow, HistoryError> {
        self.catalog.destination(id)?.ok_or(HistoryError::NotFound)
    }

    fn view(&self, d: &DestinationRow) -> anyhow::Result<Destination> {
        let held = self.catalog.held(d.id)?;
        let rt = self.runtime.lock().unwrap();
        let down = rt
            .unavailable
            .as_ref()
            .filter(|u| u.destination_id == d.id && d.active);
        Ok(Destination {
            id: d.id,
            name: d.name.clone(),
            kind: d.kind,
            endpoint: d.endpoint.clone(),
            region: d.region.clone(),
            bucket: d.bucket.clone(),
            prefix: d.prefix.clone(),
            path_style: d.path_style,
            access_key_preview: secret::preview(&d.access_key_id),
            active: d.active,
            state: match (d.active, down.is_some()) {
                (false, _) => DestinationState::ReadOnly,
                (true, true) => DestinationState::Unavailable,
                (true, false) => DestinationState::Ok,
            },
            verified_at: d.verified_at,
            last_verify: d.last_verify.clone(),
            hours: held.hours,
            lines: held.lines,
            bytes_stored: held.bytes_stored,
            first: held.first_hour.map(|h| h * HOUR),
            last: held.last_hour.map(|h| h * HOUR),
            error: down.map(|u| u.error.clone()),
            next_retry: down.map(|u| u.next_retry),
            created_at: d.created_at,
        })
    }

    pub fn destinations(&self) -> anyhow::Result<Vec<Destination>> {
        self.catalog
            .destinations()?
            .iter()
            .map(|d| self.view(d))
            .collect()
    }

    pub fn destination(&self, id: i64) -> Result<Destination, HistoryError> {
        Ok(self.view(&self.find(id)?)?)
    }

    pub fn status(&self) -> anyhow::Result<HistoryStatus> {
        let destinations = self.destinations()?;
        let enabled_at = self.catalog.enabled_at()?;
        Ok(HistoryStatus {
            enabled: enabled_at.is_some(),
            enabled_at,
            instance_id: self.catalog.instance_id()?,
            active: destinations.iter().find(|d| d.active).map(|d| d.id),
            destinations,
            gaps: self
                .catalog
                .gaps(100)?
                .into_iter()
                .map(|(h, reason, at)| HistoryGap {
                    hour: h * HOUR,
                    reason,
                    at,
                })
                .collect(),
            gap_hours: self.catalog.gap_count()?,
            waiting_hours: self.runtime.lock().unwrap().waiting,
        })
    }

    fn check_fields(
        name: &str,
        kind: DestinationKind,
        endpoint: Option<&str>,
        bucket: &str,
        access_key_id: &str,
        secret: &str,
    ) -> Result<(), HistoryError> {
        let invalid = |m: &str| Err(HistoryError::Invalid(m.into()));
        if !name_ok(name) {
            return invalid("name: 1–64 characters");
        }
        if bucket.trim().is_empty() || bucket.len() > 63 || bucket.contains('/') {
            return invalid("bucket: a bucket name, without slashes");
        }
        if access_key_id.trim().is_empty() || secret.trim().is_empty() {
            return invalid("an access key id and secret are required");
        }
        let endpoint = endpoint.map(str::trim).unwrap_or("");
        if kind != DestinationKind::S3 && endpoint.is_empty() {
            return invalid("endpoint: required for Garage, R2 and S3-compatible storage");
        }
        if !endpoint.is_empty()
            && !(endpoint.starts_with("https://") || endpoint.starts_with("http://"))
        {
            return invalid("endpoint: an http:// or https:// URL");
        }
        Ok(())
    }

    /// Save a destination and verify it; make it active when asked and
    /// Verify passed.
    pub async fn create(
        &self,
        n: NewDestination,
        now: i64,
    ) -> Result<(Destination, VerifyResult), HistoryError> {
        Self::check_fields(
            &n.name,
            n.kind,
            n.endpoint.as_deref(),
            &n.bucket,
            &n.access_key_id,
            &n.secret_access_key,
        )?;
        if self
            .catalog
            .destinations()?
            .iter()
            .any(|d| d.name.eq_ignore_ascii_case(n.name.trim()))
        {
            return Err(HistoryError::Conflict(
                "name_taken",
                format!("a destination called {:?} exists", n.name.trim()),
            ));
        }
        let instance = self.catalog.instance_id()?;
        let row = DestinationRow {
            id: 0,
            name: n.name.trim().to_string(),
            kind: n.kind,
            endpoint: n
                .endpoint
                .map(|e| e.trim().trim_end_matches('/').to_string())
                .filter(|e| !e.is_empty()),
            region: n.region.unwrap_or_default().trim().to_string(),
            bucket: n.bucket.trim().to_string(),
            prefix: remote::normalize_prefix(n.prefix.as_deref().unwrap_or(""), &instance),
            // Garage and most S3-compatible servers want path-style URLs.
            path_style: n.path_style.unwrap_or(matches!(
                n.kind,
                DestinationKind::Garage | DestinationKind::S3Compatible
            )),
            access_key_id: n.access_key_id.trim().to_string(),
            secret_enc: self.secrets.seal(n.secret_access_key.trim())?,
            active: false,
            verified_at: None,
            last_verify: None,
            created_at: now,
        };
        let id = self.catalog.insert(&row)?;
        let v = self.verify(id, now).await?;
        if n.activate.unwrap_or(false) && v.ok {
            self.activate(id, false, now).await?;
        }
        Ok((self.destination(id)?, v))
    }

    pub async fn update(
        &self,
        id: i64,
        u: UpdateDestination,
        now: i64,
    ) -> Result<(Destination, VerifyResult), HistoryError> {
        let mut d = self.find(id)?;
        if let Some(n) = u.name {
            d.name = n.trim().to_string();
        }
        if let Some(e) = u.endpoint {
            let e = e.trim().trim_end_matches('/').to_string();
            d.endpoint = (!e.is_empty()).then_some(e);
        }
        if let Some(r) = u.region {
            d.region = r.trim().to_string();
        }
        if let Some(b) = u.bucket {
            d.bucket = b.trim().to_string();
        }
        if let Some(p) = u.prefix {
            d.prefix = remote::normalize_prefix(&p, &self.catalog.instance_id()?);
        }
        if let Some(p) = u.path_style {
            d.path_style = p;
        }
        if let Some(k) = u.access_key_id {
            d.access_key_id = k.trim().to_string();
        }
        let secret = match u.secret_access_key.filter(|s| !s.trim().is_empty()) {
            Some(s) => {
                d.secret_enc = self.secrets.seal(s.trim())?;
                s.trim().to_string()
            }
            None => self.secrets.open_sealed(&d.secret_enc)?,
        };
        Self::check_fields(
            &d.name,
            d.kind,
            d.endpoint.as_deref(),
            &d.bucket,
            &d.access_key_id,
            &secret,
        )?;
        if self
            .catalog
            .destinations()?
            .iter()
            .any(|x| x.id != id && x.name.eq_ignore_ascii_case(&d.name))
        {
            return Err(HistoryError::Conflict(
                "name_taken",
                format!("a destination called {:?} exists", d.name),
            ));
        }
        self.catalog.update(&d)?;
        let v = self.verify(id, now).await?;
        Ok((self.destination(id)?, v))
    }

    /// Put → get → list → delete, saved on the destination.
    pub async fn verify(&self, id: i64, now: i64) -> Result<VerifyResult, HistoryError> {
        let d = self.find(id)?;
        let v = match self.remote(&d) {
            Ok(r) => remote::verify(&r, &d.prefix, now).await,
            Err(e) => VerifyResult::from_steps(
                [
                    VerifyStepKind::Write,
                    VerifyStepKind::Read,
                    VerifyStepKind::List,
                    VerifyStepKind::Delete,
                ]
                .into_iter()
                .map(|step| VerifyStep {
                    step,
                    ok: false,
                    error: Some(format!("{e:#}")),
                })
                .collect(),
                now,
            ),
        };
        self.catalog.set_verify(id, &v)?;
        if v.ok && d.active {
            // A passing Verify on the active destination retries at once.
            if let Some(u) = self.runtime.lock().unwrap().unavailable.as_mut() {
                u.next_retry = now;
            }
        }
        Ok(v)
    }

    /// Make a destination the one new hours go to. It must pass Verify now.
    /// Copying history between destinations is 5b.
    pub async fn activate(
        &self,
        id: i64,
        copy_history: bool,
        now: i64,
    ) -> Result<Destination, HistoryError> {
        if copy_history {
            return Err(HistoryError::NotYet(
                "copy history arrives in a later release",
            ));
        }
        let d = self.find(id)?;
        let v = self.verify(id, now).await?;
        if !v.ok {
            return Err(HistoryError::Conflict(
                "verify_failed",
                format!(
                    "{} can't be made active: quiet must be able to write, read and list there",
                    d.name
                ),
            ));
        }
        self.catalog.set_active(id)?;
        self.catalog.mark_enabled(now)?;
        self.runtime.lock().unwrap().unavailable = None;
        let remote = self.remote(&d)?;
        let _ = self.write_instance(&remote, &d, now).await;
        self.destination(id)
    }

    /// Forget a destination, leaving its objects in the bucket (reconnect +
    /// reindex brings them back). Deleting its history is 5b.
    pub fn remove(&self, id: i64, delete_history: bool) -> Result<(), HistoryError> {
        if delete_history {
            return Err(HistoryError::NotYet(
                "deleting a destination's history arrives in a later release",
            ));
        }
        let d = self.find(id)?;
        if d.active {
            return Err(HistoryError::Conflict(
                "active",
                format!(
                    "{} is the active destination: make another one active first",
                    d.name
                ),
            ));
        }
        self.catalog.remove(id)?;
        Ok(())
    }

    async fn write_instance(
        &self,
        remote: &Remote,
        d: &DestinationRow,
        now: i64,
    ) -> anyhow::Result<()> {
        let held = self.catalog.held(d.id)?;
        let body = serde_json::json!({
            "schema": 1,
            "instance_id": self.catalog.instance_id()?,
            "quiet_version": env!("CARGO_PKG_VERSION"),
            "first_hour": held.first_hour,
            "last_hour": held.last_hour,
            "hours": held.hours,
            "written_at": now,
        });
        remote
            .put(
                &ObjPath::from(remote::instance_key(&d.prefix)),
                PutPayload::from(serde_json::to_vec_pretty(&body)?),
            )
            .await?;
        Ok(())
    }

    /// Build, compress, upload and check one hour. `None`: nothing left in
    /// it after excluded sources (recorded as an `excluded` gap).
    pub async fn archive_hour(
        &self,
        store: &dyn Store,
        d: &DestinationRow,
        remote: &Remote,
        hour: i64,
        exclude: &[String],
        now: i64,
    ) -> anyhow::Result<Option<HourRecord>> {
        std::fs::create_dir_all(&self.tmp)?;
        let file = self.tmp.join(format!("{hour}.seg"));
        let stats = store.build_segment(hour, exclude, &file).await;
        let stats = match stats {
            Ok(s) => s,
            Err(e) => {
                let _ = std::fs::remove_file(&file);
                return Err(e);
            }
        };
        if stats.lines == 0 {
            let _ = std::fs::remove_file(&file);
            return Ok(None);
        }
        let f2 = file.clone();
        let (zst, sha) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let raw = std::fs::read(&f2)?;
            let z = zstd::encode_all(raw.as_slice(), 3)?;
            let sha = hex(&sha2::Sha256::digest(&z));
            Ok((z, sha))
        })
        .await??;
        let _ = std::fs::remove_file(&file);
        let key = remote::hour_key(&d.prefix, hour);
        let size = zst.len() as u64;
        remote
            .put(&ObjPath::from(key.clone()), PutPayload::from(zst))
            .await?;
        let rec = HourRecord {
            hour,
            destination_id: d.id,
            key: key.clone(),
            lines: stats.lines,
            bytes_raw: stats.bytes_raw,
            bytes_stored: size,
            sources: stats.sources,
            min_ts: stats.min_ts,
            max_ts: stats.max_ts,
            sha256: sha,
            archived_at: now,
        };
        let manifest = serde_json::json!({
            "schema": 1,
            "format": "sqlite",
            "compression": "zstd",
            "instance_id": self.catalog.instance_id()?,
            "hour": hour,
            "start": chrono::DateTime::from_timestamp_millis(hour * HOUR).map(|t| t.to_rfc3339()),
            "key": key,
            "lines": rec.lines,
            "bytes_raw": rec.bytes_raw,
            "bytes_stored": rec.bytes_stored,
            "sources": rec.sources,
            "min_ts": rec.min_ts,
            "max_ts": rec.max_ts,
            "sha256": rec.sha256,
            "created_at": now,
            "redaction": "lines were sanitized before storage (credentials [REDACTED])",
        });
        remote
            .put(
                &ObjPath::from(remote::manifest_key(&d.prefix, hour)),
                PutPayload::from(serde_json::to_vec_pretty(&manifest)?),
            )
            .await?;
        let head = remote.head(&ObjPath::from(key.clone())).await?;
        if head.size != size {
            anyhow::bail!("uploaded {key} is {} bytes, expected {size}", head.size);
        }
        self.catalog.add_hour(&rec)?;
        Ok(Some(rec))
    }

    /// The retention job's archive step: every stored hour that ends at or
    /// before `cutoff`, oldest first, archived then dropped. Stops at the
    /// first failure and holds the rest locally (with backoff).
    pub async fn pass(
        &self,
        store: &dyn Store,
        cutoff: i64,
        exclude: &[String],
        now: i64,
        system: &SystemState,
    ) -> Pass {
        let Ok(Some(d)) = self.catalog.active() else {
            self.set_waiting(0, system);
            return Pass::default();
        };
        let expiring: Vec<i64> = match store.hours().await {
            Ok(h) => h.into_iter().filter(|h| (h + 1) * HOUR <= cutoff).collect(),
            Err(e) => {
                tracing::warn!(error = %e, "history: listing stored hours failed");
                return Pass::default();
            }
        };
        if expiring.is_empty() {
            self.set_waiting(0, system);
            return Pass::default();
        }
        let due = {
            let rt = self.runtime.lock().unwrap();
            rt.unavailable
                .as_ref()
                .filter(|u| u.destination_id == d.id)
                .is_none_or(|u| now >= u.next_retry)
        };
        if !due {
            self.set_waiting(expiring.len() as u64, system);
            return Pass {
                hold: true,
                waiting: expiring,
                ..Default::default()
            };
        }
        let remote = match self.remote(&d) {
            Ok(r) => r,
            Err(e) => {
                self.failed(&d, e, now, expiring.len() as u64, system);
                return Pass {
                    hold: true,
                    waiting: expiring,
                    ..Default::default()
                };
            }
        };
        let mut pass = Pass::default();
        for (i, &hour) in expiring.iter().enumerate() {
            let r = self
                .archive_hour(store, &d, &remote, hour, exclude, now)
                .await;
            match r {
                Ok(rec) => {
                    if rec.is_none() {
                        let _ = self.catalog.add_gap(hour, GapReason::Excluded, now);
                    }
                    if let Err(e) = store.drop_hour(hour).await {
                        tracing::warn!(hour, error = %e, "history: dropping an archived hour failed");
                    }
                    pass.archived.push(hour);
                }
                Err(e) => {
                    let left = &expiring[i..];
                    self.failed(&d, e, now, left.len() as u64, system);
                    pass.hold = true;
                    pass.waiting = left.to_vec();
                    return pass;
                }
            }
        }
        if !pass.archived.is_empty() {
            tracing::info!(
                hours = pass.archived.len(),
                destination = %d.name,
                "history: archived hours"
            );
            let _ = self.write_instance(&remote, &d, now).await;
        }
        self.runtime.lock().unwrap().unavailable = None;
        self.set_waiting(0, system);
        pass
    }

    fn set_waiting(&self, n: u64, system: &SystemState) {
        let mut rt = self.runtime.lock().unwrap();
        rt.waiting = n;
        if n == 0 {
            rt.unavailable = None;
            system.set_history_issue(None);
        }
    }

    fn failed(
        &self,
        d: &DestinationRow,
        e: anyhow::Error,
        now: i64,
        waiting: u64,
        system: &SystemState,
    ) {
        let mut rt = self.runtime.lock().unwrap();
        let attempts = rt
            .unavailable
            .as_ref()
            .filter(|u| u.destination_id == d.id)
            .map_or(1, |u| u.attempts + 1);
        let backoff = (BACKOFF_MS << (attempts - 1).min(5)).min(MAX_BACKOFF_MS);
        let error = format!("{e:#}");
        tracing::warn!(destination = %d.name, attempts, error = %error, "history: archive failed; hours wait locally");
        rt.unavailable = Some(Unavailable {
            destination_id: d.id,
            error: error.clone(),
            next_retry: now + backoff,
            attempts,
        });
        rt.waiting = waiting;
        system.set_history_issue(Some(Issue {
            kind: IssueKind::HistoryUnavailable,
            severity: Severity::Warn,
            title: format!("Retained history paused: {} unreachable", d.name),
            detail: format!(
                "{waiting} hour{} waiting on local disk · retrying in {}s · {error}",
                if waiting == 1 { "" } else { "s" },
                backoff / 1000
            ),
        }));
    }

    /// After the window and the cap ran: hours that left local storage
    /// without being archived become gaps (only once history was enabled).
    pub fn record_gaps(
        &self,
        before: &[i64],
        after: &[i64],
        cutoff: i64,
        pass: &Pass,
        now: i64,
    ) -> anyhow::Result<u64> {
        if self.catalog.enabled_at()?.is_none() {
            return Ok(0);
        }
        let active = self.catalog.active()?.is_some();
        let still: HashSet<i64> = after.iter().copied().collect();
        let archived: HashSet<i64> = pass.archived.iter().copied().collect();
        let waiting: HashSet<i64> = pass.waiting.iter().copied().collect();
        let mut n = 0;
        for &h in before {
            if still.contains(&h) || archived.contains(&h) || self.catalog.is_archived(h)? {
                continue;
            }
            let expiring = (h + 1) * HOUR <= cutoff;
            let reason = if waiting.contains(&h) {
                GapReason::DestinationUnavailable
            } else if !active && expiring {
                GapReason::NoDestination
            } else {
                GapReason::DiskCap
            };
            self.catalog.add_gap(h, reason, now)?;
            n += 1;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests;
