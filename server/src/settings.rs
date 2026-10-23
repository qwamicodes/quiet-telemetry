//! Instance settings changed from the UI, persisted in `quiet.db`.
//!
//! One table, `settings (k, v, updated, by)`, with a JSON value per key:
//! `general`, `storage`, `flow_ids`, `grouping`, `source_groups` (custom
//! groups and manual assignments) and `source:<name>` (one per source with
//! settings). Everything is read into memory at startup; writes go to SQLite
//! first, then to memory, so a failed write changes nothing.
//!
//! **Precedence** (storage): a value saved in the UI wins over the
//! `--retention` / `--max-disk` flags (`QUIET_RETENTION` / `QUIET_MAX_DISK`),
//! which win over the built-in defaults (24h, 5GB). "Use the flag value" in
//! the UI deletes the saved value, so the flag applies again. Each value
//! reports where it came from ([`Origin`]).
//!
//! Changes apply at runtime: the retention job is woken ([`Settings::changed`]),
//! the pipeline reads `paused` per batch, and the correlation-id policy is
//! re-installed for `normalize` (see `idpolicy.rs`).

use crate::grouping::{
    self, clean_group_name, CustomGroup, CustomGroups, GroupMode, Grouping, DEFAULT_GROUP_LABEL,
    MAX_ASSIGNMENTS, MAX_CUSTOM_GROUPS,
};
use crate::idpolicy::{self, IdPolicy};
use crate::normalize::{IdKey, Level};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, RwLock};
use tokio::sync::Notify;
use ts_rs::TS;

pub const HOUR_MS: i64 = 3_600_000;
pub const MIN_RETENTION_MS: i64 = HOUR_MS;
pub const MAX_RETENTION_MS: i64 = 7 * 24 * HOUR_MS;
pub const DEFAULT_RETENTION_MS: i64 = 24 * HOUR_MS;
pub const DEFAULT_MAX_DISK: u64 = 5_000_000_000;
pub const MIN_MAX_DISK: u64 = 10_000_000;
/// Far beyond any disk quiet will see; keeps the number JSON-safe.
pub const MAX_MAX_DISK: u64 = 100_000_000_000_000;

// ---- wire types -------------------------------------------------------------------

/// Where the newest line sits in the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamDirection {
    /// Like a terminal tail (the default).
    #[default]
    Bottom,
    Top,
}

/// How rows show their time (Settings → General → Timestamps).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
pub enum TimestampFormat {
    /// `14:07:35`
    Seconds,
    /// `14:07:35.412` (the default).
    #[default]
    Millis,
    /// `2s ago`
    Relative,
}

pub const DEFAULT_MAX_LINE_BYTES: u32 = 64 * 1024;
pub const MIN_MAX_LINE_BYTES: u32 = 1024;
pub const MAX_MAX_LINE_BYTES: u32 = 4 * 1024 * 1024;

/// Settings → General.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct GeneralSettings {
    /// Browser tab, user menu and "Join <name>" on invite links.
    pub instance_name: String,
    /// Default for everyone; each browser can still flip it in the stream.
    pub stream_direction: StreamDirection,
    /// `local` (each viewer's browser zone), `UTC`, or an IANA zone like `Africa/Accra`.
    pub timezone: String,
    /// Where people reach quiet (`https://quiet.example.com`), used in invite
    /// links and Connect snippets. `null` uses the browser's address.
    pub public_url: Option<String>,
    pub timestamps: TimestampFormat,
    /// Longer lines are cut to this many bytes and flagged `truncated:<bytes>`.
    pub max_line_bytes: u32,
    /// Off drops plain-text (non-JSON) lines at ingest.
    pub keep_non_json: bool,
    /// Settings → About checks GitHub releases from the browser when on.
    pub check_updates: bool,
    /// Include muted lines in search results (dimmed, tagged `muted`) for
    /// sources that don't decide for themselves. `null` = the
    /// `--search-include-muted` flag, else off. In effect: [`MutedSearch`].
    #[ts(type = "boolean | null")]
    pub search_include_muted: Option<bool>,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        GeneralSettings {
            instance_name: "quiet".into(),
            stream_direction: StreamDirection::Bottom,
            timezone: "local".into(),
            public_url: None,
            timestamps: TimestampFormat::Millis,
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            keep_non_json: true,
            check_updates: false,
            search_include_muted: None,
        }
    }
}

/// Where an effective storage value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Saved in Settings → Storage.
    Setting,
    /// `--retention` / `--max-disk` (or their env vars).
    Flag,
    /// Built in (24h, 5GB).
    Default,
}

/// Settings → Storage, as in effect now.
#[derive(Debug, Clone, Serialize, TS)]
pub struct StorageSettings {
    /// How long lines stay searchable, ms (1h … 7d).
    pub retention_ms: i64,
    pub retention_origin: Origin,
    /// Disk cap for the database, bytes.
    pub max_disk: u64,
    pub max_disk_origin: Origin,
    /// What the flags (or built-in defaults) say, for "use the flag value".
    pub flag_retention_ms: i64,
    pub flag_max_disk: u64,
    /// What happens at the cap. Only one behaviour in v0.1.
    #[ts(type = "\"drop_oldest_hour\"")]
    pub at_cap: String,
}

/// `PUT /api/settings/storage`. `null` clears the saved value (the flag applies).
#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateStorage {
    #[ts(optional, type = "number | null")]
    #[serde(default, deserialize_with = "nullable")]
    pub retention_ms: Option<Option<i64>>,
    #[ts(optional, type = "number | null")]
    #[serde(default, deserialize_with = "nullable")]
    pub max_disk: Option<Option<u64>>,
}

/// Absent → `None` (leave as is); `null` → `Some(None)` (clear).
fn valid_public_url(u: &str) -> bool {
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"));
    match rest {
        Some(r) => {
            let host = r.split('/').next().unwrap_or("");
            u.len() <= 200
                && !host.is_empty()
                && !u.chars().any(|c| c.is_whitespace() || c.is_control())
        }
        None => false,
    }
}

fn nullable<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// How flows stitch (Settings → Flow id order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct FlowIdSettings {
    /// Keys that count as correlation ids, in display order. Keys left out
    /// are ignored everywhere (rows, index, stitching).
    pub order: Vec<IdKey>,
    /// `value` (default): an id links lines whatever key carries it (a
    /// `request_id` passed on as a job's `data.request_id` still links).
    /// `key`: only lines carrying it under the same key link, so a numeric
    /// `job_id` 42 never merges with an unrelated `request_id` 42.
    pub match_by: MatchBy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
pub enum MatchBy {
    #[default]
    Value,
    Key,
}

impl Default for FlowIdSettings {
    fn default() -> Self {
        FlowIdSettings {
            order: idpolicy::ALL.to_vec(),
            match_by: MatchBy::Value,
        }
    }
}

/// Built-in PII groups masked in exports (and, per source, switchable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PiiKind {
    Email,
    Phone,
    Name,
    Ip,
    UserAgent,
}

/// Sources → a source → Settings. Every field is optional/empty by default,
/// meaning "as the instance does".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SourceSettings {
    /// Shown in the sidebar, stream and flows; stored lines keep the real name.
    pub display_name: Option<String>,
    /// Hidden from the sidebar and the stream's source list (still stored).
    pub hidden: bool,
    /// Ingest paused: new lines from this source are dropped (and counted).
    pub paused: bool,
    /// Shorter window for this source, ms; never longer than the instance's.
    pub retention_ms: Option<i64>,
    /// Correlation-id keys for this source, in order; `null` = instance order.
    pub id_keys: Option<Vec<IdKey>>,
    /// Level filter the stream opens with for this source.
    pub default_level: Option<Level>,
    /// Extra field keys masked for this source (e.g. `customer.address`).
    pub mask_fields: Vec<String>,
    /// Built-in PII groups NOT masked for this source.
    pub unmasked: Vec<PiiKind>,
    /// Muted lines (board 06.3): lines matching any rule are hidden from the
    /// stream and search by default ("N muted · show"); still stored,
    /// counted and searchable. Matching happens in the browser.
    pub muted: Vec<MuteRule>,
    /// Include this source's muted lines in search results; `null` = as
    /// Settings → Muted lines says. The stream always hides them.
    #[ts(type = "boolean | null")]
    pub search_include_muted: Option<bool>,
    /// Global rules this source switched off for itself ("Don't apply here").
    pub muted_global_off: Vec<GlobalOff>,
}

/// What a muted-lines rule compares (boards 03.16, 06.14–06.17).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MuteShape {
    /// The line's route, any method: the first of `route`, `path`,
    /// `http.route`, `req.url`, `url` that matches, with scheme, host,
    /// `?query` and `#hash` dropped. `*` matches within one path segment.
    Route,
    /// [`MuteShape::Route`] plus the request method (`method:GET`).
    MethodRoute,
    /// The message (`msg` / `message`, else the row summary) equals `value`.
    Message,
    /// `field` = `value`, where `*` matches any run of characters.
    #[default]
    Field,
    /// `value` appears anywhere in the raw line (rules from before v0.1's
    /// rule shapes that named no field).
    Text,
}

/// Where a rule applies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MuteScope {
    /// One source (Sources → edit → Muted lines).
    #[default]
    Source,
    /// Every source, including new ones (Settings → Muted lines).
    Global,
}

/// How a rule was added.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MuteOrigin {
    /// From the rule editor.
    #[default]
    Manual,
    /// From a stream row's Mute button (03.15).
    Hover,
}

/// One muted-lines rule (boards 03.16, 06.13, 07.12). Lines matching any
/// enabled rule that applies to their source are hidden from the stream and
/// search; they are still stored and searchable.
///
/// Rules saved before rule shapes (`{ field, value }`) read as
/// [`MuteShape::Field`] (or [`MuteShape::Text`] without a field, or
/// [`MuteShape::Message`] for `msg`) and get an id when loaded; they match
/// exactly as before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct MuteRule {
    /// `mr_` + 12 hex; stable across edits (undo, "Don't apply here").
    pub id: String,
    pub scope: MuteScope,
    /// Off = paused: kept (and still counted) but hides nothing.
    pub enabled: bool,
    pub shape: MuteShape,
    /// Field rules: the field's dot path. Route rules: the field the route
    /// was read from (shown as `path:`), informational only.
    pub field: Option<String>,
    /// The route, message, field value or text.
    pub value: String,
    /// Method + route rules: `GET`, `POST`, ….
    pub method: Option<String>,
    /// Who added it (account name).
    pub created_by: Option<String>,
    /// Unix ms.
    #[ts(type = "number | null")]
    pub created_at: Option<i64>,
    pub origin: MuteOrigin,
}

