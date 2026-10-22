//! Where lines live after they are normalized.
//!
//! - [`MemoryStore`]: a bounded ring per source. Fast, gone on restart; tests
//!   and `--store memory` use it.
//! - [`SqliteStore`]: the searchable window on disk (WAL, one table set per
//!   hour so expiry is a `DROP TABLE`, FTS5 over the raw line, a side index of
//!   every correlation id). A memory ring stays in front of it as the live tail.
//!
//! Per-minute rollups (metrics from logs, v0.2) will be another pipeline stage
//! that reads the same appended batches, not a change here.

mod memory;
mod sqlite;

pub use memory::MemoryStore;
#[cfg(test)]
pub use memory::DEFAULT_RING_MEMORY;
pub use sqlite::{SqliteOptions, SqliteStore};

use crate::hub::{Line, SourceKind};
use crate::normalize::{CorrId, Level};
use crate::search::{Bucket, Order, SearchPage, SearchQuery};
use async_trait::async_trait;
use serde::Serialize;
use ts_rs::TS;

/// What a stream asks for. Shared by every store so the live filter and the
/// stored-window filter can never disagree: `q` is the search language
/// (`search.rs`), so stream chips (`status:>=400`, `-path:/health`) mean the
/// same thing in the stream, in search and in an export.
#[derive(Debug, Clone, Default)]
pub struct LineFilter {
    /// Minimum level; lines without a level are dropped when this is set.
    pub min_level: Option<Level>,
    /// Words, phrases and `key:value` filters, plus the level chips.
    pub query: Option<SearchQuery>,
}

impl LineFilter {
    #[cfg(test)]
    pub fn new(level: Option<&str>, text: Option<&str>) -> Self {
        Self::with_levels(level, None, text)
    }

    /// `levels`: exactly these chips (`info,warn`); ignored when empty.
    pub fn with_levels(level: Option<&str>, levels: Option<&str>, text: Option<&str>) -> Self {
        let mut q = SearchQuery::default().parse_q(text.unwrap_or(""));
        if let Some(ls) = levels.and_then(|l| crate::search::parse_levels(l).ok()) {
            if !ls.is_empty() && ls.len() < 4 {
                q.levels = ls;
            }
        }
        let trivial = q.text.is_empty()
            && q.not_text.is_empty()
            && q.fields.is_empty()
            && q.ids.is_empty()
            && q.levels.is_empty()
            && q.min_level.is_none()
            && q.sources.is_empty();
        LineFilter {
            min_level: level.and_then(Level::parse_name),
            query: (!trivial).then_some(q),
        }
    }

    /// True when nothing is filtered (the backlog can come from the ring).
    pub fn is_empty(&self) -> bool {
        self.min_level.is_none() && self.query.is_none()
    }

    pub fn matches(&self, line: &Line) -> bool {
        if let Some(min) = self.min_level {
            match line.level {
                Some(l) if l as u8 >= min as u8 => {}
                _ => return false,
            }
        }
        self.query.as_ref().is_none_or(|q| q.matches(line))
    }
}

/// How many lines a query matches per stored level rank (0 trace … 5 fatal,
/// 6 = no level), and optionally a histogram over `[since, since + n·width)`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LevelCounts {
    pub by_rank: [u64; 7],
    pub histogram: Vec<Bucket>,
}

impl LevelCounts {
    pub fn add(&mut self, level: Option<Level>) {
        self.by_rank[level.map_or(6, |l| l as usize)] += 1;
    }
    pub fn total(&self) -> u64 {
        self.by_rank.iter().sum()
    }
}

/// Histogram request for [`Store::level_counts`]: start, bucket width, bars.
pub type HistSpec = (i64, i64, usize);

/// A read over the stored window.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub source: String,
    pub filter: LineFilter,
    /// Event time bounds, unix ms, inclusive. `None` = open.
    pub since: Option<i64>,
    pub until: Option<i64>,
    /// Newest `limit` matches are returned, oldest first.
    pub limit: usize,
}

