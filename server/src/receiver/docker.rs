//! Docker receiver: follow every running container on the local socket.
//!
//! Source naming (decision d-sources, 2026-10-22):
//!   swarm service label → compose service label → container name.
//! Containers that share a name (replicas, restarts) merge into one source.

use super::Receiver;
use crate::hub::{GroupKind, SourceKind};
use crate::pipeline::{Pipeline, RawLine};
use async_trait::async_trait;
use bollard::container::{ListContainersOptions, LogOutput, LogsOptions};
use bollard::system::EventsOptions;
use bollard::Docker;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

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
    pub group_kind: GroupKind,
}

/// The container's group: Swarm stack, else Compose project, else standalone.
pub fn group_for(labels: &HashMap<String, String>) -> (Option<String>, GroupKind) {
    let label = |k: &str| labels.get(k).filter(|v| !v.is_empty()).cloned();
    if let Some(st) = label(SWARM_STACK) {
        return (Some(st), GroupKind::Stack);
    }
    if let Some(p) = label(COMPOSE_PROJECT) {
        return (Some(p), GroupKind::Compose);
    }
    (None, GroupKind::Standalone)
}

pub fn name_for(container_name: &str, labels: &HashMap<String, String>) -> Option<Naming> {
    if labels
        .get(QUIET_IGNORE)
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        return None;
    }
    let (group, group_kind) = group_for(labels);
    let naming = |source: String| Naming {
        source,
        group: group.clone(),
        group_kind,
    };
    if let Some(s) = labels.get(QUIET_SOURCE) {
        return Some(naming(s.clone()));
    }
    if let Some(svc) = labels.get(SWARM_SERVICE) {
        // Swarm names services "<stack>_<svc>"; show the short one.
        let short = match labels.get(SWARM_STACK) {
            Some(st) => svc
                .strip_prefix(&format!("{st}_"))
                .unwrap_or(svc)
                .to_string(),
            None => svc.clone(),
        };
        return Some(naming(short));
    }
    if let Some(svc) = labels.get(COMPOSE_SERVICE) {
        return Some(naming(svc.clone()));
    }
    Some(naming(container_name.trim_start_matches('/').to_string()))
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum DockerStatus {
    Disabled,
    Connecting,
    Connected { containers: usize },
    Unavailable { error: String },
}

pub struct DockerReceiver {
    pipeline: Arc<Pipeline>,
    pub status: Arc<Mutex<DockerStatus>>,
    following: Arc<Mutex<HashSet<String>>>,
}

#[async_trait]
impl Receiver for DockerReceiver {
    fn name(&self) -> &'static str {
        "docker"
    }

    /// Runs until shutdown; reconnects every 5s if the socket goes away.
    async fn run(self: Arc<Self>, shutdown: CancellationToken) -> anyhow::Result<()> {
        loop {
            let result = tokio::select! {
                r = self.session(&shutdown) => r,
                _ = shutdown.cancelled() => return Ok(()),
            };
            match result {
                Ok(()) => tracing::warn!("docker event stream ended; reconnecting"),
                Err(e) => {
                    tracing::warn!(error = %e, "docker unavailable");
                    *self.status.lock().unwrap() = DockerStatus::Unavailable {
                        error: e.to_string(),
                    };
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = shutdown.cancelled() => return Ok(()),
            }
        }
    }
}