impl Default for MuteRule {
    fn default() -> Self {
        MuteRule {
            id: String::new(),
            scope: MuteScope::Source,
            enabled: true,
            shape: MuteShape::Field,
            field: None,
            value: String::new(),
            method: None,
            created_by: None,
            created_at: None,
            origin: MuteOrigin::Manual,
        }
    }
}

impl MuteRule {
    /// A rule as written before rule shapes: `field = value`, or text.
    pub fn legacy(field: Option<&str>, value: &str) -> Self {
        let mut r = MuteRule {
            field: field.map(String::from),
            value: value.into(),
            ..Default::default()
        };
        r.upgrade();
        r
    }

    /// Give a rule saved before rule shapes its shape (same matching as
    /// before). Returns whether anything changed. Ids are left to callers.
    fn upgrade(&mut self) -> bool {
        if !self.id.is_empty() || self.shape != MuteShape::Field {
            return false;
        }
        match self.field.as_deref() {
            None => self.shape = MuteShape::Text,
            Some("msg") | Some("message") => self.shape = MuteShape::Message,
            Some(_) => {}
        }
        true
    }

    /// Same rule, whatever its id, switch or history.
    pub fn same_as(&self, o: &MuteRule) -> bool {
        self.shape == o.shape
            && self.value.eq_ignore_ascii_case(&o.value)
            && self.method.as_deref().map(str::to_ascii_uppercase)
                == o.method.as_deref().map(str::to_ascii_uppercase)
            && (matches!(
                self.shape,
                MuteShape::Route | MuteShape::MethodRoute | MuteShape::Message
            ) || self.field == o.field)
    }
}

/// A new id for a muted-lines rule.
pub fn new_rule_id() -> String {
    let b: [u8; 6] = rand::random();
    format!("mr_{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// A global rule one source switched off for itself ("Don't apply here").
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct GlobalOff {
    /// The global rule's id.
    pub id: String,
    pub by: Option<String>,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
}

/// At most this many muted-lines rules per source.
pub const MAX_MUTE_RULES: usize = 32;
/// At most this many global muted-lines rules.
pub const MAX_GLOBAL_MUTE_RULES: usize = 64;

/// `POST /api/mute/rules`: a new rule, or a deleted one put back (Undo).
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(default)]
pub struct AddMuteRule {
    /// `scope` says where; `id` / `created_*` only when restoring.
    pub rule: MuteRule,
    /// Scope source: which one.
    #[ts(optional)]
    pub source: Option<String>,
    /// Scope global: delete the same rule from sources that have it (07.14).
    #[ts(optional)]
    pub remove_source_rules: bool,
    /// Restoring a global rule: the sources that had it switched off.
    #[ts(optional)]
    pub off_on: Vec<SourceOff>,
}

/// A global rule switched off on one source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct SourceOff {
    pub source: String,
    pub by: Option<String>,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
}

/// A source rule a new global rule replaced (07.14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct RemovedMuteRule {
    pub source: String,
    pub rule: MuteRule,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct AddedMuteRule {
    pub rule: MuteRule,
    pub removed: Vec<RemovedMuteRule>,
}

/// `PATCH /api/mute/rules/:id`: only what is sent changes.
#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct UpdateMuteRule {
    #[ts(optional)]
    #[serde(default)]
    pub enabled: Option<bool>,
    #[ts(optional)]
    #[serde(default)]
    pub shape: Option<MuteShape>,
    #[ts(optional, type = "string | null")]
    #[serde(default, deserialize_with = "nullable")]
    pub field: Option<Option<String>>,
    #[ts(optional)]
    #[serde(default)]
    pub value: Option<String>,
    #[ts(optional, type = "string | null")]
    #[serde(default, deserialize_with = "nullable")]
    pub method: Option<Option<String>>,
}

/// `DELETE /api/mute/rules/:id`: what went, for Undo.
#[derive(Debug, Clone, Serialize, TS)]
pub struct DeletedMuteRule {
    pub rule: MuteRule,
    /// The source it belonged to; `null` for a global rule.
    pub source: Option<String>,
    /// A global rule's "Don't apply here" switches that went with it.
    pub off_on: Vec<SourceOff>,
}

/// Drop `scheme://host`, `?query` and `#hash` from a route or URL: the path
/// as written (`https://x.io/a/b?c=1` → `/a/b`).
pub fn route_path(v: &str) -> String {
    let v = v.trim();
    let v = match v.find("://") {
        Some(i) if v[..i].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') => {
            let rest = &v[i + 3..];
            match rest.find('/') {
                Some(j) => &rest[j..],
                None => "/",
            }
        }
        _ => v,
    };
    let end = v.find(['?', '#']).unwrap_or(v.len());
    v[..end].to_string()
}

