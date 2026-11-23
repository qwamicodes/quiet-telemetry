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
pub mod jobs;
pub mod remote;
pub mod search;
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
    /// Not run, because an earlier step failed ("Not run · write failed").
    #[serde(default)]
    pub skipped: bool,
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
    /// Waited while the active destination was full ("stop archiving")
    /// until the disk cap dropped it.
    AtCapacity,
}

impl GapReason {
    pub fn as_str(self) -> &'static str {
        match self {
            GapReason::NoDestination => "no_destination",
            GapReason::DestinationUnavailable => "destination_unavailable",
            GapReason::DiskCap => "disk_cap",
            GapReason::Excluded => "excluded",
            GapReason::AtCapacity => "at_capacity",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "no_destination" => GapReason::NoDestination,
            "destination_unavailable" => GapReason::DestinationUnavailable,
            "disk_cap" => GapReason::DiskCap,
            "excluded" => GapReason::Excluded,
            "at_capacity" => GapReason::AtCapacity,
            _ => return None,
        })
    }
}

/// What happens when the active destination is full (5b).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AtCapacity {
    /// Delete the oldest archived hours there to make room (like the local
    /// disk cap).
    #[default]
    Evict,
    /// Stop archiving: hours wait on local disk (banner); only the disk cap
    /// drops them, recorded as `at_capacity` gaps.
    Stop,
}

/// Settings → Storage → Policy (v1.1-10). One policy for every connector,
/// active or not, covering every source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct HistoryPolicy {
    /// Days archived hours are kept; `null`: indefinitely. Default 30.
    #[ts(type = "number | null")]
    pub retention_days: Option<u32>,
    pub at_capacity: AtCapacity,
    /// Size limit per connector, bytes; each connector's quiet data counts
    /// separately. `null`: no limit (an owner-set capacity or the Garage
    /// quota can still apply).
    #[ts(type = "number | null")]
    pub size_limit_bytes: Option<u64>,
    /// Who saved it last, and when (unix ms).
    #[ts(type = "string | null")]
    pub saved_by: Option<String>,
    #[ts(type = "number | null")]
    pub saved_at: Option<i64>,
}

/// History retention when no owner has chosen one (the agreed default).
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

impl Default for HistoryPolicy {
    fn default() -> Self {
        HistoryPolicy {
            retention_days: Some(DEFAULT_RETENTION_DAYS),
            at_capacity: AtCapacity::Evict,
            size_limit_bytes: None,
            saved_by: None,
            saved_at: None,
        }
    }
}

/// Smallest size limit per connector (1 GB).
pub const MIN_SIZE_LIMIT: u64 = 1_000_000_000;

/// Longest history window an owner can type, in days (100 years).
pub const MAX_RETENTION_DAYS: u32 = 36_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    /// Archive the complete hours still in the local window now.
    Backfill,
    /// Copy every hour of one destination to another.
    Copy,
    /// Delete a destination's history, then forget it.
    Delete,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Backfill => "backfill",
            JobKind::Copy => "copy",
            JobKind::Delete => "delete",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "backfill" => JobKind::Backfill,
            "copy" => JobKind::Copy,
            "delete" => JobKind::Delete,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    /// A delete was refused (cleanup blocked): retried with backoff or Retry.
    Blocked,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Running => "running",
            JobState::Blocked => "blocked",
            JobState::Done => "done",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "running" => JobState::Running,
            "blocked" => JobState::Blocked,
            "done" => JobState::Done,
            "failed" => JobState::Failed,
            "cancelled" => JobState::Cancelled,
            _ => return None,
        })
    }

    pub fn open(self) -> bool {
        matches!(self, JobState::Running | JobState::Blocked)
    }
}

