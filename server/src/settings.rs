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
    /// Settings → General says. The stream always hides them.
    #[ts(type = "boolean | null")]
    pub search_include_muted: Option<bool>,
}

/// One muted-lines rule. With `field`, the field's value (dot path, compared
/// as text) equals `value`, where `*` matches any run of characters
/// (`/api/v1/health*`). Without, `value` appears anywhere in the raw line
/// (case-insensitive).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct MuteRule {
    pub field: Option<String>,
    pub value: String,
}

/// At most this many muted-lines rules per source.
pub const MAX_MUTE_RULES: usize = 32;

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

#[derive(Debug, Clone, Default)]
struct State {
    general: GeneralSettings,
    storage: StorageOverride,
    grouping: Option<UpdateGrouping>,
    custom_groups: CustomGroups,
    flow_ids: FlowIdSettings,
    sources: BTreeMap<String, SourceSettings>,
}

/// A settings write failed: bad input (400) or storage (503).
#[derive(Debug)]
pub enum SettingsError {
    Invalid(String),
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
        let me = Settings {
            db: Mutex::new(db),
            defaults: RwLock::new(defaults),
            state: RwLock::new(state),
            publish,
            changed: Notify::new(),
        };
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

    /// `source`'s muted-lines rules.
    pub fn mute_rules(&self, source: &str) -> Vec<MuteRule> {
        self.state
            .read()
            .unwrap()
            .sources
            .get(source)
            .map(|s| s.muted.clone())
            .unwrap_or_default()
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
        }
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
        for r in &s.muted {
            let field = r
                .field
                .as_deref()
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .map(String::from);
            let value = r.value.trim().to_string();
            if value.is_empty() {
                continue;
            }
            if value.chars().count() > 256
                || value.chars().any(char::is_control)
                || field.as_ref().is_some_and(|f| {
                    f.chars().count() > 128
                        || f.chars().any(|c| c.is_control() || c.is_whitespace())
                })
            {
                return invalid("muted: field up to 128 characters (no spaces), value up to 256");
            }
            let rule = MuteRule { field, value };
            if !muted.contains(&rule) {
                muted.push(rule);
            }
        }
        if muted.len() > MAX_MUTE_RULES {
            return invalid(format!("muted: at most {MAX_MUTE_RULES} rules"));
        }
        s.muted = muted;
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
        let rule = |f: Option<&str>, v: &str| MuteRule {
            field: f.map(String::from),
            value: v.into(),
        };
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
        assert_eq!(
            saved.muted,
            vec![
                rule(Some("path"), "/api/v1/health"),
                rule(None, "kube-probe")
            ]
        );
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
}
