//! The live side: the source registry and one broadcast channel per source.
//!
//! The [`Pipeline`](crate::pipeline::Pipeline) publishes here after the line
//! is stored; UI streams call [`Source::subscribe`]. Lines themselves live in
//! the [`Store`](crate::store::Store), not here.

use crate::normalize::LogLine;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;
use ts_rs::TS;

pub type Line = Arc<LogLine>;

/// Per-source fan-out buffer. A client that falls further behind gets a `gap` frame.
const FANOUT: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Docker,
    Http,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
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
    tx: broadcast::Sender<Line>,
}

impl Source {
    pub fn subscribe(&self) -> broadcast::Receiver<Line> {
        self.tx.subscribe()
    }

    pub fn meta(&self) -> SourceMeta {
        self.meta.lock().unwrap().clone()
    }

    pub fn update_meta(&self, f: impl FnOnce(&mut SourceMeta)) {
        f(&mut self.meta.lock().unwrap());
    }

    pub fn info(&self) -> SourceInfo {
        SourceInfo {
            name: self.name.clone(),
            kind: self.kind,
            meta: self.meta(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceInfo {
    pub name: String,
    pub kind: SourceKind,
    #[serde(flatten)]
    pub meta: SourceMeta,
}

#[derive(Default)]
pub struct Hub {
    sources: RwLock<HashMap<String, Arc<Source>>>,
}

impl Hub {
    pub fn new() -> Arc<Hub> {
        Arc::new(Hub::default())
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
                let (tx, _) = broadcast::channel(FANOUT);
                Arc::new(Source {
                    name: name.to_string(),
                    kind,
                    meta: Mutex::new(SourceMeta::default()),
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
            .map(|s| s.info())
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// Count the line on its source and fan it out. No subscribers is fine.
    pub fn broadcast(&self, line: &Line, kind: SourceKind) {
        let source = self.ensure_source(&line.source, kind);
        source.update_meta(|m| {
            m.lines += 1;
            m.last_ts = Some(m.last_ts.map_or(line.ts, |t| t.max(line.ts)));
        });
        let _ = source.tx.send(line.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    #[tokio::test]
    async fn subscribers_get_new_lines_and_meta_counts() {
        let hub = Hub::new();
        let s = hub.ensure_source("api", SourceKind::Http);
        let mut rx = s.subscribe();
        let line = Arc::new(normalize("hello", "api", None, 7));
        hub.broadcast(&line, SourceKind::Http);
        assert_eq!(rx.recv().await.unwrap().msg, "hello");
        assert_eq!(s.meta().lines, 1);
        assert_eq!(s.meta().last_ts, Some(7));
    }
}