/// A background job as the API shows it.
#[derive(Debug, Clone, Serialize, TS)]
pub struct HistoryJob {
    pub id: i64,
    pub kind: JobKind,
    pub state: JobState,
    /// Where hours go (backfill, copy) or are deleted from (delete).
    pub destination_id: Option<i64>,
    pub destination: Option<String>,
    /// Copy: where hours come from.
    pub source_id: Option<i64>,
    pub source: Option<String>,
    /// Hours to move, and hours moved so far.
    #[ts(type = "number")]
    pub total: u64,
    #[ts(type = "number")]
    pub done: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    pub error: Option<String>,
    pub next_retry: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CapacitySource {
    /// Set by an owner on the destination.
    Owner,
    /// The shared size limit per connector (Policy).
    Policy,
    /// The quota of the Garage bucket quiet set up.
    Garage,
}

/// What a shorter history window would delete (dry run).
#[derive(Debug, Clone, Serialize, TS)]
pub struct HistoryPreview {
    #[ts(type = "number | null")]
    pub retention_days: Option<u32>,
    /// Hours that start before this are deleted, unix ms.
    pub before: Option<i64>,
    #[ts(type = "number")]
    pub hours: u64,
    #[ts(type = "number")]
    pub lines: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    pub destinations: Vec<PreviewDestination>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct PreviewDestination {
    pub id: i64,
    pub name: String,
    #[ts(type = "number")]
    pub hours: u64,
    #[ts(type = "number")]
    pub bytes: u64,
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
    /// When the newest upload here finished (Overview: "Last upload 4s ago").
    #[ts(type = "number | null")]
    pub last_upload: Option<i64>,
    /// The last upload error while unavailable, and when it retries.
    pub error: Option<String>,
    pub next_retry: Option<i64>,
    pub created_at: i64,
    /// How much it may hold (5b): owner-set, or the Garage bucket quota.
    #[ts(type = "number | null")]
    pub capacity_bytes: Option<u64>,
    pub capacity_source: Option<CapacitySource>,
    /// Holds at least its capacity.
    pub at_capacity: bool,
    /// Its history is being deleted before it is forgotten.
    pub removing: bool,
    /// The last refused (or failed) delete and when cleanup tries again.
    pub cleanup_error: Option<String>,
    pub cleanup_retry_at: Option<i64>,
    /// Hours whose delete was refused ("cleanup blocked").
    #[ts(type = "number")]
    pub cleanup_blocked_hours: u64,
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
    /// Blank with a blank secret (Amazon S3 only): the credentials available
    /// to quiet's host (environment, instance, task or workload role).
    #[serde(default)]
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: String,
    /// For temporary credentials.
    #[serde(default)]
    #[ts(optional)]
    pub session_token: Option<String>,
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
    /// `""` clears it.
    #[serde(default)]
    #[ts(optional)]
    pub session_token: Option<String>,
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
    pub policy: HistoryPolicy,
    /// Archived hours older than this are deleted (`null`: kept indefinitely).
    pub retained_from: Option<i64>,
    /// Archived hours past the history window still to delete.
    #[ts(type = "number")]
    pub expired_hours: u64,
    #[ts(type = "number")]
    pub expired_bytes: u64,
    /// Complete hours in the local window not archived yet (Backfill offers them).
    #[ts(type = "number")]
    pub backfill_hours: u64,
    /// Newest first, at most 20.
    pub jobs: Vec<HistoryJob>,
}

#[derive(Debug)]
pub enum HistoryError {
    Invalid(String),
    NotFound,
    Conflict(&'static str, String),
    /// A shorter history window would delete archived hours: confirm first.
    ConfirmRequired(HistoryPreview),
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
    /// The Garage bucket's quota (bytes) when quiet set Garage up, and when
    /// it was last read.
    garage_quota: Option<u64>,
    garage_checked: Option<i64>,
}

pub struct History {
    pub catalog: Catalog,
    secrets: SecretBox,
    tmp: PathBuf,
    connector: Connector,
    runtime: Mutex<Runtime>,
    /// Wakes the background worker (a job was added, a policy changed).
    pub wake: tokio::sync::Notify,
    /// Set when quiet set Garage up (`QUIET_GARAGE_*`): its quota is read.
    garage: Option<garage::GarageEnv>,
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
    /// They wait because the active destination is full ("stop archiving").
    pub at_capacity: bool,
}

/// First hour kept under `policy` at `now` (hour number); older ones are
/// deleted. `None`: kept indefinitely.
pub fn retention_before(policy: &HistoryPolicy, now: i64) -> Option<i64> {
    policy
        .retention_days
        .map(|d| now.div_euclid(HOUR) - i64::from(d) * 24)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `5 GB`, `312 MB` (decimal units, like the disk cap).
pub fn fmt_bytes(b: u64) -> String {
    const UNITS: [(&str, u64); 4] = [
        ("TB", 1_000_000_000_000),
        ("GB", 1_000_000_000),
        ("MB", 1_000_000),
        ("KB", 1_000),
    ];
    for (u, n) in UNITS {
        if b >= n {
            let v = b as f64 / n as f64;
            return if v >= 10.0 || (v - v.round()).abs() < 0.05 {
                format!("{} {u}", v.round() as u64)
            } else {
                format!("{v:.1} {u}")
            };
        }
    }
    format!("{b} B")
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
            wake: tokio::sync::Notify::new(),
            garage: None,
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
            wake: tokio::sync::Notify::new(),
            garage: None,
        }
    }

