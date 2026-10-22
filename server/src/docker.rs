//! Docker receiver: follow every running container on the local socket.
//!
//! Source naming (decision d-sources, 2026-10-22):
//!   swarm service label → compose service label → container name.
//! Containers that share a name (replicas, restarts) merge into one source.

use crate::hub::{Hub, SourceKind};
use crate::normalize::normalize;
use bollard::container::{ListContainersOptions, LogOutput, LogsOptions};
use bollard::system::EventsOptions;
use bollard::Docker;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SWARM_SERVICE: &str = "com.docker.swarm.service.name";
const SWARM_STACK: &str = "com.docker.stack.namespace";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_PROJECT: &str = "com.docker.compose.project";
/// Opt a container out: `quiet.ignore=true`. Rename: `quiet.source=name`.
const QUIET_IGNORE: &str = "quiet.ignore";
const QUIET_SOURCE: &str = "quiet.source";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Naming {
    pub source: String,
    pub group: Option<String>,
}

pub fn name_for(container_name: &str, labels: &HashMap<String, String>) -> Option<Naming> {
    if labels
        .get(QUIET_IGNORE)
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        return None;
    }
    if let Some(s) = labels.get(QUIET_SOURCE) {
        return Some(Naming {
            source: s.clone(),
            group: None,
        });
    }
    if let Some(svc) = labels.get(SWARM_SERVICE) {
        let stack = labels.get(SWARM_STACK).cloned();
        // Swarm names services "<stack>_<svc>"; show the short one.
        let short = match &stack {
            Some(st) => svc
                .strip_prefix(&format!("{st}_"))
                .unwrap_or(svc)
                .to_string(),
            None => svc.clone(),
        };
        return Some(Naming {
            source: short,
            group: stack,
        });
    }
    if let Some(svc) = labels.get(COMPOSE_SERVICE) {
        return Some(Naming {
            source: svc.clone(),
            group: labels.get(COMPOSE_PROJECT).cloned(),
        });
    }
    Some(Naming {
        source: container_name.trim_start_matches('/').to_string(),
        group: None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum DockerStatus {
    Disabled,
    Connecting,
    Connected { containers: usize },
    Unavailable { error: String },
}

pub struct DockerReceiver {
    hub: Arc<Hub>,
    pub status: Arc<Mutex<DockerStatus>>,
    following: Arc<Mutex<HashSet<String>>>,
}

impl DockerReceiver {
    pub fn new(hub: Arc<Hub>) -> Self {
        DockerReceiver {
            hub,
            status: Arc::new(Mutex::new(DockerStatus::Connecting)),
            following: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Runs forever; reconnects every 5s if the socket goes away.
    pub async fn run(self) {
        loop {
            match self.session().await {
                Ok(()) => tracing::warn!("docker event stream ended; reconnecting"),
                Err(e) => {
                    tracing::warn!(error = %e, "docker unavailable");
                    *self.status.lock().unwrap() = DockerStatus::Unavailable {
                        error: e.to_string(),
                    };
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn session(&self) -> anyhow::Result<()> {
        let docker = Docker::connect_with_local_defaults()?;
        docker.ping().await?;

        // Subscribe to start events before listing so nothing slips between.
        let mut filters = HashMap::new();
        filters.insert("type".to_string(), vec!["container".to_string()]);
        filters.insert("event".to_string(), vec!["start".to_string()]);
        let mut events = docker.events(Some(EventsOptions::<String> {
            filters,
            ..Default::default()
        }));

        let running = docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: false,
                ..Default::default()
            }))
            .await?;
        for c in running {
            if let Some(id) = c.id {
                let name = c
                    .names
                    .and_then(|n| n.into_iter().next())
                    .unwrap_or_else(|| id[..12].to_string());
                // Attach with a short tail so the stream has context.
                self.follow(&docker, id, name, c.labels.unwrap_or_default(), Some(200));
            }
        }
        self.update_status();

        while let Some(ev) = events.next().await {
            let ev = ev?;
            let Some(actor) = ev.actor else { continue };
            let Some(id) = actor.id else { continue };
            let attrs = actor.attributes.unwrap_or_default();
            let name = attrs
                .get("name")
                .cloned()
                .unwrap_or_else(|| id.chars().take(12).collect());
            // `tail: None` = everything since it started, which is what we want for a fresh container.
            self.follow(&docker, id, name, attrs, None);
            self.update_status();
        }
        Ok(())
    }

    fn update_status(&self) {
        let n = self.following.lock().unwrap().len();
        *self.status.lock().unwrap() = DockerStatus::Connected { containers: n };
    }

    fn follow(
        &self,
        docker: &Docker,
        id: String,
        container_name: String,
        labels: HashMap<String, String>,
        tail: Option<u32>,
    ) {
        let Some(naming) = name_for(&container_name, &labels) else {
            return;
        };
        if !self.following.lock().unwrap().insert(id.clone()) {
            return;
        }
        let short = container_name.trim_start_matches('/').to_string();
        let source = self.hub.ensure_source(&naming.source, SourceKind::Docker);
        source.update_meta(|m| {
            if !m.containers.contains(&short) {
                m.containers.push(short.clone());
            }
            if m.group.is_none() {
                m.group = naming.group.clone();
            }
        });

        let docker = docker.clone();
        let hub = self.hub.clone();
        let following = self.following.clone();
        let status = self.status.clone();
        tokio::spawn(async move {
            tracing::info!(container = %short, source = %naming.source, "following");
            let opts = LogsOptions::<String> {
                follow: true,
                stdout: true,
                stderr: true,
                timestamps: true,
                tail: tail.map(|t| t.to_string()).unwrap_or_else(|| "all".into()),
                ..Default::default()
            };
            let mut stream = docker.logs(&id, Some(opts));
            let mut splitter = LineSplitter::default();
            while let Some(frame) = stream.next().await {
                let bytes = match frame {
                    Ok(LogOutput::StdOut { message })
                    | Ok(LogOutput::StdErr { message })
                    | Ok(LogOutput::Console { message }) => message,
                    Ok(LogOutput::StdIn { .. }) => continue,
                    Err(e) => {
                        tracing::debug!(error = %e, container = %short, "log stream error");
                        break;
                    }
                };
                for raw in splitter.push(&bytes) {
                    let received = Utc::now().timestamp_millis();
                    let (docker_ts, text) = split_docker_ts(&raw);
                    let line = normalize(text, &naming.source, docker_ts, received);
                    hub.publish(line, SourceKind::Docker);
                }
            }
            following.lock().unwrap().remove(&id);
            if let Some(s) = hub.source(&naming.source) {
                s.update_meta(|m| m.containers.retain(|c| c != &short));
            }
            let n = following.lock().unwrap().len();
            if let DockerStatus::Connected { .. } = *status.lock().unwrap() {
                *status.lock().unwrap() = DockerStatus::Connected { containers: n };
            }
            tracing::info!(container = %short, "stopped following");
        });
    }
}

/// Docker prefixes each line with an RFC3339Nano timestamp when `timestamps=1`.
pub fn split_docker_ts(line: &str) -> (Option<i64>, &str) {
    if let Some((head, rest)) = line.split_once(' ') {
        if let Ok(d) = DateTime::parse_from_rfc3339(head) {
            return (Some(d.with_timezone(&Utc).timestamp_millis()), rest);
        }
    }
    (None, line)
}

/// Docker frames don't always align with lines (long lines are split at 16KB,
/// TTY output arrives in arbitrary chunks). Reassemble on `\n`.
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
}

impl LineSplitter {
    const MAX: usize = 1 << 20; // 1 MiB; flush a runaway line rather than grow forever.

    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let s = String::from_utf8_lossy(&line[..line.len() - 1]);
            let s = s.trim_end_matches('\r');
            if !s.is_empty() {
                out.push(s.to_string());
            }
        }
        if self.buf.len() > Self::MAX {
            out.push(String::from_utf8_lossy(&self.buf).into_owned());
            self.buf.clear();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn naming_priority() {
        let n = name_for(
            "/shop_api.1.xyz",
            &labels(&[
                (SWARM_SERVICE, "shop_api"),
                (SWARM_STACK, "shop"),
                (COMPOSE_SERVICE, "x"),
            ]),
        )
        .unwrap();
        assert_eq!(
            n,
            Naming {
                source: "api".into(),
                group: Some("shop".into())
            }
        );

        let n = name_for(
            "/proj-worker-1",
            &labels(&[(COMPOSE_SERVICE, "worker"), (COMPOSE_PROJECT, "proj")]),
        )
        .unwrap();
        assert_eq!(n.source, "worker");
        assert_eq!(n.group.as_deref(), Some("proj"));

        assert_eq!(name_for("/redis", &labels(&[])).unwrap().source, "redis");
        assert_eq!(
            name_for("/x", &labels(&[(QUIET_SOURCE, "payments")]))
                .unwrap()
                .source,
            "payments"
        );
        assert!(name_for("/x", &labels(&[(QUIET_IGNORE, "true")])).is_none());
    }

    #[test]
    fn docker_timestamp_prefix() {
        let (ts, rest) = split_docker_ts("2026-10-22T08:00:00.123456789Z {\"a\":1}");
        assert_eq!(ts, Some(1_792_656_000_123));
        assert_eq!(rest, "{\"a\":1}");
        assert_eq!(split_docker_ts("no stamp here").0, None);
    }

    #[test]
    fn splitter_reassembles() {
        let mut s = LineSplitter::default();
        assert!(s.push(b"hel").is_empty());
        assert_eq!(s.push(b"lo\r\nwor"), vec!["hello"]);
        assert_eq!(s.push(b"ld\n\nnext\n"), vec!["world", "next"]);
    }
}