#[async_trait]
pub trait Store: Send + Sync + 'static {
    /// Short name for logs and `/api/health` (`memory`, later `sqlite`).
    fn kind(&self) -> &'static str;

    /// Keep these lines (all from sources of `kind`). Ids are already assigned
    /// and increase within a batch. Implementations may buffer, but a line must
    /// be readable by [`Store::query`] once this returns (the stream's backlog
    /// depends on it); [`Store::search`] may lag until [`Store::flush`].
    async fn append(&self, kind: SourceKind, lines: &[Line]) -> anyhow::Result<()>;

    /// Matching lines for one source: the newest `limit`, oldest first.
    /// This is the live tail (stream backlog).
    async fn query(&self, q: &Query) -> anyhow::Result<Vec<Line>>;

    /// One page of a search across the stored window.
    async fn search(&self, q: &SearchQuery) -> anyhow::Result<SearchPage>;

    /// Per-level counts of every line `q` matches (paging fields ignored),
    /// for the stream's level chips and histogram.
    async fn level_counts(
        &self,
        q: &SearchQuery,
        hist: Option<HistSpec>,
    ) -> anyhow::Result<LevelCounts>;

    /// Drop what is older than `cutoff` (unix ms). Partitioned stores drop
    /// whole hours, so a line may outlive the cutoff by up to an hour.
    /// Returns how many lines went.
    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64>;

    /// Drop lines of one source older than `cutoff` (a per-source window
    /// shorter than the instance's). Returns how many lines went.
    async fn expire_source(&self, source: &str, cutoff: i64) -> anyhow::Result<u64>;

    /// Delete every stored line (`None`) or every line of one source, now.
    /// Returns how many lines went.
    async fn purge(&self, source: Option<&str>) -> anyhow::Result<u64>;

    /// Per-hour partitions and per-source volume (Settings → Storage).
    async fn storage(&self) -> anyhow::Result<StorageUsage> {
        Ok(StorageUsage::default())
    }

    /// Write errors seen by the store (a full disk, a broken database).
    fn health(&self) -> StoreHealth {
        StoreHealth::default()
    }

    /// Drop the oldest hours until the store is under `max_bytes`.
    /// Returns how many lines went. Stores without a disk footprint ignore it.
    async fn enforce_cap(&self, _max_bytes: u64) -> anyhow::Result<u64> {
        Ok(0)
    }

    /// Make every appended line searchable (write buffers to disk).
    async fn flush(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// What survived a restart: the last line id and the known sources.
    async fn restore(&self) -> anyhow::Result<Restored> {
        Ok(Restored::default())
    }

    /// Bytes on disk and lines kept, for `/api/health` and the cap.
    async fn usage(&self) -> anyhow::Result<Usage> {
        Ok(Usage::default())
    }

    /// Every line carrying any of `ids` (any key) with an event time in
    /// `[since, until]`, oldest first, at most `limit`. This is what flows
    /// stitch on, so it must answer from the id index, never a scan.
    async fn with_ids(
        &self,
        ids: &[String],
        since: i64,
        until: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<Line>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let page = self
            .search(&SearchQuery {
                ids: ids.to_vec(),
                since: Some(since),
                until: Some(until),
                order: Order::Oldest,
                limit: limit.max(1),
                ..Default::default()
            })
            .await?;
        Ok(page.lines)
    }

    /// One line by its id, wherever it is in the window.
    async fn line(&self, id: u64) -> anyhow::Result<Option<Line>>;

    /// Ids that look like `value` (same prefix), for "close matches" when an
    /// id has no lines: `(id, newest line id carrying it)`, at most `limit`.
    async fn similar_ids(
        &self,
        _value: &str,
        _since: i64,
        _until: i64,
        _limit: usize,
    ) -> anyhow::Result<Vec<(CorrId, u64)>> {
        Ok(Vec::new())
    }

    /// The newest `limit` lines of a source, unfiltered.
    async fn tail(&self, source: &str, limit: usize) -> anyhow::Result<Vec<Line>> {
        self.query(&Query {
            source: source.to_string(),
            limit,
            ..Default::default()
        })
        .await
    }
}

/// The prefix "close matches" share with `value`: all but its last two
/// characters, and only for ids long enough that a prefix means something.
pub fn similar_prefix(value: &str) -> Option<String> {
    let n = value.chars().count();
    (n >= 6).then(|| value.chars().take(n - 2).collect())
}

/// Keep the `limit` candidates closest to `value` (edit distance, then the
/// newest line), never `value` itself.
pub fn rank_similar(
    value: &str,
    mut found: Vec<(CorrId, u64)>,
    limit: usize,
) -> Vec<(CorrId, u64)> {
    found.retain(|(c, _)| c.value != value);
    found.sort_by(|a, b| {
        edit_distance(value, &a.0.value)
            .cmp(&edit_distance(value, &b.0.value))
            .then(b.1.cmp(&a.1))
    });
    found.dedup_by(|a, b| a.0.value == b.0.value);
    found.truncate(limit);
    found
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb))
                .min(prev[j + 1] + 1)
                .min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// What a store remembers across restarts.
#[derive(Debug, Clone, Default)]
pub struct Restored {
    pub last_id: u64,
    pub sources: Vec<StoredSource>,
}

#[derive(Debug, Clone)]
pub struct StoredSource {
    pub name: String,
    pub kind: SourceKind,
    pub lines: u64,
    pub last_ts: Option<i64>,
}

/// Write errors a store has seen since start.
#[derive(Debug, Clone, Default)]
pub struct StoreHealth {
    pub write_errors: u64,
    /// When (unix ms) and what the last one was.
    pub last_error: Option<(i64, String)>,
}

/// One hourly partition.
#[derive(Debug, Clone, Serialize, TS)]
pub struct HourUsage {
    /// Start of the hour, unix ms.
    pub start: i64,
    #[ts(type = "number")]
    pub lines: u64,
    /// Raw line bytes stored in it (not counting indexes).
    #[ts(type = "number")]
    pub bytes: u64,
}

/// What one source holds in the window.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceUsage {
    pub source: String,
    #[ts(type = "number")]
    pub lines: u64,
    /// Raw line bytes (the on-disk share is this share of the database size).
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct StorageUsage {
    /// Oldest first.
    pub hours: Vec<HourUsage>,
    /// Biggest first.
    pub sources: Vec<SourceUsage>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub bytes: u64,
    pub lines: u64,
    /// Oldest event time still kept, unix ms.
    pub oldest: Option<i64>,
}