    #[cfg(test)]
    pub fn with_connector(mut self, c: Connector) -> Self {
        self.connector = c;
        self
    }

    /// Read the Garage bucket quota for `garage-local` (capacity).
    pub fn with_garage(mut self, env: garage::GarageEnv) -> Self {
        self.garage = Some(env);
        self
    }

    #[cfg(test)]
    pub fn set_garage_quota(&self, q: Option<u64>) {
        let mut rt = self.runtime.lock().unwrap();
        rt.garage_quota = q;
        rt.garage_checked = Some(i64::MAX);
    }

    /// Effective capacity: owner-set, else the policy's size limit per
    /// connector, else the Garage quota for `garage-local`.
    pub fn capacity(&self, d: &DestinationRow) -> Option<(u64, CapacitySource)> {
        if let Some(c) = d.capacity_bytes {
            return Some((c, CapacitySource::Owner));
        }
        if let Some(c) = self.catalog.policy().ok().and_then(|p| p.size_limit_bytes) {
            return Some((c, CapacitySource::Policy));
        }
        if d.name == garage::NAME {
            if let Some(q) = self.runtime.lock().unwrap().garage_quota {
                return Some((q, CapacitySource::Garage));
            }
        }
        None
    }

    pub(crate) fn remote(&self, d: &DestinationRow) -> anyhow::Result<Remote> {
        let secret = self.secrets.open_sealed(&d.secret_enc)?;
        (self.connector)(d, &secret)
    }

    fn find(&self, id: i64) -> Result<DestinationRow, HistoryError> {
        self.catalog.destination(id)?.ok_or(HistoryError::NotFound)
    }

