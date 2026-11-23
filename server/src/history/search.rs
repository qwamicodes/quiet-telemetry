//! Search across locations (v0.1.1 Phase 5c, `docs/v0.1.1-storage-design.md`).
//!
//! Search stays local-first. When a range reaches past the local window, the
//! search response carries a [`HistoryCoverage`]: per destination, which of
//! those hours it holds, the gaps (with reasons) and where retained history
//! starts. A **history job** then plans the archived hours (newest first, at
//! most [`MAX_HOURS`]), downloads each segment into the local
//! [`Cache`] (sha256 checked, zstd decoded, LRU by bytes), runs the store's
//! own search SQL on it ([`crate::store::search_segment`]) and keeps the
//! matches with a location tag. Jobs live in memory, per user; a restart
//! drops them.

use super::catalog::DestinationRow;
use super::{retention_before, History, HourRecord, HOUR};
use crate::hub::Line;
use crate::normalize::LogLine;
use crate::search::{Bucket, SearchQuery};
use object_store::path::Path as ObjPath;
use object_store::ObjectStoreExt;
use serde::Serialize;
use sha2::Digest;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// Hours one job searches at most (a week).
pub const MAX_HOURS: usize = 168;
/// Ranges reaching this many hours or fewer into history are searched with
/// the search itself; longer ones wait for "Search retained history".
pub const AUTO_HOURS: u64 = 6;
/// Matches one job keeps (results and export).
pub const MAX_LINES: usize = 5_000;
/// Finished jobs are forgotten after this long.
const KEEP_MS: i64 = 15 * 60_000;
/// Jobs one user keeps at once; starting another cancels the oldest.
const PER_USER: usize = 4;
/// Default cache size (`--history-cache`).
pub const DEFAULT_CACHE: u64 = 2_000_000_000;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ── Cache ───────────────────────────────────────────────────────────────────

/// Check an archived object against its catalog sha256, then decompress it.
fn decode_checked(sha: &str, compressed: &[u8]) -> anyhow::Result<Vec<u8>> {
    let got = hex(&sha2::Sha256::digest(compressed));
    if got != sha {
        anyhow::bail!("checksum mismatch: expected {sha}, got {got}");
    }
    Ok(zstd::decode_all(compressed)?)
}

struct Entry {
    path: PathBuf,
    bytes: u64,
    used: u64,
}

/// Downloaded segments in `<data dir>/history-cache`, decompressed, keyed by
/// the archived object's sha256. LRU by bytes; whole segments are evicted.
/// Separate from the disk cap.
pub struct Cache {
    dir: PathBuf,
    max: u64,
    state: Mutex<CacheState>,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, Entry>,
    total: u64,
    clock: u64,
}

