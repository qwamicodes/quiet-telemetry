//! One path for every line, whichever receiver it came from:
//! normalize → store → broadcast.

use crate::hub::{Hub, Line, SourceKind};
use crate::normalize::normalize;
use crate::settings::Settings;
use crate::store::Store;
use crate::system::SystemState;
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
    /// Live instance settings (paused sources, retention, id policy).
    settings: Arc<Settings>,
    /// Counters the system status reads: rejected requests, paused drops, store errors.
    system: Arc<SystemState>,
    /// Next line id. Held across store + broadcast so ids reach subscribers in
    /// order; the stream dedupes its backlog against live lines by id.
    next_id: Mutex<u64>,
}

impl Pipeline {
    /// With in-memory settings (tests).
    #[cfg(test)]
    pub fn new(store: Arc<dyn Store>, hub: Arc<Hub>) -> Arc<Self> {
        Self::with_settings(store, hub, Arc::new(Settings::memory()))
    }

    pub fn with_settings(
        store: Arc<dyn Store>,
        hub: Arc<Hub>,
        settings: Arc<Settings>,
    ) -> Arc<Self> {
        Arc::new(Pipeline {
            store,
            hub,
            settings,
            system: Arc::new(SystemState::default()),
            next_id: Mutex::new(1),
        })
    }

    pub fn settings(&self) -> &Arc<Settings> {
        &self.settings
    }

    pub fn system(&self) -> &Arc<SystemState> {
        &self.system
    }

    /// Carry on after a restart: ids continue past the last stored one and
    /// stored sources are listed (with their counts) before they log again.
    pub async fn restore(&self) -> anyhow::Result<()> {
        let r = self.store.restore().await?;
        *self.next_id.lock().await = r.last_id + 1;
        for s in r.sources {
            let src = self.hub.ensure_source(&s.name, s.kind);
            src.update_meta(|m| {
                m.lines = s.lines;
                m.last_ts = s.last_ts;
            });
        }
        Ok(())
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
        // Paused sources (Sources → Settings → Pause ingest) are dropped and
        // counted before any parsing.
        let mut paused: Vec<(String, u64)> = Vec::new();
        let raws: Vec<RawLine> = raws
            .into_iter()
            .filter(|r| {
                if !self.settings.paused(&r.source) {
                    return true;
                }
                match paused.iter_mut().find(|(s, _)| *s == r.source) {
                    Some((_, n)) => *n += 1,
                    None => paused.push((r.source.clone(), 1)),
                }
                false
            })
            .collect();
        for (source, n) in paused {
            self.system.paused_drop(&source, n);
        }
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
        if let Err(e) = self.store.append(kind, &lines).await {
            self.system.store_error(&e);
            return Err(e);
        }
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

    #[tokio::test]
    async fn paused_sources_are_dropped_and_counted() {
        let p = Pipeline::new(Arc::new(MemoryStore::new(10)), Hub::new());
        p.settings()
            .put_source(
                "noisy",
                crate::settings::SourceSettings {
                    paused: true,
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let got = p
            .ingest(
                SourceKind::Http,
                [
                    RawLine::new("a", "noisy", 1),
                    RawLine::new("b", "api", 1),
                    RawLine::new("c", "noisy", 1),
                ],
            )
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].source, "api");
        assert!(p.store().tail("noisy", 10).await.unwrap().is_empty());
        assert_eq!(p.system().paused_dropped("noisy"), 2);
    }
}