/// Find the Docker engine the way the `docker` CLI would, so `make dev` works
/// on Docker Desktop, OrbStack, Colima, Rancher Desktop and rootless Docker
/// without extra setup. Order: `DOCKER_HOST`, the well-known socket paths,
/// then the current `docker context`.
fn connect() -> anyhow::Result<(Docker, String)> {
    if let Ok(host) = std::env::var("DOCKER_HOST") {
        if !host.is_empty() {
            return Ok((Docker::connect_with_defaults()?, host));
        }
    }
    #[cfg(windows)]
    {
        Ok((
            Docker::connect_with_local_defaults()?,
            "npipe:////./pipe/docker_engine".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        let candidates = socket_candidates(
            std::env::var("HOME").ok().as_deref(),
            std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        );
        let mut found = candidates
            .iter()
            .find(|p| std::path::Path::new(p.as_str()).exists())
            .cloned();
        if found.is_none() {
            found = context_socket();
        }
        match found {
            Some(path) => {
                let docker = Docker::connect_with_socket(
                    &path,
                    120,
                    bollard::API_DEFAULT_VERSION,
                )?;
                Ok((docker, format!("unix://{path}")))
            }
            None => anyhow::bail!(
                "no Docker socket found (tried {}). Is Docker running? Or set DOCKER_HOST, e.g. DOCKER_HOST=$(docker context inspect -f '{{{{.Endpoints.docker.Host}}}}')",
                candidates.join(", ")
            ),
        }
    }
}

/// Well-known engine sockets, most common first.
#[cfg(not(windows))]
fn socket_candidates(home: Option<&str>, xdg_runtime: Option<&str>) -> Vec<String> {
    let mut v = vec!["/var/run/docker.sock".to_string()];
    if let Some(h) = home {
        for rel in [
            ".docker/run/docker.sock",     // Docker Desktop (macOS)
            ".docker/desktop/docker.sock", // Docker Desktop (Linux)
            ".orbstack/run/docker.sock",   // OrbStack
            ".colima/default/docker.sock", // Colima
            ".colima/docker.sock",         // Colima (older)
            ".rd/docker.sock",             // Rancher Desktop
        ] {
            v.push(format!("{h}/{rel}"));
        }
    }
    if let Some(x) = xdg_runtime {
        v.push(format!("{x}/docker.sock")); // rootless Docker
    }
    v
}

/// The socket of the current `docker context`, if the CLI is installed.
#[cfg(not(windows))]
fn context_socket() -> Option<String> {
    let out = std::process::Command::new("docker")
        .args([
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ])
        .output()
        .ok()?;
    let host = String::from_utf8(out.stdout).ok()?;
    let path = host.trim().strip_prefix("unix://")?.to_string();
    std::path::Path::new(&path).exists().then_some(path)
}

impl DockerReceiver {
    pub fn new(pipeline: Arc<Pipeline>) -> Self {
        DockerReceiver {
            pipeline,
            status: Arc::new(Mutex::new(DockerStatus::Connecting)),
            following: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    async fn session(&self, shutdown: &CancellationToken) -> anyhow::Result<()> {
        let (docker, endpoint) = connect()?;
        docker
            .ping()
            .await
            .map_err(|e| anyhow::anyhow!("{endpoint}: {e}"))?;
        tracing::info!(%endpoint, "docker connected");

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
                self.follow(
                    &docker,
                    id,
                    name,
                    c.labels.unwrap_or_default(),
                    Some(200),
                    shutdown,
                );
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
            self.follow(&docker, id, name, attrs, None, shutdown);
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
        shutdown: &CancellationToken,
    ) {
        let Some(naming) = name_for(&container_name, &labels) else {
            return;
        };
        if !self.following.lock().unwrap().insert(id.clone()) {
            return;
        }
        let short = container_name.trim_start_matches('/').to_string();
        let source = self
            .pipeline
            .hub()
            .ensure_source(&naming.source, SourceKind::Docker);
        source.update_meta(|m| {
            if !m.containers.contains(&short) {
                m.containers.push(short.clone());
            }
            if m.group.is_none() {
                m.group = naming.group.clone();
                m.group_kind = Some(naming.group_kind);
            }
        });

        let docker = docker.clone();
        let pipeline = self.pipeline.clone();
        let shutdown = shutdown.clone();
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
            loop {
                let frame = tokio::select! {
                    f = stream.next() => match f { Some(f) => f, None => break },
                    _ = shutdown.cancelled() => break,
                };
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
                let received = Utc::now().timestamp_millis();
                let raws = splitter.push(&bytes).into_iter().map(|raw| {
                    let (docker_ts, text) = split_docker_ts(&raw);
                    RawLine {
                        text: text.to_string(),
                        source: naming.source.clone(),
                        collector_ts: docker_ts,
                        received,
                    }
                });
                if let Err(e) = pipeline.ingest(SourceKind::Docker, raws).await {
                    tracing::warn!(error = %e, container = %short, "dropping lines");
                }
            }
            following.lock().unwrap().remove(&id);
            if let Some(s) = pipeline.hub().source(&naming.source) {
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

    #[cfg(not(windows))]
    #[test]
    fn socket_candidates_cover_desktop_engines() {
        let v = socket_candidates(Some("/Users/k"), Some("/run/user/501"));
        assert_eq!(v[0], "/var/run/docker.sock");
        assert!(v.contains(&"/Users/k/.docker/run/docker.sock".to_string()));
        assert!(v.contains(&"/Users/k/.orbstack/run/docker.sock".to_string()));
        assert!(v.contains(&"/Users/k/.colima/default/docker.sock".to_string()));
        assert!(v.contains(&"/run/user/501/docker.sock".to_string()));
        assert_eq!(socket_candidates(None, None), vec!["/var/run/docker.sock"]);
    }

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
                group: Some("shop".into()),
                group_kind: GroupKind::Stack,
            }
        );

        let n = name_for(
            "/proj-worker-1",
            &labels(&[(COMPOSE_SERVICE, "worker"), (COMPOSE_PROJECT, "proj")]),
        )
        .unwrap();
        assert_eq!(n.source, "worker");
        assert_eq!(n.group.as_deref(), Some("proj"));
        assert_eq!(n.group_kind, GroupKind::Compose);

        let n = name_for("/redis", &labels(&[])).unwrap();
        assert_eq!(n.source, "redis");
        assert_eq!((n.group, n.group_kind), (None, GroupKind::Standalone));
        // A renamed container keeps its project.
        let n = name_for(
            "/x",
            &labels(&[(QUIET_SOURCE, "payments"), (COMPOSE_PROJECT, "shop")]),
        )
        .unwrap();
        assert_eq!(
            (n.source.as_str(), n.group_kind),
            ("payments", GroupKind::Compose)
        );
        // An empty label is no group.
        assert_eq!(
            group_for(&labels(&[(COMPOSE_PROJECT, "")])),
            (None, GroupKind::Standalone)
        );
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