/// A rule from the API, checked and cleaned: trimmed, route values reduced
/// to their path, methods uppercased, sizes bounded.
pub fn clean_rule(mut r: MuteRule) -> Result<MuteRule, SettingsError> {
    r.field = r
        .field
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(String::from);
    r.value = r.value.trim().to_string();
    if matches!(r.shape, MuteShape::Route | MuteShape::MethodRoute) {
        r.value = route_path(&r.value);
    }
    if r.shape == MuteShape::Message {
        // `msg:"…"` typed whole.
        let v = r.value.strip_prefix("msg:").unwrap_or(&r.value).trim();
        r.value = v
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .unwrap_or(v)
            .to_string();
    }
    r.method = match r.shape {
        MuteShape::MethodRoute => r
            .method
            .as_deref()
            .map(|m| m.trim().to_ascii_uppercase())
            .filter(|m| !m.is_empty()),
        _ => None,
    };
    if r.value.is_empty() {
        return invalid("muted: the rule needs a value");
    }
    if r.shape == MuteShape::MethodRoute && r.method.is_none() {
        return invalid("muted: method + route needs a method");
    }
    if r.shape == MuteShape::Field && r.field.is_none() {
        // A fieldless rule has always been a text match.
        r.shape = MuteShape::Text;
    }
    if r.value.chars().count() > 256
        || r.value.chars().any(char::is_control)
        || r.field.as_ref().is_some_and(|f| {
            f.chars().count() > 128 || f.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        || r.method.as_ref().is_some_and(|m| {
            m.len() > 16 || !m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        || r.created_by.as_ref().is_some_and(|b| b.chars().count() > 128)
    {
        return invalid(
            "muted: field up to 128 characters (no spaces), value up to 256, method up to 16",
        );
    }
    if r.id.is_empty() {
        r.id = new_rule_id();
    } else if r.id.len() > 32 || !r.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return invalid("muted: bad rule id");
    }
    Ok(r)
}

/// Whether search includes muted lines, instance-wide, as in effect now
/// (sources can still say otherwise). Saved in Settings → General wins over
/// `--search-include-muted` (`QUIET_SEARCH_INCLUDE_MUTED`), which wins over off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
pub struct MutedSearch {
    pub include: bool,
    pub origin: Origin,
    /// What the flag (or the built-in off) says, for "use the server default".
    pub flag: bool,
}

/// `GET /api/settings`: everything at once (any signed-in user).
#[derive(Debug, Clone, Serialize, TS)]
pub struct SettingsResponse {
    pub general: GeneralSettings,
    pub storage: StorageSettings,
    pub muted_search: MutedSearch,
    pub grouping: GroupingSettings,
    pub flow_ids: FlowIdSettings,
    pub sources: BTreeMap<String, SourceSettings>,
    /// Global muted-lines rules (Settings → Muted lines), every source.
    pub muted_global: Vec<MuteRule>,
}

// ---- store ---------------------------------------------------------------------------

/// The flag/env values, the layer under saved settings.
#[derive(Debug, Clone)]
pub struct Defaults {
    pub retention_ms: i64,
    pub max_disk: u64,
    /// `--group-by` / `QUIET_GROUP_BY`. When set it wins over the UI and
    /// locks the Source grouping control (unlike storage, where the UI wins).
    pub group_by: Option<GroupMode>,
    /// `--group-label` / `QUIET_GROUP_LABEL` (also locks the control).
    pub group_label: Option<String>,
    /// `--search-include-muted` / `QUIET_SEARCH_INCLUDE_MUTED`; under
    /// Settings → General like the storage flags.
    pub search_include_muted: Option<bool>,
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults {
            retention_ms: DEFAULT_RETENTION_MS,
            max_disk: DEFAULT_MAX_DISK,
            group_by: None,
            group_label: None,
            search_include_muted: None,
        }
    }
}

/// Settings → General → Source grouping, as saved (`PUT /api/settings/grouping`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct UpdateGrouping {
    pub mode: GroupMode,
    /// The Docker label read in `label` mode (kept, unused, in the others).
    pub label: String,
}

/// The source grouping in effect and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct GroupingSettings {
    pub mode: GroupMode,
    pub label: String,
    /// `flag` when QUIET_GROUP_BY / QUIET_GROUP_LABEL is set (then `locked`).
    pub origin: Origin,
    /// Set in the server's environment: the UI shows it read-only.
    pub locked: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StorageOverride {
    retention_ms: Option<i64>,
    max_disk: Option<u64>,
}

/// How Docker containers map to source names, kept across restarts
/// (`settings` key `docker_identity`). See `receiver/docker.rs`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DockerIdentity {
    /// The one-time move from service-name sources has run.
    pub migrated: bool,
    /// Identity key → the older source name it keeps writing to.
    pub aliases: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
struct State {
    general: GeneralSettings,
    storage: StorageOverride,
    grouping: Option<UpdateGrouping>,
    custom_groups: CustomGroups,
    flow_ids: FlowIdSettings,
    sources: BTreeMap<String, SourceSettings>,
    docker_identity: DockerIdentity,
    muted_global: Vec<MuteRule>,
}

/// A settings write failed: bad input (400) or storage (503).
#[derive(Debug)]
pub enum SettingsError {
    Invalid(String),
    /// The thing to change is not there (404).
    NotFound(String),
    Store(anyhow::Error),
}

impl From<rusqlite::Error> for SettingsError {
    fn from(e: rusqlite::Error) -> Self {
        SettingsError::Store(e.into())
    }
}

impl From<serde_json::Error> for SettingsError {
    fn from(e: serde_json::Error) -> Self {
        SettingsError::Store(e.into())
    }
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, SettingsError> {
    Err(SettingsError::Invalid(msg.into()))
}

pub struct Settings {
    db: Mutex<Connection>,
    defaults: RwLock<Defaults>,
    state: RwLock<State>,
    /// Install the id policy process-wide (the server does; tests don't).
    publish: bool,
    /// Woken on every storage-affecting change (the retention job waits on
    /// it; `notify_one` keeps a permit if the job is mid-sweep).
    pub changed: Notify,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings").finish_non_exhaustive()
    }
}

impl Settings {
    /// Open the table in `path` (the main `quiet.db`) or in memory, and load it.
    pub fn open(path: Option<&Path>, defaults: Defaults, publish: bool) -> anyhow::Result<Self> {
        let db = match path {
            Some(p) => {
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                Connection::open(p)?
            }
            None => Connection::open_in_memory()?,
        };
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                 k TEXT PRIMARY KEY,
                 v TEXT NOT NULL,
                 updated INTEGER NOT NULL,
                 by INTEGER);",
        )?;
        let mut state = State::default();
        {
            let mut st = db.prepare("SELECT k, v FROM settings")?;
            let rows =
                st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (k, v) = row?;
                // A value this version can't read is skipped (and logged), never fatal.
                let ok = match k.as_str() {
                    "general" => serde_json::from_str(&v).map(|x| state.general = x),
                    "storage" => serde_json::from_str(&v).map(|x| state.storage = x),
                    "grouping" => serde_json::from_str(&v).map(|x| state.grouping = Some(x)),
                    "source_groups" => serde_json::from_str::<CustomGroups>(&v).map(|mut x| {
                        x.normalize();
                        state.custom_groups = x;
                    }),
                    "flow_ids" => serde_json::from_str(&v).map(|x| state.flow_ids = x),
                    "docker_identity" => {
                        serde_json::from_str(&v).map(|x| state.docker_identity = x)
                    }
                    "muted_global" => serde_json::from_str(&v).map(|x| state.muted_global = x),
                    k => match k.strip_prefix("source:") {
                        Some(name) => serde_json::from_str(&v).map(|x| {
                            state.sources.insert(name.to_string(), x);
                        }),
                        None => Ok(()),
                    },
                };
                if let Err(e) = ok {
                    tracing::warn!(key = k, error = %e, "ignoring unreadable setting");
                }
            }
        }
        let upgraded = upgrade_mute_rules(&mut state);
        let me = Settings {
            db: Mutex::new(db),
            defaults: RwLock::new(defaults),
            state: RwLock::new(state),
            publish,
            changed: Notify::new(),
        };
        // Rules saved before rule shapes keep matching as they did; they get
        // ids (and shapes) once, saved so the ids stay stable.
        for name in upgraded {
            let s = me.source(&name);
            if let Err(e) = serde_json::to_string(&s)
                .map_err(SettingsError::from)
                .and_then(|v| me.save(&format!("source:{name}"), Some(v), None))
            {
                tracing::warn!(source = name, error = ?e, "could not save upgraded muted-lines rules");
            }
        }
        me.install_policy();
        Ok(me)
    }

    /// In memory with built-in defaults; never installs the id policy (tests).
    #[cfg(test)]
    pub fn memory() -> Self {
        Settings::open(None, Defaults::default(), false).expect("in-memory sqlite")
    }

    fn save(&self, key: &str, value: Option<String>, by: Option<i64>) -> Result<(), SettingsError> {
        let db = self.db.lock().unwrap();
        match value {
            Some(v) => db.execute(
                "INSERT INTO settings (k, v, updated, by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (k) DO UPDATE SET v = ?2, updated = ?3, by = ?4",
                params![key, v, chrono::Utc::now().timestamp_millis(), by],
            )?,
            None => db.execute("DELETE FROM settings WHERE k = ?", [key])?,
        };
        Ok(())
    }

    fn install_policy(&self) {
        if !self.publish {
            return;
        }
        let g = self.grouping();
        grouping::install(Grouping {
            mode: g.mode,
            label: g.label,
        });
        let st = self.state.read().unwrap();
        idpolicy::install(IdPolicy {
            global: st.flow_ids.order.clone(),
            sources: st
                .sources
                .iter()
                .filter_map(|(k, v)| v.id_keys.clone().map(|o| (k.clone(), o)))
                .collect::<HashMap<_, _>>(),
        });
    }

    // ---- reads ----

    pub fn general(&self) -> GeneralSettings {
        self.state.read().unwrap().general.clone()
    }

    pub fn storage(&self) -> StorageSettings {
        let d = self.defaults.read().unwrap().clone();
        let o = self.state.read().unwrap().storage.clone();
        let flag_origin = |is_default: bool| {
            if is_default {
                Origin::Default
            } else {
                Origin::Flag
            }
        };
        StorageSettings {
            retention_ms: o.retention_ms.unwrap_or(d.retention_ms),
            retention_origin: if o.retention_ms.is_some() {
                Origin::Setting
            } else {
                flag_origin(d.retention_ms == DEFAULT_RETENTION_MS)
            },
            max_disk: o.max_disk.unwrap_or(d.max_disk),
            max_disk_origin: if o.max_disk.is_some() {
                Origin::Setting
            } else {
                flag_origin(d.max_disk == DEFAULT_MAX_DISK)
            },
            flag_retention_ms: d.retention_ms,
            flag_max_disk: d.max_disk,
            at_cap: "drop_oldest_hour".into(),
        }
    }

    /// Search's muted-lines default for the instance, and where it came from.
    pub fn muted_search(&self) -> MutedSearch {
        let flag = self.defaults.read().unwrap().search_include_muted;
        let saved = self.state.read().unwrap().general.search_include_muted;
        let (include, origin) = match (saved, flag) {
            (Some(v), _) => (v, Origin::Setting),
            (None, Some(v)) => (v, Origin::Flag),
            (None, None) => (false, Origin::Default),
        };
        MutedSearch {
            include,
            origin,
            flag: flag.unwrap_or(false),
        }
    }

    /// Whether search includes `source`'s muted lines: the source's own
    /// choice, else the instance's.
    pub fn search_includes_muted(&self, source: &str) -> bool {
        let own = self
            .state
            .read()
            .unwrap()
            .sources
            .get(source)
            .and_then(|s| s.search_include_muted);
        own.unwrap_or_else(|| self.muted_search().include)
    }

    /// The muted-lines rules hiding `source`'s lines now: its own enabled
    /// rules plus every enabled global rule it did not switch off (union).
    pub fn mute_rules(&self, source: &str) -> Vec<MuteRule> {
        let st = self.state.read().unwrap();
        let own = st.sources.get(source);
        let off = |id: &str| own.is_some_and(|s| s.muted_global_off.iter().any(|o| o.id == id));
        st.muted_global
            .iter()
            .filter(|r| r.enabled && !off(&r.id))
            .chain(own.map(|s| s.muted.as_slice()).unwrap_or_default().iter().filter(|r| r.enabled))
            .cloned()
            .collect()
    }

    /// Global muted-lines rules (Settings → Muted lines).
    pub fn muted_global(&self) -> Vec<MuteRule> {
        self.state.read().unwrap().muted_global.clone()
    }

    /// The searchable window now, ms.
    pub fn retention_ms(&self) -> i64 {
        self.storage().retention_ms
    }

    pub fn flow_ids(&self) -> FlowIdSettings {
        self.state.read().unwrap().flow_ids.clone()
    }

    pub fn source(&self, name: &str) -> SourceSettings {
        self.state
            .read()
            .unwrap()
            .sources
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    pub fn sources(&self) -> BTreeMap<String, SourceSettings> {
        self.state.read().unwrap().sources.clone()
    }

    pub fn paused(&self, name: &str) -> bool {
        self.state
            .read()
            .unwrap()
            .sources
            .get(name)
            .is_some_and(|s| s.paused)
    }

    /// Sources with a shorter window than the instance's: `(name, window ms)`.
    pub fn source_windows(&self) -> Vec<(String, i64)> {
        let global = self.retention_ms();
        self.state
            .read()
            .unwrap()
            .sources
            .iter()
            .filter_map(|(k, v)| v.retention_ms.map(|r| (k.clone(), r)))
            .filter(|(_, r)| *r < global)
            .collect()
    }

    pub fn all(&self) -> SettingsResponse {
        SettingsResponse {
            general: self.general(),
            storage: self.storage(),
            muted_search: self.muted_search(),
            grouping: self.grouping(),
            flow_ids: self.flow_ids(),
            sources: self.sources(),
            muted_global: self.muted_global(),
        }
    }

    /// Which source each Docker container writes to (aliases from the migration).
    pub fn docker_identity(&self) -> DockerIdentity {
        self.state.read().unwrap().docker_identity.clone()
    }

    /// Record the one-time Docker identity migration: `aliases` (identity key
    /// → old source it keeps), and for each old merged source in `split`, the
    /// keys that inherit its settings (all but the display name, which would
    /// show the merged name again) and its custom group. A new source that
    /// already has settings or a group of its own keeps them. The old source
    /// keeps its own settings and lines.
    pub fn finish_docker_migration(
        &self,
        aliases: BTreeMap<String, String>,
        split: &BTreeMap<String, Vec<String>>,
    ) -> Result<DockerIdentity, SettingsError> {
        let current = self.sources();
        for (old, keys) in split {
            let Some(inherited) = current.get(old).cloned() else {
                continue;
            };
            let inherited = SourceSettings {
                display_name: None,
                ..inherited
            };
            if inherited == SourceSettings::default() {
                continue;
            }
            for k in keys.iter().filter(|k| !current.contains_key(*k)) {
                // Each copy of a muted-lines rule is its own rule (own id).
                let mut copy = inherited.clone();
                for r in copy.muted.iter_mut() {
                    r.id = new_rule_id();
                }
                self.put_source(k, copy, None)?;
            }
        }
        let groups = self.custom_groups();
        if split.keys().any(|old| groups.assigned.contains_key(old)) {
            self.edit_custom_groups(None, |c| {
                for (old, keys) in split {
                    let Some(g) = c.assigned.get(old).cloned() else {
                        continue;
                    };
                    for k in keys {
                        if c.assigned.len() >= MAX_ASSIGNMENTS {
                            break;
                        }
                        c.assigned.entry(k.clone()).or_insert_with(|| g.clone());
                    }
                }
                Ok(())
            })?;
        }
        let mut ident = self.docker_identity();
        ident.migrated = true;
        ident.aliases.extend(aliases);
        self.save(
            "docker_identity",
            Some(serde_json::to_string(&ident)?),
            None,
        )?;
        self.state.write().unwrap().docker_identity = ident.clone();
        Ok(ident)
    }

    /// Custom groups and manual assignments (any signed-in user reads them).
    pub fn custom_groups(&self) -> CustomGroups {
        self.state.read().unwrap().custom_groups.clone()
    }

    /// The line-size cap and the non-JSON switch, read per ingest batch.
    pub fn ingest_rules(&self) -> (usize, bool) {
        let g = &self.state.read().unwrap().general;
        (g.max_line_bytes as usize, g.keep_non_json)
    }

    // ---- writes (callers check the owner role) ----

    pub fn put_general(
        &self,
        mut g: GeneralSettings,
        by: Option<i64>,
    ) -> Result<GeneralSettings, SettingsError> {
        g.instance_name = g.instance_name.trim().to_string();
        if g.instance_name.is_empty()
            || g.instance_name.chars().count() > 40
            || g.instance_name.chars().any(char::is_control)
        {
            return invalid("instance_name: 1–40 characters");
        }
        g.timezone = g.timezone.trim().to_string();
        if !valid_timezone(&g.timezone) {
            return invalid("timezone: `local`, `UTC` or an IANA zone like Africa/Accra");
        }
        g.public_url = g
            .public_url
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());
        if let Some(u) = &g.public_url {
            if !valid_public_url(u) {
                return invalid("public_url: an http(s) address like https://quiet.example.com");
            }
        }
        if !(MIN_MAX_LINE_BYTES..=MAX_MAX_LINE_BYTES).contains(&g.max_line_bytes) {
            return invalid("max_line_bytes: between 1 KB and 4 MB");
        }
        self.save("general", Some(serde_json::to_string(&g)?), by)?;
        self.state.write().unwrap().general = g.clone();
        Ok(g)
    }

    pub fn put_storage(
        &self,
        u: UpdateStorage,
        by: Option<i64>,
    ) -> Result<StorageSettings, SettingsError> {
        let mut o = self.state.read().unwrap().storage.clone();
        if let Some(r) = u.retention_ms {
            if let Some(ms) = r {
                if !(MIN_RETENTION_MS..=MAX_RETENTION_MS).contains(&ms) || ms % HOUR_MS != 0 {
                    return invalid("retention_ms: whole hours between 1h and 7d");
                }
            }
            o.retention_ms = r;
        }
        if let Some(m) = u.max_disk {
            if let Some(b) = m {
                if !(MIN_MAX_DISK..=MAX_MAX_DISK).contains(&b) {
                    return invalid("max_disk: at least 10 MB");
                }
            }
            o.max_disk = m;
        }
        let value = (o.retention_ms.is_some() || o.max_disk.is_some())
            .then(|| serde_json::to_string(&o))
            .transpose()?;
        self.save("storage", value, by)?;
        self.state.write().unwrap().storage = o;
        self.changed.notify_one();
        Ok(self.storage())
    }

    pub fn grouping(&self) -> GroupingSettings {
        let d = self.defaults.read().unwrap().clone();
        let saved = self.state.read().unwrap().grouping.clone();
        let locked = d.group_by.is_some() || d.group_label.is_some();
        let (mode, label, origin) = match (locked, saved) {
            (false, Some(u)) => (u.mode, u.label, Origin::Setting),
            (false, None) => (
                GroupMode::Auto,
                DEFAULT_GROUP_LABEL.to_string(),
                Origin::Default,
            ),
            (true, saved) => {
                let base = saved.unwrap_or(UpdateGrouping {
                    mode: GroupMode::Auto,
                    label: DEFAULT_GROUP_LABEL.into(),
                });
                (
                    d.group_by.unwrap_or(base.mode),
                    d.group_label.unwrap_or(base.label),
                    Origin::Flag,
                )
            }
        };
        GroupingSettings {
            mode,
            label,
            origin,
            locked,
        }
    }

    /// Save the source grouping, or `None` for the default (auto).
    /// Applies at once: `/api/sources` regroups on its next read. Refused
    /// while QUIET_GROUP_BY / QUIET_GROUP_LABEL is set.
    pub fn put_grouping(
        &self,
        u: Option<UpdateGrouping>,
        by: Option<i64>,
    ) -> Result<GroupingSettings, SettingsError> {
        if self.grouping().locked {
            return invalid("grouping: set by QUIET_GROUP_BY / QUIET_GROUP_LABEL on the server");
        }
        let u = match u {
            Some(mut u) => {
                u.label = u.label.trim().to_string();
                if u.label.is_empty() && u.mode != GroupMode::Label {
                    u.label = DEFAULT_GROUP_LABEL.into();
                }
                if !grouping::valid_label(&u.label) {
                    return invalid(
                        "label: a Docker label key (letters, digits, . - _ /), up to 128 characters",
                    );
                }
                Some(u)
            }
            None => None,
        };
        let value = u.as_ref().map(serde_json::to_string).transpose()?;
        self.save("grouping", value, by)?;
        self.state.write().unwrap().grouping = u;
        self.install_policy();
        Ok(self.grouping())
    }

    /// Change the custom groups with `f`, then normalize, save and keep.
    /// Not affected by the QUIET_GROUP_BY lock (that locks the mode only).
    fn edit_custom_groups<T>(
        &self,
        by: Option<i64>,
        f: impl FnOnce(&mut CustomGroups) -> Result<T, SettingsError>,
    ) -> Result<(T, CustomGroups), SettingsError> {
        // One writer at a time: hold the db lock across read-modify-write.
        let db = self.db.lock().unwrap();
        let mut next = self.state.read().unwrap().custom_groups.clone();
        let out = f(&mut next)?;
        next.normalize();
        let empty = next == CustomGroups::default();
        if empty {
            db.execute("DELETE FROM settings WHERE k = 'source_groups'", [])?;
        } else {
            db.execute(
                "INSERT INTO settings (k, v, updated, by) VALUES ('source_groups', ?1, ?2, ?3)
                 ON CONFLICT (k) DO UPDATE SET v = ?1, updated = ?2, by = ?3",
                params![
                    serde_json::to_string(&next)?,
                    chrono::Utc::now().timestamp_millis(),
                    by
                ],
            )?;
        }
        self.state.write().unwrap().custom_groups = next.clone();
        Ok((out, next))
    }

    /// Sources → New group, optionally with the sources picked in the dialog
    /// moved into it in the same write. Names are unique among custom groups
    /// (case-insensitive); the new group goes last among custom groups.
    pub fn create_group(
        &self,
        name: &str,
        sources: &[String],
        by: Option<i64>,
    ) -> Result<CustomGroup, SettingsError> {
        let name = clean_group_name(name).or_else(invalid)?;
        check_sources(sources, 0)?;
        let (g, _) = self.edit_custom_groups(by, |c| {
            if c.groups.len() >= MAX_CUSTOM_GROUPS {
                return invalid(format!("at most {MAX_CUSTOM_GROUPS} custom groups"));
            }
            if c.name_taken(&name, None) {
                return invalid(format!("a group named “{name}” already exists"));
            }
            let id = loop {
                let id = format!("g_{:08x}", rand::random::<u32>());
                if c.get(&id).is_none() {
                    break id;
                }
            };
            let g = CustomGroup {
                id,
                name,
                order: c.groups.len() as u32,
            };
            c.groups.push(g.clone());
            for s in sources {
                c.assigned.insert(s.clone(), g.id.clone());
            }
            if c.assigned.len() > MAX_ASSIGNMENTS {
                return invalid(format!(
                    "at most {MAX_ASSIGNMENTS} sources in custom groups"
                ));
            }
            Ok(g)
        })?;
        Ok(g)
    }

    /// Rename a custom group and/or move it to position `order` (clamped).
    /// `Ok(None)`: no such group.
    pub fn update_group(
        &self,
        id: &str,
        name: Option<&str>,
        order: Option<u32>,
        by: Option<i64>,
    ) -> Result<Option<CustomGroups>, SettingsError> {
        let name = name.map(clean_group_name).transpose().or_else(invalid)?;
        let (found, all) = self.edit_custom_groups(by, |c| {
            let Some(at) = c.groups.iter().position(|g| g.id == id) else {
                return Ok(false);
            };
            if let Some(n) = name {
                if c.name_taken(&n, Some(id)) {
                    return invalid(format!("a group named “{n}” already exists"));
                }
                c.groups[at].name = n;
            }
            if let Some(to) = order {
                let g = c.groups.remove(at);
                let to = (to as usize).min(c.groups.len());
                c.groups.insert(to, g);
            }
            Ok(true)
        })?;
        Ok(found.then_some(all))
    }

    /// Delete a custom group: its sources go back to their automatic group.
    /// `Ok(None)`: no such group.
    pub fn delete_group(
        &self,
        id: &str,
        by: Option<i64>,
    ) -> Result<Option<CustomGroups>, SettingsError> {
        let (found, all) = self.edit_custom_groups(by, |c| {
            let before = c.groups.len();
            c.groups.retain(|g| g.id != id);
            // normalize() drops the assignments to it.
            Ok(c.groups.len() != before)
        })?;
        Ok(found.then_some(all))
    }

    /// Move `sources` into custom group `group`, or back to automatic
    /// grouping with `None`.
    pub fn assign_sources(
        &self,
        sources: &[String],
        group: Option<&str>,
        by: Option<i64>,
    ) -> Result<CustomGroups, SettingsError> {
        check_sources(sources, 1)?;
        let (_, all) = self.edit_custom_groups(by, |c| {
            match group {
                Some(id) => {
                    if c.get(id).is_none() {
                        return invalid(format!("no custom group {id:?}"));
                    }
                    for s in sources {
                        c.assigned.insert(s.clone(), id.to_string());
                    }
                    if c.assigned.len() > MAX_ASSIGNMENTS {
                        return invalid(format!(
                            "at most {MAX_ASSIGNMENTS} sources in custom groups"
                        ));
                    }
                }
                None => {
                    for s in sources {
                        c.assigned.remove(s);
                    }
                }
            }
            Ok(())
        })?;
        Ok(all)
    }

    pub fn put_flow_ids(
        &self,
        f: FlowIdSettings,
        by: Option<i64>,
    ) -> Result<FlowIdSettings, SettingsError> {
        check_order(&f.order)?;
        self.save("flow_ids", Some(serde_json::to_string(&f)?), by)?;
        self.state.write().unwrap().flow_ids = f.clone();
        self.install_policy();
        Ok(f)
    }

    pub fn put_source(
        &self,
        name: &str,
        mut s: SourceSettings,
        by: Option<i64>,
    ) -> Result<SourceSettings, SettingsError> {
        if let Some(d) = &s.display_name {
            let d = d.trim();
            if d.chars().count() > 64 || d.chars().any(char::is_control) {
                return invalid("display_name: up to 64 characters");
            }
            s.display_name = (!d.is_empty() && d != name).then(|| d.to_string());
        }
        if let Some(r) = s.retention_ms {
            let global = self.retention_ms();
            if r < MIN_RETENTION_MS || r % HOUR_MS != 0 {
                return invalid("retention_ms: whole hours, at least 1h");
            }
            if r > global {
                return invalid(format!(
                    "retention_ms: a source can't keep lines longer than the instance ({}h)",
                    global / HOUR_MS
                ));
            }
        }
        if let Some(o) = &s.id_keys {
            check_order(o)?;
        }
        let mut fields: Vec<String> = Vec::new();
        for f in &s.mask_fields {
            let f = f.trim();
            if f.is_empty() {
                continue;
            }
            if f.chars().count() > 128 || f.chars().any(char::is_control) {
                return invalid("mask_fields: keys up to 128 characters");
            }
            if !fields.iter().any(|x| x == f) {
                fields.push(f.to_string());
            }
        }
        if fields.len() > 64 {
            return invalid("mask_fields: at most 64 keys");
        }
        s.mask_fields = fields;
        let mut muted: Vec<MuteRule> = Vec::new();
        for r in std::mem::take(&mut s.muted) {
            let mut r = r;
            r.upgrade();
            r.scope = MuteScope::Source;
            if r.value.trim().is_empty() {
                continue;
            }
            let r = clean_rule(r)?;
            if !muted.iter().any(|x| x.same_as(&r) || x.id == r.id) {
                muted.push(r);
            }
        }
        if muted.len() > MAX_MUTE_RULES {
            return invalid(format!("muted: at most {MAX_MUTE_RULES} rules"));
        }
        s.muted = muted;
        {
            let global = self.state.read().unwrap().muted_global.clone();
            let mut off: Vec<GlobalOff> = Vec::new();
            for o in std::mem::take(&mut s.muted_global_off) {
                if global.iter().any(|g| g.id == o.id) && !off.iter().any(|x| x.id == o.id) {
                    off.push(o);
                }
            }
            s.muted_global_off = off;
        }
        s.unmasked.sort_by_key(|k| *k as u8);
        s.unmasked.dedup();

        let key = format!("source:{name}");
        let value = (s != SourceSettings::default())
            .then(|| serde_json::to_string(&s))
            .transpose()?;
        self.save(&key, value, by)?;
        {
            let mut st = self.state.write().unwrap();
            if s == SourceSettings::default() {
                st.sources.remove(name);
            } else {
                st.sources.insert(name.to_string(), s.clone());
            }
        }
        self.install_policy();
        self.changed.notify_one();
        Ok(s)
    }

    /// Forget a source's settings (Reset / remove source).
    pub fn reset_source(&self, name: &str, by: Option<i64>) -> Result<(), SettingsError> {
        self.put_source(name, SourceSettings::default(), by)
            .map(|_| ())
    }

    // ---- muted lines (03.15–03.23, 06.13–06.25, 07.12–07.20) ----
    //
    // Each write holds the state lock across its SQLite write so two edits
    // never interleave (rules are edited one at a time from the UI).

    fn persist_source(
        &self,
        st: &mut State,
        name: &str,
        s: SourceSettings,
        by: Option<i64>,
    ) -> Result<(), SettingsError> {
        let key = format!("source:{name}");
        if s == SourceSettings::default() {
            self.save(&key, None, by)?;
            st.sources.remove(name);
        } else {
            self.save(&key, Some(serde_json::to_string(&s)?), by)?;
            st.sources.insert(name.to_string(), s);
        }
        Ok(())
    }

    fn persist_global(
        &self,
        st: &mut State,
        rules: Vec<MuteRule>,
        by: Option<i64>,
    ) -> Result<(), SettingsError> {
        let v = (!rules.is_empty())
            .then(|| serde_json::to_string(&rules))
            .transpose()?;
        self.save("muted_global", v, by)?;
        st.muted_global = rules;
        Ok(())
    }

    /// Add a rule to `source` (scope source) or to every source (scope
    /// global). A rule carrying an id is a restore (Undo after a delete): it
    /// keeps its id and history, and `off_on` gets its "Don't apply here"
    /// back. `remove_source_rules` (global only) deletes the same rule from
    /// the sources that already had it (07.14).
    pub fn add_mute_rule(
        &self,
        add: AddMuteRule,
        by: Option<i64>,
    ) -> Result<AddedMuteRule, SettingsError> {
        let mut rule = clean_rule(add.rule)?;
        let mut st = self.state.write().unwrap();
        let exists = st.muted_global.iter().any(|r| r.id == rule.id)
            || st.sources.values().any(|s| s.muted.iter().any(|r| r.id == rule.id));
        if exists {
            return invalid("muted: a rule with this id already exists");
        }
        let mut removed = Vec::new();
        match rule.scope {
            MuteScope::Global => {
                if st.muted_global.iter().any(|r| r.same_as(&rule)) {
                    return invalid("muted: there is already a global rule like this");
                }
                if st.muted_global.len() >= MAX_GLOBAL_MUTE_RULES {
                    return invalid(format!(
                        "muted: at most {MAX_GLOBAL_MUTE_RULES} global rules"
                    ));
                }
                rule.scope = MuteScope::Global;
                let mut global = st.muted_global.clone();
                global.push(rule.clone());
                self.persist_global(&mut st, global, by)?;
                let names: Vec<String> = st.sources.keys().cloned().collect();
                for name in names {
                    let mut s = st.sources[&name].clone();
                    let mut changed = false;
                    if add.remove_source_rules {
                        let before = s.muted.len();
                        s.muted.retain(|r| {
                            if r.same_as(&rule) {
                                removed.push(RemovedMuteRule {
                                    source: name.clone(),
                                    rule: r.clone(),
                                });
                                false
                            } else {
                                true
                            }
                        });
                        changed |= s.muted.len() != before;
                    }
                    if let Some(o) = add.off_on.iter().find(|o| o.source == name) {
                        s.muted_global_off.push(GlobalOff {
                            id: rule.id.clone(),
                            by: o.by.clone(),
                            at: o.at,
                        });
                        changed = true;
                    }
                    if changed {
                        self.persist_source(&mut st, &name, s, by)?;
                    }
                }
                for o in add.off_on.iter().filter(|o| !st.sources.contains_key(&o.source)) {
                    let s = SourceSettings {
                        muted_global_off: vec![GlobalOff {
                            id: rule.id.clone(),
                            by: o.by.clone(),
                            at: o.at,
                        }],
                        ..Default::default()
                    };
                    self.persist_source(&mut st, &o.source, s, by)?;
                }
            }
            MuteScope::Source => {
                let Some(name) = add.source.as_deref().map(str::trim).filter(|n| !n.is_empty())
                else {
                    return invalid("muted: which source?");
                };
                let mut s = st.sources.get(name).cloned().unwrap_or_default();
                if s.muted.iter().any(|r| r.same_as(&rule)) {
                    return invalid("muted: this source already has a rule like this");
                }
                if s.muted.len() >= MAX_MUTE_RULES {
                    return invalid(format!("muted: at most {MAX_MUTE_RULES} rules"));
                }
                s.muted.push(rule.clone());
                self.persist_source(&mut st, name, s, by)?;
            }
        }
        drop(st);
        self.changed.notify_one();
        Ok(AddedMuteRule { rule, removed })
    }

    /// Switch a rule on or off, or change what it matches (06.18, 07.16).
    pub fn update_mute_rule(
        &self,
        id: &str,
        u: UpdateMuteRule,
        by: Option<i64>,
    ) -> Result<MuteRule, SettingsError> {
        let mut st = self.state.write().unwrap();
        let apply = |r: &MuteRule| -> Result<MuteRule, SettingsError> {
            let mut r = r.clone();
            if let Some(e) = u.enabled {
                r.enabled = e;
            }
            if let Some(sh) = u.shape {
                r.shape = sh;
            }
            if let Some(f) = &u.field {
                r.field = f.clone();
            }
            if let Some(v) = &u.value {
                r.value = v.clone();
            }
            if let Some(m) = &u.method {
                r.method = m.clone();
            }
            clean_rule(r)
        };
        if let Some(i) = st.muted_global.iter().position(|r| r.id == id) {
            let r = apply(&st.muted_global[i])?;
            if st.muted_global.iter().any(|x| x.id != id && x.same_as(&r)) {
                return invalid("muted: there is already a global rule like this");
            }
            let mut global = st.muted_global.clone();
            global[i] = r.clone();
            self.persist_global(&mut st, global, by)?;
            drop(st);
            self.changed.notify_one();
            return Ok(r);
        }
        let found = st.sources.iter().find_map(|(name, s)| {
            s.muted
                .iter()
                .position(|r| r.id == id)
                .map(|i| (name.clone(), i))
        });
        let Some((name, i)) = found else {
            return Err(SettingsError::NotFound("no muted-lines rule with this id".into()));
        };
        let mut s = st.sources[&name].clone();
        let r = apply(&s.muted[i])?;
        if s.muted.iter().any(|x| x.id != id && x.same_as(&r)) {
            return invalid("muted: this source already has a rule like this");
        }
        s.muted[i] = r.clone();
        self.persist_source(&mut st, &name, s, by)?;
        drop(st);
        self.changed.notify_one();
        Ok(r)
    }

    /// Delete a rule. A global rule goes from every source, with its
    /// "Don't apply here" switches (returned, so Undo can put them back).
    pub fn delete_mute_rule(
        &self,
        id: &str,
        by: Option<i64>,
    ) -> Result<DeletedMuteRule, SettingsError> {
        let mut st = self.state.write().unwrap();
        if let Some(i) = st.muted_global.iter().position(|r| r.id == id) {
            let mut global = st.muted_global.clone();
            let rule = global.remove(i);
            self.persist_global(&mut st, global, by)?;
            let mut off_on = Vec::new();
            let names: Vec<String> = st.sources.keys().cloned().collect();
            for name in names {
                let mut s = st.sources[&name].clone();
                if let Some(o) = s.muted_global_off.iter().find(|o| o.id == id).cloned() {
                    s.muted_global_off.retain(|o| o.id != id);
                    off_on.push(SourceOff {
                        source: name.clone(),
                        by: o.by,
                        at: o.at,
                    });
                    self.persist_source(&mut st, &name, s, by)?;
                }
            }
            drop(st);
            self.changed.notify_one();
            return Ok(DeletedMuteRule {
                rule,
                source: None,
                off_on,
            });
        }
        let found = st.sources.iter().find_map(|(name, s)| {
            s.muted
                .iter()
                .position(|r| r.id == id)
                .map(|i| (name.clone(), i))
        });
        let Some((name, i)) = found else {
            return Err(SettingsError::NotFound("no muted-lines rule with this id".into()));
        };
        let mut s = st.sources[&name].clone();
        let rule = s.muted.remove(i);
        self.persist_source(&mut st, &name, s, by)?;
        drop(st);
        self.changed.notify_one();
        Ok(DeletedMuteRule {
            rule,
            source: Some(name),
            off_on: Vec::new(),
        })
    }

    /// Switch a global rule off for one source ("Don't apply here", 06.19)
    /// or back on.
    pub fn set_global_apply(
        &self,
        source: &str,
        id: &str,
        apply: bool,
        who: Option<String>,
        by: Option<i64>,
    ) -> Result<SourceSettings, SettingsError> {
        let mut st = self.state.write().unwrap();
        if !st.muted_global.iter().any(|r| r.id == id) {
            return Err(SettingsError::NotFound("no global rule with this id".into()));
        }
        let mut s = st.sources.get(source).cloned().unwrap_or_default();
        s.muted_global_off.retain(|o| o.id != id);
        if !apply {
            s.muted_global_off.push(GlobalOff {
                id: id.to_string(),
                by: who,
                at: Some(chrono::Utc::now().timestamp_millis()),
            });
        }
        self.persist_source(&mut st, source, s.clone(), by)?;
        drop(st);
        self.changed.notify_one();
        Ok(s)
    }

    /// Settings → Muted lines → Include muted lines in search (the instance
    /// default, kept in `general.search_include_muted`; `null` = the flag).
    pub fn put_muted_search(
        &self,
        include: Option<bool>,
        by: Option<i64>,
    ) -> Result<MutedSearch, SettingsError> {
        {
            let mut st = self.state.write().unwrap();
            let mut g = st.general.clone();
            g.search_include_muted = include;
            self.save("general", Some(serde_json::to_string(&g)?), by)?;
            st.general = g;
        }
        Ok(self.muted_search())
    }

    /// Whether `key` (a field key, compared lowercase with `-` as `_`) is
    /// masked for `source` on export.
    pub fn masker(&self, source: &str) -> Masker {
        let s = self.source(source);
        Masker {
            extra: s
                .mask_fields
                .iter()
                .map(|f| f.to_ascii_lowercase().replace('-', "_"))
                .collect(),
            unmasked: s.unmasked,
        }
    }
}

