//! The live side: one ring buffer + one broadcast channel per source.
//!
//! Receivers call [`Hub::publish`]; UI streams call [`Source::subscribe`]
//! and read the ring for backlog. Storage (SQLite) joins in slice 2.

use crate::normalize::LogLine;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;

pub type Line = Arc<LogLine>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Docker,
    Http,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SourceMeta {
    /// Containers feeding this source (docker only).
    pub containers: Vec<String>,
    /// e.g. compose project or swarm stack.
    pub group: Option<String>,
    pub lines: u64,
    pub last_ts: Option<i64>,
}

pub struct Source {
    pub name: String,
    pub kind: SourceKind,
    meta: Mutex<SourceMeta>,
    ring: Mutex<VecDeque<Line>>,
    tx: broadcast::Sender<Line>,
}

impl Source {
    pub fn subscribe(&self) -> broadcast::Receiver<Line> {
        self.tx.subscribe()
    }

    /// The newest `limit` lines, oldest first.
    pub fn tail(&self, limit: usize) -> Vec<Line> {
        let ring = self.ring.lock().unwrap();
        let skip = ring.len().saturating_sub(limit);
        ring.iter().skip(skip).cloned().collect()
    }

    pub fn meta(&self) -> SourceMeta {
        self.meta.lock().unwrap().clone()
    }

    pub fn update_meta(&self, f: impl FnOnce(&mut SourceMeta)) {
        f(&mut self.meta.lock().unwrap());
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub name: String,
    pub kind: SourceKind,
    #[serde(flatten)]
    pub meta: SourceMeta,
}

pub struct Hub {
    sources: RwLock<HashMap<String, Arc<Source>>>,
    next_id: AtomicU64,
    ring_cap: usize,
}

impl Hub {
    pub fn new(ring_cap: usize) -> Arc<Hub> {
        Arc::new(Hub {
            sources: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            ring_cap,
        })
    }

    pub fn source(&self, name: &str) -> Option<Arc<Source>> {
        self.sources.read().unwrap().get(name).cloned()
    }

    pub fn ensure_source(&self, name: &str, kind: SourceKind) -> Arc<Source> {
        if let Some(s) = self.source(name) {
            return s;
        }
        let mut map = self.sources.write().unwrap();
        map.entry(name.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(8192);
                Arc::new(Source {
                    name: name.to_string(),
                    kind,
                    meta: Mutex::new(SourceMeta::default()),
                    ring: Mutex::new(VecDeque::with_capacity(self.ring_cap.min(1024))),
                    tx,
                })
            })
            .clone()
    }

    pub fn list(&self) -> Vec<SourceInfo> {
        let mut v: Vec<_> = self
            .sources
            .read()
            .unwrap()
            .values()
            .map(|s| SourceInfo {
                name: s.name.clone(),
                kind: s.kind,
                meta: s.meta(),
            })
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// Assign an id, keep it in the ring, fan it out. Returns the shared line.
    pub fn publish(&self, mut line: LogLine, kind: SourceKind) -> Line {
        let source = self.ensure_source(&line.source, kind);
        line.id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let line = Arc::new(line);
        {
            let mut ring = source.ring.lock().unwrap();
            if ring.len() >= self.ring_cap {
                ring.pop_front();
            }
            ring.push_back(line.clone());
        }
        source.update_meta(|m| {
            m.lines += 1;
            m.last_ts = Some(m.last_ts.map_or(line.ts, |t| t.max(line.ts)));
        });
        // No subscribers is fine.
        let _ = source.tx.send(line.clone());
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    #[test]
    fn ring_is_bounded_and_ids_monotonic() {
        let hub = Hub::new(3);
        for i in 0..5 {
            hub.publish(
                normalize(&format!("line {i}"), "api", None, i),
                SourceKind::Http,
            );
        }
        let s = hub.source("api").unwrap();
        let tail = s.tail(10);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail.iter().map(|l| l.id).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(s.meta().lines, 5);
        assert_eq!(s.tail(1)[0].msg, "line 4");
    }

    #[tokio::test]
    async fn subscribers_get_new_lines() {
        let hub = Hub::new(10);
        let s = hub.ensure_source("api", SourceKind::Http);
        let mut rx = s.subscribe();
        hub.publish(normalize("hello", "api", None, 0), SourceKind::Http);
        assert_eq!(rx.recv().await.unwrap().msg, "hello");
    }
}