impl Cache {
    /// Open the cache directory, keeping what an earlier run downloaded
    /// (oldest-modified first in LRU order).
    pub fn open(dir: &Path, max: u64) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let mut found: Vec<(std::time::SystemTime, String, PathBuf, u64)> = Vec::new();
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let p = e.path();
            match p.extension().and_then(|x| x.to_str()) {
                Some("seg") => {}
                Some("tmp") => {
                    let _ = std::fs::remove_file(&p);
                    continue;
                }
                _ => continue,
            }
            let Some(sha) = p.file_stem().and_then(|x| x.to_str()).map(String::from) else {
                continue;
            };
            let m = e.metadata()?;
            found.push((
                m.modified().unwrap_or(std::time::UNIX_EPOCH),
                sha,
                p,
                m.len(),
            ));
        }
        found.sort_by_key(|f| f.0);
        let mut st = CacheState::default();
        for (_, sha, path, bytes) in found {
            st.clock += 1;
            st.total += bytes;
            st.entries.insert(
                sha,
                Entry {
                    path,
                    bytes,
                    used: st.clock,
                },
            );
        }
        let c = Cache {
            dir: dir.to_path_buf(),
            max,
            state: Mutex::new(st),
        };
        c.evict(None);
        Ok(c)
    }

    /// A cached segment, marked as just used.
    pub fn get(&self, sha: &str) -> Option<PathBuf> {
        let mut st = self.state.lock().unwrap();
        st.clock += 1;
        let clock = st.clock;
        let e = st.entries.get_mut(sha)?;
        if !e.path.exists() {
            let bytes = e.bytes;
            st.entries.remove(sha);
            st.total -= bytes;
            return None;
        }
        e.used = clock;
        Some(e.path.clone())
    }

    /// Store a downloaded object: check its sha256 against the catalog,
    /// decompress, write atomically, then evict down to the size limit
    /// (never the one just added). Blocking.
    #[cfg(test)]
    pub fn put(&self, sha: &str, compressed: &[u8]) -> anyhow::Result<PathBuf> {
        let raw = decode_checked(sha, compressed)?;
        self.insert(sha, &raw)
    }

    fn insert(&self, sha: &str, raw: &[u8]) -> anyhow::Result<PathBuf> {
        let path = self.dir.join(format!("{sha}.seg"));
        let tmp = self
            .dir
            .join(format!("{sha}.{:08x}.tmp", rand::random::<u32>()));
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, &path)?;
        {
            let mut st = self.state.lock().unwrap();
            st.clock += 1;
            let clock = st.clock;
            let bytes = raw.len() as u64;
            if let Some(old) = st.entries.insert(
                sha.to_string(),
                Entry {
                    path: path.clone(),
                    bytes,
                    used: clock,
                },
            ) {
                st.total -= old.bytes;
            }
            st.total += bytes;
        }
        self.evict(Some(sha));
        Ok(path)
    }

    fn evict(&self, keep: Option<&str>) {
        let mut st = self.state.lock().unwrap();
        while st.total > self.max {
            let victim = st
                .entries
                .iter()
                .filter(|(k, _)| Some(k.as_str()) != keep)
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            let Some(k) = victim else { break };
            if let Some(e) = st.entries.remove(&k) {
                st.total -= e.bytes;
                let _ = std::fs::remove_file(&e.path);
            }
        }
    }

    /// Download (or reuse) one archived hour.
    pub async fn segment(
        &self,
        history: &History,
        d: &DestinationRow,
        rec: &HourRecord,
    ) -> anyhow::Result<(PathBuf, bool)> {
        if let Some(p) = self.get(&rec.sha256) {
            return Ok((p, false));
        }
        let remote = history.remote(d)?;
        let bytes = remote
            .get(&ObjPath::from(rec.key.clone()))
            .await?
            .bytes()
            .await?;
        let sha = rec.sha256.clone();
        let raw = tokio::task::spawn_blocking(move || decode_checked(&sha, &bytes)).await??;
        let p = self.insert(&rec.sha256, &raw)?;
        Ok((p, true))
    }
}

// ── Coverage ────────────────────────────────────────────────────────────────

/// What one destination holds of the history part of a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct DestinationCoverage {
    pub id: i64,
    pub name: String,
    pub active: bool,
    /// First and last archived hour it holds in the range, unix ms.
    pub first: Option<i64>,
    pub last: Option<i64>,
    #[ts(type = "number")]
    pub hours: u64,
    /// Of the hours retained history could hold in the range (0–100).
    pub percent: u8,
}

/// Consecutive hours not retained, for one reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct GapRange {
    pub from: i64,
    pub to: i64,
    pub reason: super::GapReason,
}

/// The part of a search range older than the local window, and what
/// retained history holds of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct HistoryCoverage {
    /// The history part of the range, unix ms (`to` is where the local
    /// window starts).
    pub from: i64,
    pub to: i64,
    /// Hours in that part, and how many any destination holds.
    #[ts(type = "number")]
    pub hours: u64,
    #[ts(type = "number")]
    pub archived: u64,
    pub destinations: Vec<DestinationCoverage>,
    pub gaps: Vec<GapRange>,
    /// "No retained history before …": the range starts earlier than the
    /// first archived hour (or the history retention), unix ms.
    pub expired_before: Option<i64>,
    /// Reaches at most [`AUTO_HOURS`] into history: searched along with the
    /// search, without asking.
    pub auto: bool,
    /// More hours than one job searches ([`MAX_HOURS`]).
    pub truncated: bool,
}