/// The per-source masking rule for exports.
#[derive(Debug, Clone, Default)]
pub struct Masker {
    /// Extra keys, full dotted paths or last segments, normalised.
    pub extra: Vec<String>,
    pub unmasked: Vec<PiiKind>,
}

/// Give rules saved before rule shapes a shape and an id. Returns the
/// sources whose rules changed (to save once).
fn upgrade_mute_rules(state: &mut State) -> Vec<String> {
    let mut changed = Vec::new();
    for (name, s) in state.sources.iter_mut() {
        let mut any = false;
        for r in s.muted.iter_mut().filter(|r| r.id.is_empty()) {
            r.upgrade();
            r.id = new_rule_id();
            r.scope = MuteScope::Source;
            any = true;
        }
        if any {
            changed.push(name.clone());
        }
    }
    for r in state.muted_global.iter_mut() {
        r.scope = MuteScope::Global;
        if r.id.is_empty() {
            r.id = new_rule_id();
        }
    }
    changed
}

/// Source names sent to the custom-group writes: at least `min`, at most
/// 1000, each a valid source name.
fn check_sources(sources: &[String], min: usize) -> Result<(), SettingsError> {
    if sources.len() < min || sources.len() > 1000 {
        return invalid(format!("sources: {min}–1000 source names"));
    }
    if let Some(bad) = sources.iter().find(|s| !crate::tokens_api::valid_source(s)) {
        return invalid(format!("source: 1–128 characters ({bad:?})"));
    }
    Ok(())
}

