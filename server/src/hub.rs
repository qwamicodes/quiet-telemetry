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

/// Which receiver a source's lines arrive through (the sources list shows it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// The local Docker socket.
    Docker,
    /// Plain NDJSON / text over HTTP (`curl`, `quiet pipe`).
    Http,
    /// Vector's `http` sink.
    Vector,
    /// Fluent Bit's `http` output.
    Fluentbit,
    /// OTLP/HTTP logs or traces.
    Otlp,
}

impl SourceKind {
    /// Stable name, as stored on disk.
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Docker => "docker",
            SourceKind::Http => "http",
            SourceKind::Vector => "vector",
            SourceKind::Fluentbit => "fluentbit",
            SourceKind::Otlp => "otlp",
        }
    }

    /// Inverse of [`SourceKind::as_str`]; anything unknown reads as `http`.
    pub fn parse(s: &str) -> SourceKind {
        match s {
            "docker" => SourceKind::Docker,
            "vector" => SourceKind::Vector,
            "fluentbit" => SourceKind::Fluentbit,
            "otlp" => SourceKind::Otlp,
            _ => SourceKind::Http,
        }
    }
}

/// What a source's group is (Sources page / sidebar grouping, like a
/// container manager's Containers view).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// `com.docker.compose.project`
    Compose,
    /// `com.docker.stack.namespace` (Swarm)
    Stack,
    /// A Docker container in no project or stack.
    Standalone,
    /// Pushed over HTTP, Vector, Fluent Bit or OTLP.
    Ingest,
}

/// Group names for sources without a project or stack.
pub const STANDALONE_GROUP: &str = "Standalone";
pub const INGEST_GROUP: &str = "Ingest";

#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct SourceMeta {
    /// Containers feeding this source (docker only).
    pub containers: Vec<String>,
    /// Compose project or Swarm stack; `Standalone` / `Ingest` otherwise
    /// (filled in by [`Source::info`]).
    pub group: Option<String>,
    /// What `group` is. Docker sets it from labels; [`Source::info`] fills the rest.
    pub group_kind: Option<GroupKind>,
    pub lines: u64,
    pub last_ts: Option<i64>,
}

pub struct Source {
    pub name: String,
    /// The receiver of its first line. A source opened in the UI before any
    /// line arrived is a placeholder (`http`) until its first line says otherwise.
    kind: Mutex<SourceKind>,
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

    pub fn kind(&self) -> SourceKind {
        *self.kind.lock().unwrap()
    }

    pub fn info(&self) -> SourceInfo {
        let kind = self.kind();
        let mut meta = self.meta();
        let (group, group_kind) = match (kind, meta.group_kind, meta.group.take()) {
            (SourceKind::Docker, Some(k), Some(g)) if k != GroupKind::Standalone => (g, k),
            (SourceKind::Docker, _, _) => (STANDALONE_GROUP.to_string(), GroupKind::Standalone),
            _ => (INGEST_GROUP.to_string(), GroupKind::Ingest),
        };
        meta.group = Some(group);
        meta.group_kind = Some(group_kind);
        SourceInfo {
            name: self.name.clone(),
            kind,
            meta,
            display_name: None,
            hidden: false,
            paused: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SourceInfo {
    pub name: String,
    pub kind: SourceKind,
    #[serde(flatten)]
    pub meta: SourceMeta,
    /// From its settings: shown instead of `name` (stored lines keep `name`).
    pub display_name: Option<String>,
    /// Left out of the sidebar (still stored and searchable).
    pub hidden: bool,
    /// Ingest paused: new lines are dropped.
    pub paused: bool,
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
                    kind: Mutex::new(kind),
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
            if m.lines == 0 {
                *source.kind.lock().unwrap() = kind;
            }
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

    #[test]
    fn groups_fall_back_to_standalone_and_ingest() {
        let hub = Hub::new();
        let c = hub.ensure_source("api", SourceKind::Docker);
        c.update_meta(|m| {
            m.group = Some("shop".into());
            m.group_kind = Some(GroupKind::Compose);
        });
        hub.ensure_source("redis", SourceKind::Docker);
        hub.ensure_source("payments", SourceKind::Otlp);
        let by = |n: &str| {
            let i = hub.source(n).unwrap().info();
            (i.meta.group.unwrap(), i.meta.group_kind.unwrap())
        };
        assert_eq!(by("api"), ("shop".into(), GroupKind::Compose));
        assert_eq!(
            by("redis"),
            (STANDALONE_GROUP.into(), GroupKind::Standalone)
        );
        assert_eq!(by("payments"), (INGEST_GROUP.into(), GroupKind::Ingest));
    }

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

    #[test]
    fn placeholder_source_takes_the_kind_of_its_first_line() {
        let hub = Hub::new();
        let s = hub.ensure_source("edge", SourceKind::Http);
        let line = Arc::new(normalize("x", "edge", None, 1));
        hub.broadcast(&line, SourceKind::Vector);
        hub.broadcast(&line, SourceKind::Otlp);
        assert_eq!(s.kind(), SourceKind::Vector);
        for k in ["docker", "http", "vector", "fluentbit", "otlp"] {
            assert_eq!(SourceKind::parse(k).as_str(), k);
        }
    }
}