/// One archived hour a job will search, from one destination.
#[derive(Debug, Clone)]
pub struct Planned {
    pub hour: i64,
    pub destination: DestinationRow,
    pub rec: HourRecord,
}

impl History {
    /// Coverage of `[since, until]` past the local window, whose first hour
    /// still on disk is `local_first` (`None`: nothing local). `None` when
    /// the range stays inside the local window or history was never used.
    pub fn coverage(
        &self,
        since: i64,
        until: i64,
        local_first: Option<i64>,
        now: i64,
    ) -> anyhow::Result<Option<(HistoryCoverage, Vec<Planned>)>> {
        let boundary = local_first.unwrap_or(until.div_euclid(HOUR) + 1);
        let to = (boundary * HOUR).min(until);
        if since >= to {
            return Ok(None);
        }
        let dests = self.catalog.destinations()?;
        let all = self.catalog.hours_before(boundary)?;
        if dests.is_empty() && all.is_empty() && self.catalog.enabled_at()?.is_none() {
            return Ok(None);
        }
        let (hs, he) = (since.div_euclid(HOUR), (to - 1).div_euclid(HOUR));
        let total = (he - hs + 1).max(0) as u64;
        // Where retained history starts: the first archived hour, never
        // before the history retention cut.
        let cut = retention_before(&self.catalog.policy()?, now);
        let first_any = all.iter().map(|r| r.hour).min();
        let start = match (first_any, cut) {
            (Some(f), Some(c)) => Some(f.max(c)),
            (Some(f), None) => Some(f),
            (None, _) => None,
        };
        let expired_before = match start {
            Some(s) if hs < s => Some(s * HOUR),
            None => Some(to),
            _ => None,
        };
        let names: HashMap<i64, &DestinationRow> = dests.iter().map(|d| (d.id, d)).collect();
        // One record per hour: the active destination's when it has one.
        let mut by_hour: BTreeMap<i64, &HourRecord> = BTreeMap::new();
        for r in all.iter().filter(|r| r.hour >= hs && r.hour <= he) {
            if !names.contains_key(&r.destination_id) {
                continue;
            }
            if cut.is_some_and(|c| r.hour < c) {
                continue;
            }
            let better = match by_hour.get(&r.hour) {
                None => true,
                Some(prev) => {
                    !names[&prev.destination_id].active && names[&r.destination_id].active
                }
            };
            if better {
                by_hour.insert(r.hour, r);
            }
        }
        let reachable = match start {
            Some(s) => (he - hs.max(s) + 1).max(0) as u64,
            None => 0,
        };
        let mut destinations: Vec<DestinationCoverage> = Vec::new();
        for d in &dests {
            let mine: Vec<i64> = all
                .iter()
                .filter(|r| r.destination_id == d.id && r.hour >= hs && r.hour <= he)
                .map(|r| r.hour)
                .collect();
            if mine.is_empty() && !d.active {
                continue;
            }
            let hours = mine.len() as u64;
            destinations.push(DestinationCoverage {
                id: d.id,
                name: d.name.clone(),
                active: d.active,
                first: mine.iter().min().map(|h| h * HOUR),
                last: mine.iter().max().map(|h| (h + 1) * HOUR),
                hours,
                percent: (hours * 100).checked_div(reachable).unwrap_or(0).min(100) as u8,
            });
        }
        let mut gaps: Vec<GapRange> = Vec::new();
        let mut g: Vec<(i64, super::GapReason)> = self
            .catalog
            .gaps(100_000)?
            .into_iter()
            .filter(|(h, _, _)| *h >= hs && *h <= he && !by_hour.contains_key(h))
            .map(|(h, r, _)| (h, r))
            .collect();
        g.sort_by_key(|x| x.0);
        g.dedup_by_key(|x| x.0);
        for (h, reason) in g {
            match gaps.last_mut() {
                Some(last) if last.reason == reason && last.to == h * HOUR => {
                    last.to = (h + 1) * HOUR
                }
                _ => gaps.push(GapRange {
                    from: h * HOUR,
                    to: (h + 1) * HOUR,
                    reason,
                }),
            }
        }
        let mut planned: Vec<Planned> = by_hour
            .iter()
            .rev()
            .map(|(h, r)| Planned {
                hour: *h,
                destination: names[&r.destination_id].clone(),
                rec: (*r).clone(),
            })
            .collect();
        let truncated = planned.len() > MAX_HOURS;
        planned.truncate(MAX_HOURS);
        Ok(Some((
            HistoryCoverage {
                from: since,
                to,
                hours: total,
                archived: by_hour.len() as u64,
                destinations,
                gaps,
                expired_before,
                auto: total <= AUTO_HOURS && !by_hour.is_empty(),
                truncated,
            },
            planned,
        )))
    }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SearchJobState {
    Retrieving,
    Done,
    /// Stopped by the user; what was found stays.
    Cancelled,
    /// Some hours could not be searched (a destination unavailable, a
    /// checksum mismatch): see `failures`.
    Incomplete,
}

/// Hours of one destination a job could not search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct SearchFailure {
    pub destination: String,
    pub from: i64,
    pub to: i64,
    #[ts(type = "number")]
    pub hours: u64,
    pub error: String,
}

