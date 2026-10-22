//! One path for every line, whichever receiver it came from:
//! normalize → store → broadcast.

use crate::hub::{Hub, Line, SourceKind};
use crate::normalize::normalize;
use crate::store::Store;
use std::sync::Arc;
use tokio::sync::Mutex;

/// A line as a receiver saw it, before any parsing.
#[derive(Debug, Clone)]
pub struct RawLine {
    pub text: String,
    pub source: String,
    /// Timestamp the collector attached (Docker's `timestamps=1`), unix ms.
    pub collector_ts: Option<i64>,
    /// Arrival at quiet, unix ms.
    pub received: i64,
}

impl RawLine {
    pub fn new(text: impl Into<String>, source: impl Into<String>, received: i64) -> Self {
        RawLine {
            text: text.into(),
            source: source.into(),
            collector_ts: None,
            received,
        }
    }
}

pub struct Pipeline {
    store: Arc<dyn Store>,
    hub: Arc<Hub>,
    /// Next line id. Held across store + broadcast so ids reach subscribers in
    /// order; the stream dedupes its backlog against live lines by id.
    next_id: Mutex<u64>,
}

impl Pipeline {
    pub fn new(store: Arc<dyn Store>, hub: Arc<Hub>) -> Arc<Self> {
        Arc::new(Pipeline {
            store,
            hub,
            next_id: Mutex::new(1),
        })
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    pub fn store(&self) -> &Arc<dyn Store> {
        &self.store
    }

    /// Normalize, store and fan out a batch. Returns the stored lines.
    pub async fn ingest(
        &self,
        kind: SourceKind,
        raws: impl IntoIterator<Item = RawLine>,
    ) -> anyhow::Result<Vec<Line>> {
        // Parse outside the lock; it is the expensive part.
        let mut lines: Vec<_> = raws
            .into_iter()
            .map(|r| normalize(&r.text, &r.source, r.collector_ts, r.received))
            .collect();
        if lines.is_empty() {
            return Ok(Vec::new());
        }
        let mut next = self.next_id.lock().await;
        let lines: Vec<Line> = lines
            .drain(..)
            .map(|mut l| {
                l.id = *next;
                *next += 1;
                Arc::new(l)
            })
            .collect();
        self.store.append(&lines).await?;
        for line in &lines {
            self.hub.broadcast(line, kind);
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;

    #[tokio::test]
    async fn ids_are_monotonic_and_lines_reach_store_and_subscribers() {
        let hub = Hub::new();
        let p = Pipeline::new(Arc::new(MemoryStore::new(3)), hub.clone());
        let mut rx = hub.ensure_source("api", SourceKind::Http).subscribe();
        for i in 0..5 {
            p.ingest(
                SourceKind::Http,
                [RawLine::new(format!("line {i}"), "api", i)],
            )
            .await
            .unwrap();
        }
        let tail = p.store().tail("api", 10).await.unwrap();
        assert_eq!(tail.iter().map(|l| l.id).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(hub.source("api").unwrap().meta().lines, 5);
        assert_eq!(rx.recv().await.unwrap().id, 1);
    }
}
