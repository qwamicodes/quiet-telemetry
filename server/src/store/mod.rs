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
pub use sqlite::{SqliteOptions, SqliteStore};

use crate::hub::{Line, SourceKind};
use crate::normalize::Level;
use crate::search::{SearchPage, SearchQuery};
use async_trait::async_trait;

/// What a stream or a search asks for. Shared by every store so the live
/// filter and the stored-window filter can never disagree.
#[derive(Debug, Clone, Default)]
pub struct LineFilter {
    /// Minimum level; lines without a level are dropped when this is set.
    pub min_level: Option<Level>,
    /// Case-insensitive substring over the raw line (search uses FTS5).
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

    /// Drop what is older than `cutoff` (unix ms). Partitioned stores drop
    /// whole hours, so a line may outlive the cutoff by up to an hour.
    /// Returns how many lines went.
    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64>;

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

#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub bytes: u64,
    pub lines: u64,
    /// Oldest event time still kept, unix ms.
    pub oldest: Option<i64>,
}