/// A history job as the API returns it (one page of its matches).
#[derive(Debug, Clone, Serialize, TS)]
pub struct HistorySearchJob {
    pub id: String,
    pub state: SearchJobState,
    /// Hours searched so far, of `total`.
    pub done: u32,
    pub total: u32,
    /// Compressed bytes of those hours (downloaded or from the cache).
    #[ts(type = "number")]
    pub bytes: u64,
    /// Of them, downloaded now (the rest came from the cache).
    #[ts(type = "number")]
    pub downloaded: u64,
    /// Matches found so far (kept up to 5 000).
    #[ts(type = "number")]
    pub matched: u64,
    #[ts(as = "Vec<LogLine>")]
    pub lines: Vec<Line>,
    /// Where each line came from: destination name by line id.
    #[ts(type = "Record<string, string>")]
    pub locations: BTreeMap<u64, String>,
    /// Matches per bucket, aligned with the search histogram (`buckets`).
    pub histogram: Option<Vec<Bucket>>,
    pub failures: Vec<SearchFailure>,
    pub coverage: HistoryCoverage,
    pub created: i64,
    /// Offset of `lines` in all matches, and how many there are.
    #[ts(type = "number")]
    pub offset: u64,
    #[ts(type = "number")]
    pub count: u64,
}

struct JobInner {
    state: SearchJobState,
    done: u32,
    bytes: u64,
    downloaded: u64,
    matched: u64,
    lines: Vec<(String, Line)>,
    histogram: Option<Vec<Bucket>>,
    failed: BTreeMap<String, (String, Vec<i64>)>,
    finished: Option<i64>,
}

pub struct Job {
    pub id: String,
    pub owner: i64,
    pub created: i64,
    coverage: HistoryCoverage,
    total: u32,
    cancel: CancellationToken,
    inner: Mutex<JobInner>,
}

impl Job {
    pub fn state(&self) -> SearchJobState {
        self.inner.lock().unwrap().state
    }

    /// All matches, newest first, with their location.
    pub fn matches(&self) -> Vec<(String, Line)> {
        self.inner.lock().unwrap().lines.clone()
    }

    pub fn view(&self, offset: usize, limit: usize) -> HistorySearchJob {
        let st = self.inner.lock().unwrap();
        let page: Vec<&(String, Line)> = st.lines.iter().skip(offset).take(limit).collect();
        let failures = st
            .failed
            .iter()
            .map(|(name, (error, hours))| SearchFailure {
                destination: name.clone(),
                from: hours.iter().min().copied().unwrap_or_default() * HOUR,
                to: (hours.iter().max().copied().unwrap_or_default() + 1) * HOUR,
                hours: hours.len() as u64,
                error: error.clone(),
            })
            .collect();
        HistorySearchJob {
            id: self.id.clone(),
            state: st.state,
            done: st.done,
            total: self.total,
            bytes: st.bytes,
            downloaded: st.downloaded,
            matched: st.matched,
            lines: page.iter().map(|(_, l)| l.clone()).collect(),
            locations: page.iter().map(|(n, l)| (l.id, n.clone())).collect(),
            histogram: st.histogram.clone(),
            failures,
            coverage: self.coverage.clone(),
            created: self.created,
            offset: offset as u64,
            count: st.lines.len() as u64,
        }
    }
}