/// At most this many custom id fields in one order.
pub const MAX_CUSTOM_ID_KEYS: usize = 8;

fn check_order(o: &[IdKey]) -> Result<(), SettingsError> {
    if o.is_empty() {
        return invalid("order: keep at least one id key");
    }
    let mut seen: Vec<&IdKey> = Vec::new();
    for k in o {
        if seen.contains(&k) {
            return invalid("order: each key once");
        }
        if let IdKey::Custom(name) = k {
            if !valid_custom_key(name) {
                return invalid(
                    "order: a custom id field is 1–64 characters of letters, digits and . _ - : @, with no empty path segment",
                );
            }
        }
        seen.push(k);
    }
    if o.iter().filter(|k| k.is_custom()).count() > MAX_CUSTOM_ID_KEYS {
        return invalid("order: at most 8 custom id fields");
    }
    Ok(())
}

/// A field name or dotted path a custom id key can match: `x-request-id`,
/// `ctx.trace`, `meta.correlation`. No spaces, no empty segments.
pub fn valid_custom_key(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '@'))
        && name.split('.').all(|seg| !seg.is_empty())
}

/// `local`, `UTC`, or something shaped like an IANA zone. The browser checks
/// the zone really exists (Intl); the server only refuses junk.
pub fn valid_timezone(tz: &str) -> bool {
    if tz == "local" || tz == "UTC" {
        return true;
    }
    let parts: Vec<&str> = tz.split('/').collect();
    tz.len() <= 64
        && (2..=3).contains(&parts.len())
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("quiet-settings-{}", rand::random::<u64>()))
            .join("quiet.db")
    }

    #[test]
    fn grouping_saves_and_env_wins_and_locks() {
        let path = tmp();
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let g = s.grouping();
        assert_eq!(
            (g.mode, g.label.as_str(), g.origin, g.locked),
            (GroupMode::Auto, "quiet.group", Origin::Default, false)
        );
        let bad = |label: &str| UpdateGrouping {
            mode: GroupMode::Label,
            label: label.into(),
        };
        assert!(s.put_grouping(Some(bad("a b")), None).is_err());
        assert!(s.put_grouping(Some(bad(" ")), None).is_err());
        let g = s
            .put_grouping(
                Some(UpdateGrouping {
                    mode: GroupMode::Off,
                    label: String::new(),
                }),
                Some(1),
            )
            .unwrap();
        assert_eq!(
            (g.mode, g.label.as_str(), g.origin),
            (GroupMode::Off, "quiet.group", Origin::Setting)
        );
        drop(s);
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        assert_eq!(s.grouping().mode, GroupMode::Off, "survives a restart");
        assert_eq!(s.put_grouping(None, None).unwrap().mode, GroupMode::Auto);
        drop(s);

        // Env set: it wins over the saved value and the control is locked.
        let env = Defaults {
            group_by: Some(GroupMode::Label),
            group_label: Some("team".into()),
            ..Default::default()
        };
        let s = Settings::open(Some(&path), env, false).unwrap();
        let g = s.grouping();
        assert_eq!(
            (g.mode, g.label.as_str(), g.origin, g.locked),
            (GroupMode::Label, "team", Origin::Flag, true)
        );
        assert!(s.put_grouping(None, None).is_err());
    }

    #[test]
    fn docker_migration_splits_settings_and_groups_and_survives_restart() {
        let path = tmp();
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        assert_eq!(s.docker_identity(), DockerIdentity::default());
        // The old merged `postgres`: renamed, muted, in a custom group.
        s.put_source(
            "postgres",
            SourceSettings {
                display_name: Some("Postgres".into()),
                muted: vec![MuteRule::legacy(None, "checkpoint")],
                ..Default::default()
            },
            Some(1),
        )
        .unwrap();
        let g = s
            .create_group("Data", &["postgres".into()], Some(1))
            .unwrap();
        // One of the new sources already has its own settings: kept.
        let own = SourceSettings {
            hidden: true,
            ..Default::default()
        };
        s.put_source("staging.postgres", own.clone(), Some(1))
            .unwrap();
        let split: BTreeMap<String, Vec<String>> = [(
            "postgres".to_string(),
            vec!["prod.postgres".to_string(), "staging.postgres".to_string()],
        )]
        .into();
        let aliases: BTreeMap<String, String> =
            [("affine.db".to_string(), "db".to_string())].into();
        let ident = s.finish_docker_migration(aliases, &split).unwrap();
        assert!(ident.migrated);
        let prod = s.source("prod.postgres");
        assert_eq!(prod.display_name, None, "the merged name isn't copied");
        assert_eq!(prod.muted.len(), 1);
        assert_eq!(s.source("staging.postgres"), own);
        assert_eq!(
            s.source("postgres").display_name.as_deref(),
            Some("Postgres"),
            "the old source keeps its own"
        );
        let c = s.custom_groups();
        for k in ["postgres", "prod.postgres", "staging.postgres"] {
            assert_eq!(c.assigned.get(k), Some(&g.id), "{k}");
        }
        drop(s);
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let ident = s.docker_identity();
        assert!(ident.migrated);
        assert_eq!(
            ident.aliases.get("affine.db").map(String::as_str),
            Some("db")
        );
    }

    #[test]
    fn custom_groups_create_rename_reorder_assign_delete_and_survive_restart() {
        let path = tmp();
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        assert_eq!(s.custom_groups(), CustomGroups::default());
        let names = |s: &Settings| {
            s.custom_groups()
                .groups
                .iter()
                .map(|g| (g.name.clone(), g.order))
                .collect::<Vec<_>>()
        };
        let staging = s
            .create_group(
                "  Legivent staging ",
                &["staging-api".into(), "staging-bot".into()],
                Some(1),
            )
            .unwrap();
        assert_eq!(
            (staging.name.as_str(), staging.order),
            ("Legivent staging", 0)
        );
        assert!(staging.id.starts_with("g_"));
        let jobs = s.create_group("Jobs", &[], Some(1)).unwrap();
        assert_eq!(jobs.order, 1);
        // Names: trimmed, 1–48 characters, unique ignoring case.
        assert!(s.create_group("legivent STAGING", &[], None).is_err());
        assert!(s.create_group(" ", &[], None).is_err());
        assert!(s.create_group(&"x".repeat(49), &[], None).is_err());
        assert!(s.create_group("Bad", &["".into()], None).is_err());
        assert_eq!(names(&s).len(), 2, "a refused create changes nothing");

        // Rename keeps the id (and so the assignments); reorder moves it.
        let all = s
            .update_group(&jobs.id, Some("Workers"), Some(0), Some(1))
            .unwrap()
            .unwrap();
        assert_eq!(all.groups[0].id, jobs.id);
        assert_eq!(
            names(&s),
            [
                ("Workers".to_string(), 0),
                ("Legivent staging".to_string(), 1)
            ]
        );
        assert!(s
            .update_group(&jobs.id, Some("legivent staging"), None, None)
            .is_err());
        // Renaming to its own name in another case is fine.
        assert!(s
            .update_group(&jobs.id, Some("WORKERS"), None, None)
            .is_ok());
        assert!(s
            .update_group("g_nope", Some("x"), None, None)
            .unwrap()
            .is_none());
        // Past the end clamps to last.
        s.update_group(&jobs.id, None, Some(99), None).unwrap();
        assert_eq!(s.custom_groups().groups[1].id, jobs.id);

        // Move a source; moving it again replaces the assignment; Automatic resets.
        s.assign_sources(&["worker".into()], Some(&jobs.id), None)
            .unwrap();
        s.assign_sources(&["staging-bot".into()], Some(&jobs.id), None)
            .unwrap();
        let c = s.custom_groups();
        assert_eq!(c.group_for("staging-bot").unwrap().id, jobs.id);
        assert_eq!(c.members(&staging.id), 1);
        s.assign_sources(&["staging-bot".into()], None, None)
            .unwrap();
        assert!(s.custom_groups().group_for("staging-bot").is_none());
        assert!(s
            .assign_sources(&["x".into()], Some("g_nope"), None)
            .is_err());
        assert!(s.assign_sources(&[], None, None).is_err());

        assert_eq!(s.custom_groups().group_for("worker").unwrap().id, jobs.id);

        drop(s);
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let c = s.custom_groups();
        assert_eq!(names(&s).len(), 2, "survives a restart");
        assert_eq!(c.group_for("staging-api").unwrap().id, staging.id);

        // Delete: the group goes, its sources go back to automatic; the rest
        // keep their order.
        assert!(s.delete_group(&staging.id, None).unwrap().is_some());
        assert!(s.delete_group(&staging.id, None).unwrap().is_none());
        let c = s.custom_groups();
        assert!(c.group_for("staging-api").is_none());
        assert_eq!(c.assigned.len(), 1, "only the other group's source is left");
        assert_eq!(c.group_for("worker").unwrap().id, jobs.id);
        assert_eq!(names(&s), [("WORKERS".to_string(), 0)]);
        assert!(s.delete_group(&jobs.id, None).unwrap().is_some());
        drop(s);
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        assert_eq!(s.custom_groups(), CustomGroups::default());
    }

    #[test]
    fn env_locks_the_grouping_mode_but_not_custom_groups_and_off_keeps_them() {
        let path = tmp();
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let g = s.create_group("Edge", &["traefik".into()], None).unwrap();
        // Off: the groups and assignments are kept.
        s.put_grouping(
            Some(UpdateGrouping {
                mode: GroupMode::Off,
                label: String::new(),
            }),
            None,
        )
        .unwrap();
        assert_eq!(s.custom_groups().group_for("traefik").unwrap().id, g.id);
        drop(s);
        let env = Defaults {
            group_by: Some(GroupMode::Auto),
            ..Default::default()
        };
        let s = Settings::open(Some(&path), env, false).unwrap();
        assert!(s.grouping().locked);
        assert!(s.put_grouping(None, None).is_err(), "mode locked");
        // Custom groups stay editable under the lock.
        s.update_group(&g.id, Some("Edge proxies"), None, None)
            .unwrap()
            .unwrap();
        s.create_group("More", &[], None).unwrap();
        s.assign_sources(&["api".into()], Some(&g.id), None)
            .unwrap();
        assert_eq!(s.custom_groups().members(&g.id), 2);
        assert!(s.delete_group(&g.id, None).unwrap().is_some());
    }

    #[test]
    fn saved_storage_beats_flags_which_beat_defaults_and_survives_restart() {
        let path = tmp();
        let flags = Defaults {
            retention_ms: 3 * 24 * HOUR_MS,
            ..Default::default()
        };
        let s = Settings::open(Some(&path), flags.clone(), false).unwrap();
        let st = s.storage();
        assert_eq!(st.retention_ms, 3 * 24 * HOUR_MS);
        assert_eq!(st.retention_origin, Origin::Flag);
        assert_eq!(st.max_disk_origin, Origin::Default);

        s.put_storage(
            UpdateStorage {
                retention_ms: Some(Some(HOUR_MS)),
                max_disk: Some(Some(2_000_000_000)),
            },
            Some(1),
        )
        .unwrap();
        drop(s);
        let s = Settings::open(Some(&path), flags, false).unwrap();
        let st = s.storage();
        assert_eq!(
            (st.retention_ms, st.retention_origin),
            (HOUR_MS, Origin::Setting)
        );
        assert_eq!(
            (st.max_disk, st.max_disk_origin),
            (2_000_000_000, Origin::Setting)
        );
        assert_eq!(st.flag_retention_ms, 3 * 24 * HOUR_MS);

        // null clears: the flag applies again.
        s.put_storage(
            UpdateStorage {
                retention_ms: Some(None),
                max_disk: None,
            },
            None,
        )
        .unwrap();
        let st = s.storage();
        assert_eq!(
            (st.retention_ms, st.retention_origin),
            (3 * 24 * HOUR_MS, Origin::Flag)
        );
        assert_eq!(st.max_disk, 2_000_000_000);
    }

    #[test]
    fn storage_and_general_are_validated() {
        let s = Settings::memory();
        let bad = |r: i64| {
            s.put_storage(
                UpdateStorage {
                    retention_ms: Some(Some(r)),
                    max_disk: None,
                },
                None,
            )
            .is_err()
        };
        assert!(bad(30 * 60_000) && bad(8 * 24 * HOUR_MS) && bad(HOUR_MS + 1));
        assert!(s
            .put_storage(
                UpdateStorage {
                    retention_ms: None,
                    max_disk: Some(Some(1_000))
                },
                None
            )
            .is_err());
        let g = |name: &str, tz: &str| GeneralSettings {
            instance_name: name.into(),
            stream_direction: StreamDirection::Top,
            timezone: tz.into(),
            ..Default::default()
        };
        assert!(s.put_general(g("", "local"), None).is_err());
        assert!(s.put_general(g("legivent", "Mars/../x"), None).is_err());
        let saved = s
            .put_general(g("  legivent ", "Africa/Accra"), None)
            .unwrap();
        assert_eq!(saved.instance_name, "legivent");
        assert_eq!(s.general().stream_direction, StreamDirection::Top);
        assert!(valid_timezone("America/Argentina/Buenos_Aires") && valid_timezone("UTC"));

        // Public URL: trimmed, trailing slash dropped, empty clears; caps checked.
        let with = |u: &str, max: u32| GeneralSettings {
            public_url: Some(u.into()),
            max_line_bytes: max,
            ..Default::default()
        };
        assert!(s
            .put_general(with("quiet.legivent.com", 65_536), None)
            .is_err());
        assert!(s.put_general(with("https://a b", 65_536), None).is_err());
        assert!(s.put_general(with("https://q.x", 10), None).is_err());
        let saved = s
            .put_general(with(" https://quiet.legivent.com/ ", 131_072), None)
            .unwrap();
        assert_eq!(
            saved.public_url.as_deref(),
            Some("https://quiet.legivent.com")
        );
        assert_eq!(s.ingest_rules(), (131_072, true));
        let cleared = s.put_general(with("  ", 65_536), None).unwrap();
        assert_eq!(cleared.public_url, None);
        // An old saved value without the new keys still reads.
        let old: GeneralSettings = serde_json::from_str(
            r#"{"instance_name":"x","stream_direction":"top","timezone":"UTC"}"#,
        )
        .unwrap();
        assert_eq!(old.max_line_bytes, DEFAULT_MAX_LINE_BYTES);
        assert!(old.keep_non_json && !old.check_updates);
    }

    #[test]
    fn muted_rules_are_trimmed_deduped_and_bounded() {
        let s = Settings::memory();
        let rule = |f: Option<&str>, v: &str| MuteRule::legacy(f, v);
        let saved = s
            .put_source(
                "api",
                SourceSettings {
                    muted: vec![
                        rule(Some(" path "), " /api/v1/health "),
                        rule(Some("path"), "/api/v1/health"),
                        rule(Some(""), "kube-probe"),
                        rule(None, "  "),
                    ],
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let got: Vec<_> = saved
            .muted
            .iter()
            .map(|r| (r.shape, r.field.clone(), r.value.clone()))
            .collect();
        assert_eq!(
            got,
            vec![
                (MuteShape::Field, Some("path".into()), "/api/v1/health".into()),
                (MuteShape::Text, None, "kube-probe".into())
            ]
        );
        assert!(saved.muted.iter().all(|r| r.id.starts_with("mr_") && r.enabled));
        assert_eq!(s.source("api").muted.len(), 2);
        let bad = |r: MuteRule| {
            s.put_source(
                "api",
                SourceSettings {
                    muted: vec![r],
                    ..Default::default()
                },
                None,
            )
            .is_err()
        };
        assert!(bad(rule(Some("a b"), "x")));
        assert!(bad(rule(None, &"x".repeat(257))));
        let many = (0..=MAX_MUTE_RULES)
            .map(|i| rule(None, &format!("r{i}")))
            .collect();
        assert!(s
            .put_source(
                "api",
                SourceSettings {
                    muted: many,
                    ..Default::default()
                },
                None
            )
            .is_err());
        // Old saved settings (no `muted` key) still read.
        let old: SourceSettings = serde_json::from_str(r#"{"hidden":true}"#).unwrap();
        assert!(old.muted.is_empty() && old.hidden);
    }

    #[test]
    fn muted_in_search_saved_beats_flag_beats_off_and_sources_inherit() {
        let path = tmp();
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        assert_eq!(
            s.muted_search(),
            MutedSearch {
                include: false,
                origin: Origin::Default,
                flag: false
            }
        );
        assert!(!s.search_includes_muted("api"));
        drop(s);

        // The flag turns it on for every source that doesn't decide.
        let flags = Defaults {
            search_include_muted: Some(true),
            ..Default::default()
        };
        let s = Settings::open(Some(&path), flags.clone(), false).unwrap();
        assert_eq!(
            (s.muted_search().include, s.muted_search().origin),
            (true, Origin::Flag)
        );
        assert!(s.search_includes_muted("api"));
        s.put_source(
            "worker",
            SourceSettings {
                search_include_muted: Some(false),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(
            !s.search_includes_muted("worker"),
            "a source's own choice wins"
        );

        // Saved in Settings → General wins over the flag and survives a restart.
        let g = GeneralSettings {
            search_include_muted: Some(false),
            ..s.general()
        };
        s.put_general(g, Some(1)).unwrap();
        drop(s);
        let s = Settings::open(Some(&path), flags, false).unwrap();
        assert_eq!(
            s.muted_search(),
            MutedSearch {
                include: false,
                origin: Origin::Setting,
                flag: true
            }
        );
        assert!(!s.search_includes_muted("api"));
        s.put_source(
            "api",
            SourceSettings {
                search_include_muted: Some(true),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(s.search_includes_muted("api"));
        // Back to inherit: the source's row goes away when nothing else is set.
        s.reset_source("api", None).unwrap();
        assert!(!s.sources().contains_key("api"));
        assert!(!s.search_includes_muted("api"));
        // Saved values from before this setting still read.
        let old: GeneralSettings = serde_json::from_str(r#"{"instance_name":"x"}"#).unwrap();
        assert_eq!(old.search_include_muted, None);
    }

    #[test]
    fn source_overrides_are_capped_by_the_instance_and_reset_cleanly() {
        let s = Settings::memory();
        let mut src = SourceSettings {
            retention_ms: Some(48 * HOUR_MS),
            ..Default::default()
        };
        assert!(matches!(
            s.put_source("api", src.clone(), None),
            Err(SettingsError::Invalid(_))
        ));
        src.retention_ms = Some(6 * HOUR_MS);
        src.display_name = Some(" API ".into());
        src.mask_fields = vec![
            "customer.address".into(),
            " ".into(),
            "customer.address".into(),
        ];
        src.id_keys = Some(vec![IdKey::JobId, IdKey::JobId]);
        assert!(s.put_source("api", src.clone(), None).is_err());
        src.id_keys = Some(vec![IdKey::JobId, IdKey::RequestId]);
        let saved = s.put_source("api", src, None).unwrap();
        assert_eq!(saved.display_name.as_deref(), Some("API"));
        assert_eq!(saved.mask_fields, vec!["customer.address"]);
        assert_eq!(s.source_windows(), vec![("api".to_string(), 6 * HOUR_MS)]);

        // Same name as the source → no display name.
        let saved = s
            .put_source(
                "api",
                SourceSettings {
                    display_name: Some("api".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(saved.display_name, None);
        assert!(s.sources().is_empty(), "all-default settings are not kept");

        s.put_source(
            "worker",
            SourceSettings {
                paused: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(s.paused("worker") && !s.paused("api"));
        s.reset_source("worker", None).unwrap();
        assert!(!s.paused("worker"));
    }

    #[test]
    fn flow_id_order_needs_a_key_and_no_repeats() {
        let s = Settings::memory();
        let mut f = FlowIdSettings {
            order: vec![],
            match_by: MatchBy::Key,
        };
        assert!(s.put_flow_ids(f.clone(), None).is_err());
        f.order = vec![IdKey::TraceId, IdKey::RequestId];
        assert_eq!(s.put_flow_ids(f, None).unwrap().match_by, MatchBy::Key);
        assert_eq!(s.flow_ids().order[0], IdKey::TraceId);
    }

    #[test]
    fn legacy_rules_get_ids_and_shapes_once_and_keep_matching() {
        let path = tmp();
        {
            let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
            // As saved by the previous version: `{ field, value }` only.
            s.save(
                "source:api",
                Some(
                    r#"{"muted":[{"field":"path","value":"/api/v1/health*"},{"field":null,"value":"kube-probe"},{"field":"msg","value":"heartbeat ok"}],"search_include_muted":true}"#
                        .into(),
                ),
                None,
            )
            .unwrap();
        }
        let s = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let api = s.source("api");
        let shapes: Vec<_> = api.muted.iter().map(|r| r.shape).collect();
        assert_eq!(
            shapes,
            vec![MuteShape::Field, MuteShape::Text, MuteShape::Message]
        );
        assert!(api.muted.iter().all(|r| r.id.starts_with("mr_") && r.enabled));
        assert_eq!(api.search_include_muted, Some(true));
        let ids: Vec<_> = api.muted.iter().map(|r| r.id.clone()).collect();
        // Saved: the same ids after another restart.
        let again = Settings::open(Some(&path), Defaults::default(), false).unwrap();
        let ids2: Vec<_> = again.source("api").muted.iter().map(|r| r.id.clone()).collect();
        assert_eq!(ids, ids2);
        let _ = std::fs::remove_file(&path);
    }

    fn draft(shape: MuteShape, value: &str, scope: MuteScope) -> MuteRule {
        MuteRule {
            shape,
            value: value.into(),
            scope,
            method: (shape == MuteShape::MethodRoute).then(|| "get".into()),
            ..Default::default()
        }
    }

    #[test]
    fn global_rules_union_with_source_rules_and_can_be_switched_off_per_source() {
        let s = Settings::memory();
        let add = |r: MuteRule, source: Option<&str>| {
            s.add_mute_rule(
                AddMuteRule {
                    rule: r,
                    source: source.map(String::from),
                    ..Default::default()
                },
                None,
            )
        };
        let own = add(draft(MuteShape::MethodRoute, "/api/v1/ping?x=1", MuteScope::Source), Some("api"))
            .unwrap()
            .rule;
        assert_eq!(own.value, "/api/v1/ping", "query dropped");
        assert_eq!(own.method.as_deref(), Some("GET"));
        assert!(add(draft(MuteShape::MethodRoute, "/api/v1/ping", MuteScope::Source), Some("api")).is_err(), "duplicate");
        assert!(add(draft(MuteShape::Route, "/x", MuteScope::Source), None).is_err(), "no source");
        let g = add(draft(MuteShape::Route, "/metrics", MuteScope::Global), None).unwrap().rule;
        assert_eq!(g.scope, MuteScope::Global);
        assert_eq!(s.muted_global().len(), 1);
        // api: its own rule + the global one; worker (no settings): global only.
        let ids = |src: &str| s.mute_rules(src).into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids("api"), vec![g.id.clone(), own.id.clone()]);
        assert_eq!(ids("worker"), vec![g.id.clone()]);
        // Don't apply here.
        s.set_global_apply("worker", &g.id, false, Some("esi".into()), None).unwrap();
        assert!(ids("worker").is_empty());
        let off = &s.source("worker").muted_global_off[0];
        assert_eq!((off.id.as_str(), off.by.as_deref()), (g.id.as_str(), Some("esi")));
        // Paused rules hide nothing.
        s.update_mute_rule(&own.id, UpdateMuteRule { enabled: Some(false), ..Default::default() }, None).unwrap();
        assert_eq!(ids("api"), vec![g.id.clone()]);
        // Edit keeps the id.
        let edited = s
            .update_mute_rule(&own.id, UpdateMuteRule { value: Some("/api/v1/pong".into()), ..Default::default() }, None)
            .unwrap();
        assert_eq!((edited.id.as_str(), edited.value.as_str(), edited.enabled), (own.id.as_str(), "/api/v1/pong", false));
        assert!(matches!(
            s.update_mute_rule("mr_nope", UpdateMuteRule::default(), None),
            Err(SettingsError::NotFound(_))
        ));
        // Deleting a global rule takes its switches with it; restoring brings them back.
        let gone = s.delete_mute_rule(&g.id, None).unwrap();
        assert_eq!(gone.source, None);
        assert_eq!(gone.off_on.len(), 1);
        assert!(s.muted_global().is_empty() && s.source("worker").muted_global_off.is_empty());
        let back = s
            .add_mute_rule(
                AddMuteRule {
                    rule: gone.rule.clone(),
                    off_on: gone.off_on.clone(),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(back.rule, gone.rule);
        assert_eq!(s.source("worker").muted_global_off[0].by.as_deref(), Some("esi"));
        assert!(ids("worker").is_empty());
        // Source rule delete → restore.
        let d = s.delete_mute_rule(&own.id, None).unwrap();
        assert_eq!(d.source.as_deref(), Some("api"));
        s.add_mute_rule(
            AddMuteRule {
                rule: d.rule.clone(),
                source: d.source.clone(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(s.source("api").muted[0], d.rule);
        // A switch for an unknown rule is dropped on save.
        let mut w = s.source("worker");
        w.muted_global_off.push(GlobalOff { id: "mr_gone".into(), ..Default::default() });
        assert_eq!(s.put_source("worker", w, None).unwrap().muted_global_off.len(), 1);
    }

    #[test]
    fn a_new_global_rule_can_replace_the_same_source_rules() {
        let s = Settings::memory();
        for src in ["api", "worker"] {
            s.add_mute_rule(
                AddMuteRule {
                    rule: draft(MuteShape::Route, "/metrics", MuteScope::Source),
                    source: Some(src.into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        }
        let added = s
            .add_mute_rule(
                AddMuteRule {
                    rule: draft(MuteShape::Route, "/METRICS", MuteScope::Global),
                    remove_source_rules: true,
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(added.removed.len(), 2);
        assert!(s.source("api").muted.is_empty() && s.source("worker").muted.is_empty());
        assert!(s
            .add_mute_rule(
                AddMuteRule {
                    rule: draft(MuteShape::Route, "/metrics", MuteScope::Global),
                    ..Default::default()
                },
                None,
            )
            .is_err());
        // The instance include-in-search default moved to Muted lines.
        assert!(s.put_muted_search(Some(true), None).unwrap().include);
        assert_eq!(s.general().search_include_muted, Some(true));
        assert_eq!(s.put_muted_search(None, None).unwrap().origin, Origin::Default);
        assert_eq!(route_path("https://x.io/a/b?c=1#d"), "/a/b");
        assert_eq!(route_path("/a?b"), "/a");
        assert_eq!(route_path("https://x.io"), "/");
    }
}