    fn view(&self, d: &DestinationRow) -> anyhow::Result<Destination> {
        let held = self.catalog.held(d.id)?;
        let blocked = self.catalog.blocked_hours(d.id)?;
        let cap = self.capacity(d);
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
            last_upload: held.last_archived_at,
            error: down.map(|u| u.error.clone()),
            next_retry: down.map(|u| u.next_retry),
            created_at: d.created_at,
            capacity_bytes: cap.map(|c| c.0),
            capacity_source: cap.map(|c| c.1),
            at_capacity: cap.is_some_and(|(c, _)| held.bytes_stored >= c),
            removing: d.removing,
            cleanup_error: d.cleanup_error.clone(),
            cleanup_retry_at: d.cleanup_retry_at,
            cleanup_blocked_hours: blocked,
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

    #[cfg(test)]
    pub fn status(&self) -> anyhow::Result<HistoryStatus> {
        self.status_at(chrono::Utc::now().timestamp_millis())
    }

    /// Status at `now`, without the backfill count (that needs the store:
    /// [`History::status_with`]).
    pub fn status_at(&self, now: i64) -> anyhow::Result<HistoryStatus> {
        let destinations = self.destinations()?;
        let enabled_at = self.catalog.enabled_at()?;
        let policy = self.catalog.policy()?;
        let before = retention_before(&policy, now);
        let (expired_hours, expired_bytes) = match before {
            Some(b) => {
                let old = self.catalog.hours_before(b)?;
                (old.len() as u64, old.iter().map(|h| h.bytes_stored).sum())
            }
            None => (0, 0),
        };
        Ok(HistoryStatus {
            enabled: enabled_at.is_some(),
            enabled_at,
            instance_id: self.catalog.instance_id()?,
            active: destinations.iter().find(|d| d.active).map(|d| d.id),
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
            policy,
            retained_from: before.map(|b| b * HOUR),
            expired_hours,
            expired_bytes,
            backfill_hours: 0,
            jobs: self.jobs(&destinations)?,
            destinations,
        })
    }

    /// Status including how many local hours Backfill would archive.
    pub async fn status_with(&self, store: &dyn Store, now: i64) -> anyhow::Result<HistoryStatus> {
        let mut st = self.status_at(now)?;
        st.backfill_hours = self.backfill_candidates(store, now).await?.len() as u64;
        Ok(st)
    }

    fn jobs(&self, destinations: &[Destination]) -> anyhow::Result<Vec<HistoryJob>> {
        let name = |id: Option<i64>| {
            id.and_then(|id| destinations.iter().find(|d| d.id == id))
                .map(|d| d.name.clone())
        };
        Ok(self
            .catalog
            .jobs(20)?
            .into_iter()
            .map(|j| HistoryJob {
                id: j.id,
                kind: j.kind,
                state: j.state,
                destination_id: j.destination_id,
                destination: name(j.destination_id),
                source_id: j.source_id,
                source: name(j.source_id),
                total: j.total,
                done: j.done,
                bytes: j.bytes,
                error: j.error,
                next_retry: j.next_retry,
                created_at: j.created_at,
                updated_at: j.updated_at,
            })
            .collect())
    }

    pub fn job(&self, id: i64) -> Result<HistoryJob, HistoryError> {
        let destinations = self.destinations()?;
        self.jobs(&destinations)?
            .into_iter()
            .find(|j| j.id == id)
            .or_else(|| {
                // Older than the newest 20: build it alone.
                let j = self.catalog.job(id).ok()??;
                Some(HistoryJob {
                    id: j.id,
                    kind: j.kind,
                    state: j.state,
                    destination_id: j.destination_id,
                    destination: None,
                    source_id: j.source_id,
                    source: None,
                    total: j.total,
                    done: j.done,
                    bytes: j.bytes,
                    error: j.error,
                    next_retry: j.next_retry,
                    created_at: j.created_at,
                    updated_at: j.updated_at,
                })
            })
            .ok_or(HistoryError::NotFound)
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
        let host = kind == DestinationKind::S3
            && access_key_id.trim().is_empty()
            && secret.trim().is_empty();
        if !host && (access_key_id.trim().is_empty() || secret.trim().is_empty()) {
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

    /// The row a new destination would be saved as (secret sealed).
    fn row_of(&self, n: &NewDestination, now: i64) -> Result<DestinationRow, HistoryError> {
        let instance = self.catalog.instance_id()?;
        Ok(DestinationRow {
            id: 0,
            name: n.name.trim().to_string(),
            kind: n.kind,
            endpoint: n
                .endpoint
                .as_deref()
                .map(|e| e.trim().trim_end_matches('/').to_string())
                .filter(|e| !e.is_empty()),
            region: n.region.clone().unwrap_or_default().trim().to_string(),
            bucket: n.bucket.trim().to_string(),
            prefix: remote::normalize_prefix(n.prefix.as_deref().unwrap_or(""), &instance),
            // Garage and most S3-compatible servers want path-style URLs.
            path_style: n.path_style.unwrap_or(matches!(
                n.kind,
                DestinationKind::Garage | DestinationKind::S3Compatible
            )),
            access_key_id: n.access_key_id.trim().to_string(),
            secret_enc: self.secrets.seal(&remote::pack(
                &n.secret_access_key,
                n.session_token.as_deref(),
            ))?,
            active: false,
            verified_at: None,
            last_verify: None,
            created_at: now,
            capacity_bytes: None,
            removing: false,
            cleanup_error: None,
            cleanup_retry_at: None,
            cleanup_attempts: 0,
        })
    }

    #[cfg(test)]
    pub(crate) fn check_s3_host(&self, n: &NewDestination) -> bool {
        Self::check_fields(
            &n.name,
            n.kind,
            n.endpoint.as_deref(),
            &n.bucket,
            &n.access_key_id,
            &n.secret_access_key,
        )
        .is_ok()
    }

    /// Test a connection without saving it (v1.1-05/06: "Test connection",
    /// then "Save connector").
    /// With `existing` and a blank key id or secret, the saved credentials of
    /// that connector are used (editing without re-entering the secret).
    pub async fn test(
        &self,
        n: &NewDestination,
        existing: Option<i64>,
        now: i64,
    ) -> Result<VerifyResult, HistoryError> {
        let mut n = n.clone();
        if let Some(id) = existing {
            let saved = self.find(id)?;
            let (secret, token) = remote::unpack(&self.secrets.open_sealed(&saved.secret_enc)?);
            if n.access_key_id.trim().is_empty() && !saved.access_key_id.is_empty() {
                n.access_key_id = saved.access_key_id.clone();
            }
            if n.secret_access_key.trim().is_empty() && !n.access_key_id.is_empty() {
                n.secret_access_key = secret;
                if n.session_token.is_none() {
                    n.session_token = token;
                }
            }
        }
        let n = &n;
        Self::check_fields(
            &n.name,
            n.kind,
            n.endpoint.as_deref(),
            &n.bucket,
            &n.access_key_id,
            &n.secret_access_key,
        )?;
        let row = self.row_of(n, now)?;
        Ok(match self.remote(&row) {
            Ok(r) => remote::verify(&r, &row.prefix, now).await,
            Err(e) => remote::unreachable(&e.to_string(), now),
        })
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
        let row = self.row_of(&n, now)?;
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
        let (old_secret, old_token) = remote::unpack(&self.secrets.open_sealed(&d.secret_enc)?);
        let secret = u
            .secret_access_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            // Host credentials (S3): a blank key id clears the saved secret.
            .unwrap_or_else(|| {
                if d.access_key_id.is_empty() {
                    String::new()
                } else {
                    old_secret
                }
            });
        let token = match u.session_token {
            Some(t) => Some(t.trim().to_string()).filter(|t| !t.is_empty()),
            None => old_token,
        };
        d.secret_enc = self
            .secrets
            .seal(&remote::pack(&secret, token.as_deref()))?;
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
            Err(e) => remote::unreachable(&format!("{e:#}"), now),
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
    /// With `copy_history`, the previously active destination's hours are
    /// copied to it in the background; both stay searchable meanwhile.
    pub async fn activate(
        &self,
        id: i64,
        copy_history: bool,
        now: i64,
    ) -> Result<Destination, HistoryError> {
        let d = self.find(id)?;
        if d.removing {
            return Err(HistoryError::Conflict(
                "removing",
                format!("{}'s history is being deleted", d.name),
            ));
        }
        let previous = self.catalog.active()?.filter(|p| p.id != id);
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
        if copy_history {
            if let Some(prev) = previous {
                self.start_copy(&prev, &d, now)?;
            }
        }
        self.destination(id)
    }

    /// Copy every hour `from` holds that `to` doesn't (a background job).
    pub fn start_copy(
        &self,
        from: &DestinationRow,
        to: &DestinationRow,
        now: i64,
    ) -> Result<HistoryJob, HistoryError> {
        if let Some(j) = self.catalog.open_jobs()?.into_iter().find(|j| {
            j.kind == JobKind::Copy
                && j.source_id == Some(from.id)
                && j.destination_id == Some(to.id)
        }) {
            return self.job(j.id);
        }
        let total = self.copy_remaining(from.id, to.id)?.len() as u64;
        let id = self
            .catalog
            .add_job(JobKind::Copy, Some(to.id), Some(from.id), total, now)?;
        self.wake.notify_one();
        self.job(id)
    }

    /// Stop archiving: no destination receives new hours. What was archived
    /// stays searchable; hours leaving the local window are deleted again.
    pub fn turn_off(&self) -> Result<(), HistoryError> {
        self.catalog.clear_active()?;
        self.runtime.lock().unwrap().unavailable = None;
        Ok(())
    }

    /// Forget a destination. `delete_history: false` leaves its objects in
    /// the bucket (reconnect + reindex brings them back); `true` deletes
    /// them first in a background job, then forgets it.
    pub fn remove(
        &self,
        id: i64,
        delete_history: bool,
        now: i64,
    ) -> Result<Option<HistoryJob>, HistoryError> {
        let d = self.find(id)?;
        if d.active {
            return Err(HistoryError::Conflict(
                "active",
                format!(
                    "{} is the active destination: make another one active or turn retained history off first",
                    d.name
                ),
            ));
        }
        let open = self
            .catalog
            .open_jobs()?
            .into_iter()
            .find(|j| j.kind == JobKind::Delete && j.destination_id == Some(id));
        if let Some(j) = open {
            return Ok(Some(self.job(j.id)?));
        }
        if !delete_history {
            self.catalog.remove(id)?;
            return Ok(None);
        }
        let total = self.catalog.held(id)?.hours;
        self.catalog.set_removing(id, true)?;
        let job = self
            .catalog
            .add_job(JobKind::Delete, Some(id), None, total, now)?;
        self.wake.notify_one();
        Ok(Some(self.job(job)?))
    }

    /// Owner-set capacity in bytes; `None` clears it.
    pub fn set_capacity(&self, id: i64, bytes: Option<u64>) -> Result<Destination, HistoryError> {
        self.find(id)?;
        if bytes.is_some_and(|b| b < 1_000_000) {
            return Err(HistoryError::Invalid("capacity: at least 1 MB".into()));
        }
        self.catalog.set_capacity(id, bytes)?;
        self.wake.notify_one();
        self.destination(id)
    }

    /// Try a blocked cleanup now (Retry).
    pub fn retry_cleanup(&self, id: i64) -> Result<Destination, HistoryError> {
        let d = self.find(id)?;
        self.catalog
            .set_cleanup(id, d.cleanup_error.as_deref(), None, d.cleanup_attempts)?;
        for mut j in self.catalog.open_jobs()? {
            if j.destination_id == Some(id) && j.kind == JobKind::Delete {
                j.next_retry = None;
                j.state = JobState::Running;
                self.catalog.save_job(&j)?;
            }
        }
        self.wake.notify_one();
        self.destination(id)
    }

    /// What `retention_days` would delete now.
    pub fn preview(&self, retention_days: Option<u32>, now: i64) -> anyhow::Result<HistoryPreview> {
        let policy = HistoryPolicy {
            retention_days,
            ..Default::default()
        };
        let before = retention_before(&policy, now);
        let old = match before {
            Some(b) => self.catalog.hours_before(b)?,
            None => Vec::new(),
        };
        let mut destinations: Vec<PreviewDestination> = Vec::new();
        for h in &old {
            match destinations.iter_mut().find(|d| d.id == h.destination_id) {
                Some(d) => {
                    d.hours += 1;
                    d.bytes += h.bytes_stored;
                }
                None => destinations.push(PreviewDestination {
                    id: h.destination_id,
                    name: self
                        .catalog
                        .destination(h.destination_id)?
                        .map(|d| d.name)
                        .unwrap_or_default(),
                    hours: 1,
                    bytes: h.bytes_stored,
                }),
            }
        }
        Ok(HistoryPreview {
            retention_days,
            before: before.map(|b| b * HOUR),
            hours: old.len() as u64,
            lines: old.iter().map(|h| h.lines).sum(),
            bytes: old.iter().map(|h| h.bytes_stored).sum(),
            destinations,
        })
    }

    /// Save the history policy. A window that deletes archived hours needs
    /// `confirm` (else [`HistoryError::ConfirmRequired`] with the preview).
    pub fn set_policy(
        &self,
        p: HistoryPolicy,
        confirm: bool,
        now: i64,
    ) -> Result<HistoryPolicy, HistoryError> {
        if let Some(d) = p.retention_days {
            if d == 0 || d > MAX_RETENTION_DAYS {
                return Err(HistoryError::Invalid(format!(
                    "retention_days: 1 to {MAX_RETENTION_DAYS}, or null to keep history indefinitely"
                )));
            }
        }
        let preview = self.preview(p.retention_days, now)?;
        if preview.hours > 0 && !confirm {
            return Err(HistoryError::ConfirmRequired(preview));
        }
        self.catalog.set_policy(&p)?;
        self.wake.notify_one();
        Ok(p)
    }

    /// Archive the complete hours still in the local window now.
    pub async fn backfill(&self, store: &dyn Store, now: i64) -> Result<HistoryJob, HistoryError> {
        let Some(active) = self.catalog.active()? else {
            return Err(HistoryError::Conflict(
                "no_destination",
                "connect and turn on a destination first".into(),
            ));
        };
        if let Some(j) = self
            .catalog
            .open_jobs()?
            .into_iter()
            .find(|j| j.kind == JobKind::Backfill)
        {
            return self.job(j.id);
        }
        let n = self.backfill_candidates(store, now).await?.len() as u64;
        if n == 0 {
            return Err(HistoryError::Conflict(
                "nothing_to_backfill",
                "every complete hour in the local window is archived".into(),
            ));
        }
        let id = self
            .catalog
            .add_job(JobKind::Backfill, Some(active.id), None, n, now)?;
        self.wake.notify_one();
        self.job(id)
    }

    /// Complete local hours (ended before `now`) the active destination
    /// doesn't hold yet. Empty without an active destination.
    pub async fn backfill_candidates(
        &self,
        store: &dyn Store,
        now: i64,
    ) -> anyhow::Result<Vec<i64>> {
        let Some(active) = self.catalog.active()? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for h in store.hours().await? {
            if (h + 1) * HOUR <= now && self.catalog.hour_of(active.id, h)?.is_none() {
                out.push(h);
            }
        }
        Ok(out)
    }

    /// Hours `from` holds that `to` doesn't, oldest first.
    pub fn copy_remaining(&self, from: i64, to: i64) -> anyhow::Result<Vec<HourRecord>> {
        let mut out = Vec::new();
        for h in self.catalog.hours_of(from)? {
            if self.catalog.hour_of(to, h.hour)?.is_none() {
                out.push(h);
            }
        }
        Ok(out)
    }

    pub fn cancel_job(&self, id: i64, now: i64) -> Result<HistoryJob, HistoryError> {
        let mut j = self.catalog.job(id)?.ok_or(HistoryError::NotFound)?;
        if !j.state.open() {
            return Err(HistoryError::Conflict(
                "finished",
                "this job has already finished".into(),
            ));
        }
        j.state = JobState::Cancelled;
        j.updated_at = now;
        self.catalog.save_job(&j)?;
        if j.kind == JobKind::Delete {
            if let Some(d) = j.destination_id {
                // What is left stays, read-only and searchable.
                self.catalog.set_removing(d, false)?;
            }
        }
        self.job(id)
    }

    pub fn retry_job(&self, id: i64, now: i64) -> Result<HistoryJob, HistoryError> {
        let mut j = self.catalog.job(id)?.ok_or(HistoryError::NotFound)?;
        if matches!(j.state, JobState::Done | JobState::Cancelled) {
            return Err(HistoryError::Conflict(
                "finished",
                "this job has already finished".into(),
            ));
        }
        j.state = JobState::Running;
        j.next_retry = None;
        j.updated_at = now;
        self.catalog.save_job(&j)?;
        if let (JobKind::Delete, Some(d)) = (j.kind, j.destination_id) {
            if let Some(row) = self.catalog.destination(d)? {
                self.catalog.set_cleanup(
                    d,
                    row.cleanup_error.as_deref(),
                    None,
                    row.cleanup_attempts,
                )?;
            }
        }
        self.wake.notify_one();
        self.job(id)
    }

    pub(crate) async fn write_instance(
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

    /// `<prefix>v1/manifest/<hour>.json` for an archived hour.
    pub(crate) async fn put_manifest(
        &self,
        remote: &Remote,
        d: &DestinationRow,
        rec: &HourRecord,
        now: i64,
    ) -> anyhow::Result<()> {
        let manifest = serde_json::json!({
            "schema": 1,
            "format": "sqlite",
            "compression": "zstd",
            "instance_id": self.catalog.instance_id()?,
            "hour": rec.hour,
            "start": chrono::DateTime::from_timestamp_millis(rec.hour * HOUR).map(|t| t.to_rfc3339()),
            "key": rec.key,
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
                &ObjPath::from(remote::manifest_key(&d.prefix, rec.hour)),
                PutPayload::from(serde_json::to_vec_pretty(&manifest)?),
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
        // Backfilled earlier and unchanged since: nothing to upload.
        if let Some(prev) = self.catalog.hour_of(d.id, hour)? {
            if prev.lines == stats.lines && prev.bytes_raw == stats.bytes_raw {
                let _ = std::fs::remove_file(&file);
                return Ok(Some(prev));
            }
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
        self.put_manifest(remote, d, &rec, now).await?;
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
            system.set_history_issue_of(IssueKind::HistoryAtCapacity, None);
            return Pass::default();
        }
        // Full, and the policy says stop: hours wait on local disk.
        if let Some((cap, _)) = self.capacity(&d) {
            let used = self.catalog.held(d.id).map(|h| h.bytes_stored).unwrap_or(0);
            let stop = self
                .catalog
                .policy()
                .map(|p| p.at_capacity == AtCapacity::Stop)
                .unwrap_or(false);
            if stop && used >= cap {
                let n = expiring.len() as u64;
                self.runtime.lock().unwrap().waiting = n;
                system.set_history_issue_of(
                    IssueKind::HistoryAtCapacity,
                    Some(Issue {
                        kind: IssueKind::HistoryAtCapacity,
                        severity: Severity::Warn,
                        title: format!("Retained history full: {} holds its capacity", d.name),
                        detail: format!(
                            "{} of {} · {n} hour{} waiting on local disk · raise the capacity, shorten history or switch to evict oldest",
                            crate::history::fmt_bytes(used),
                            crate::history::fmt_bytes(cap),
                            if n == 1 { "" } else { "s" },
                        ),
                    }),
                );
                return Pass {
                    hold: true,
                    waiting: expiring,
                    at_capacity: true,
                    ..Default::default()
                };
            }
        }
        system.set_history_issue_of(IssueKind::HistoryAtCapacity, None);
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
            let reason = if waiting.contains(&h) && pass.at_capacity {
                GapReason::AtCapacity
            } else if waiting.contains(&h) {
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