/// Every running and recent history job, and the segment cache.
pub struct HistorySearch {
    pub cache: Arc<Cache>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

#[derive(Debug)]
pub enum JobError {
    NotFound(String),
    NothingToSearch,
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobError::NotFound(id) => write!(f, "no history job {id}"),
            JobError::NothingToSearch => {
                f.write_str("no retained history holds any hour of this range")
            }
        }
    }
}

impl std::error::Error for JobError {}

impl HistorySearch {
    pub fn new(cache: Cache) -> Self {
        HistorySearch {
            cache: Arc::new(cache),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// A job of `owner`'s (or not found: jobs are per user).
    pub fn job(&self, id: &str, owner: i64) -> Result<Arc<Job>, JobError> {
        self.jobs
            .lock()
            .unwrap()
            .get(id)
            .filter(|j| j.owner == owner)
            .cloned()
            .ok_or_else(|| JobError::NotFound(id.to_string()))
    }

    pub fn cancel(&self, id: &str, owner: i64) -> Result<Arc<Job>, JobError> {
        let j = self.job(id, owner)?;
        j.cancel.cancel();
        Ok(j)
    }

    fn prune(&self, owner: i64, now: i64) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.retain(|_, j| {
            let f = j.inner.lock().unwrap().finished;
            f.is_none_or(|f| now - f < KEEP_MS)
        });
        let mut mine: Vec<Arc<Job>> = jobs
            .values()
            .filter(|j| j.owner == owner)
            .cloned()
            .collect();
        mine.sort_by_key(|j| j.created);
        while mine.len() >= PER_USER {
            let old = mine.remove(0);
            old.cancel.cancel();
            jobs.remove(&old.id);
        }
    }

    /// Plan and start a job for `q` (its `since` / `until` set). Returns at
    /// once; the job runs in the background.
    pub fn start(
        self: &Arc<Self>,
        history: Arc<History>,
        q: SearchQuery,
        local_first: Option<i64>,
        owner: i64,
        now: i64,
    ) -> anyhow::Result<Arc<Job>> {
        let (since, until) = (q.since.unwrap_or(0), q.until.unwrap_or(now));
        let (coverage, planned) = history
            .coverage(since, until, local_first, now)?
            .ok_or(JobError::NothingToSearch)?;
        // No archived hour in the range: nothing a job could find.
        if planned.is_empty() {
            return Err(JobError::NothingToSearch.into());
        }
        self.prune(owner, now);
        let job = Arc::new(Job {
            id: format!("hs_{:016x}", rand::random::<u64>()),
            owner,
            created: now,
            total: planned.len() as u32,
            coverage,
            cancel: CancellationToken::new(),
            inner: Mutex::new(JobInner {
                state: SearchJobState::Retrieving,
                done: 0,
                bytes: 0,
                downloaded: 0,
                matched: 0,
                lines: Vec::new(),
                histogram: None,
                failed: BTreeMap::new(),
                finished: None,
            }),
        });
        self.jobs
            .lock()
            .unwrap()
            .insert(job.id.clone(), job.clone());
        let (me, j) = (self.clone(), job.clone());
        tokio::spawn(async move { me.run(history, j, q, planned).await });
        Ok(job)
    }

    async fn run(
        &self,
        history: Arc<History>,
        job: Arc<Job>,
        q: SearchQuery,
        planned: Vec<Planned>,
    ) {
        let mut down: HashSet<i64> = HashSet::new();
        for p in planned {
            if job.cancel.is_cancelled() {
                break;
            }
            let fail = |e: String| {
                let mut st = job.inner.lock().unwrap();
                let entry = st
                    .failed
                    .entry(p.destination.name.clone())
                    .or_insert_with(|| (e, Vec::new()));
                entry.1.push(p.hour);
                st.done += 1;
            };
            // One failure marks the destination unavailable for this job:
            // its other hours are listed as not searched, not retried.
            if down.contains(&p.destination.id) {
                fail(String::new());
                continue;
            }
            let got = tokio::select! {
                r = self.cache.segment(&history, &p.destination, &p.rec) => r,
                _ = job.cancel.cancelled() => break,
            };
            let (path, fetched) = match got {
                Ok(x) => x,
                Err(e) => {
                    down.insert(p.destination.id);
                    fail(format!("{e:#}"));
                    continue;
                }
            };
            let mut hq = q.clone();
            hq.cursor = None;
            hq.limit = MAX_LINES
                .saturating_sub(job.inner.lock().unwrap().lines.len())
                .max(1);
            let hour = p.hour;
            let page =
                tokio::task::spawn_blocking(move || crate::store::search_segment(&path, hour, &hq))
                    .await;
            let page = match page {
                Ok(Ok(page)) => page,
                Ok(Err(e)) => {
                    fail(format!("{e:#}"));
                    continue;
                }
                Err(e) => {
                    fail(e.to_string());
                    continue;
                }
            };
            let mut st = job.inner.lock().unwrap();
            st.done += 1;
            st.bytes += p.rec.bytes_stored;
            if fetched {
                st.downloaded += p.rec.bytes_stored;
            }
            st.matched += page.total.unwrap_or(page.lines.len() as u64);
            let room = MAX_LINES.saturating_sub(st.lines.len());
            let name = p.destination.name.clone();
            st.lines
                .extend(page.lines.into_iter().take(room).map(|l| (name.clone(), l)));
            if let Some(h) = page.histogram {
                match &mut st.histogram {
                    None => st.histogram = Some(h),
                    Some(acc) => {
                        for (a, b) in acc.iter_mut().zip(h) {
                            a.count += b.count;
                            a.debug += b.debug;
                            a.info += b.info;
                            a.warn += b.warn;
                            a.error += b.error;
                        }
                    }
                }
            }
        }
        let mut st = job.inner.lock().unwrap();
        // Hours are walked newest first; a skewed line can sit in a neighbour.
        st.lines
            .sort_by_key(|x| std::cmp::Reverse((x.1.ts, x.1.id)));
        st.state = if job.cancel.is_cancelled() {
            SearchJobState::Cancelled
        } else if !st.failed.is_empty() {
            SearchJobState::Incomplete
        } else {
            SearchJobState::Done
        };
        // Destinations whose first failure was a skip keep the real error.
        for (err, _) in st.failed.values_mut() {
            if err.is_empty() {
                *err = "not searched".into();
            }
        }
        st.finished = Some(chrono::Utc::now().timestamp_millis());
    }
}

// ── Flow marker ─────────────────────────────────────────────────────────────

/// "Related history unavailable" on a flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct FlowHistory {
    /// Retained history ends here (the local window starts), unix ms.
    pub until: i64,
    /// Where it starts, unix ms.
    pub since: i64,
    /// A segment already in the cache holds one of the flow's ids.
    pub found: bool,
}

impl HistorySearch {
    /// Whether a flow may continue in history not loaded: history holds
    /// hours before the local window, and either the flow starts within an
    /// hour of that edge or a cached segment's id index has one of its ids.
    pub fn flow_history(
        &self,
        history: &History,
        ids: &[String],
        earliest: Option<i64>,
        local_first: Option<i64>,
    ) -> anyhow::Result<Option<FlowHistory>> {
        let Some(first) = local_first else {
            return Ok(None);
        };
        let hours = history.catalog.hours_before(first)?;
        let Some(oldest) = hours.iter().map(|h| h.hour).min() else {
            return Ok(None);
        };
        let edge = first * HOUR;
        let near = earliest.is_some_and(|e| e - edge < HOUR);
        let mut found = false;
        for h in hours.iter().rev() {
            if let Some(p) = self.cache.get(&h.sha256) {
                if crate::store::segment_has_ids(&p, h.hour, ids).unwrap_or(false) {
                    found = true;
                    break;
                }
            }
        }
        Ok((near || found).then_some(FlowHistory {
            until: edge,
            since: oldest * HOUR,
            found,
        }))
    }
}
