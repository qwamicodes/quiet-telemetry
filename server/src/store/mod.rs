//! Where lines live after they are normalized.
//!
//! v0.1 keeps a bounded ring per source in memory ([`MemoryStore`]). Slice 2
//! adds a SQLite store (WAL, one table per hour so expiry is a `DROP TABLE`,
//! FTS5 over `raw`) behind the same trait; the ring stays in front of it as the
//! live tail. Per-minute rollups (metrics from logs, v0.2) will be another
//! pipeline stage that reads the same appended batches, not a change here.

mod memory;

pub use memory::MemoryStore;

use crate::hub::Line;
use crate::normalize::Level;
use async_trait::async_trait;

/// What a stream or a search asks for. Shared by every store so the live
/// filter and the stored-window filter can never disagree.
#[derive(Debug, Clone, Default)]
pub struct LineFilter {
    /// Minimum level; lines without a level are dropped when this is set.
    pub min_level: Option<Level>,
    /// Case-insensitive substring over the raw line (FTS5 in slice 2).
    pub text: Option<String>,
}

impl LineFilter {
    pub fn new(level: Option<&str>, text: Option<&str>) -> Self {
        LineFilter {
            min_level: level.and_then(Level::parse_name),
            text: text
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty()),
        }
    }

    pub fn matches(&self, line: &Line) -> bool {
        if let Some(min) = self.min_level {
            match line.level {
                Some(l) if l as u8 >= min as u8 => {}
                _ => return false,
            }
        }
        if let Some(q) = &self.text {
            if !line.raw.to_lowercase().contains(q) {
                return false;
            }
        }
        true
    }
}

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

    /// Keep these lines. Ids are already assigned and increase within a batch.
    /// Implementations may buffer, but a line must be readable by [`Store::query`]
    /// once this returns (the stream's backlog depends on it).
    async fn append(&self, lines: &[Line]) -> anyhow::Result<()>;

    /// Matching lines for one source: the newest `limit`, oldest first.
    async fn query(&self, q: &Query) -> anyhow::Result<Vec<Line>>;

    /// Drop everything with an event time before `cutoff` (unix ms).
    /// Returns how many lines went. Retention (slice 6) calls this on a timer.
    #[allow(dead_code)] // no caller until retention lands; the ring bounds itself
    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64>;

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
