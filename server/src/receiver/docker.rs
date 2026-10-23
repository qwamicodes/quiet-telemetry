//! Docker receiver: follow every running container on the local socket.
//!
//! Source identity (decision d-docker-identity, 2026-10-23; replaces
//! d-sources): every container is its own source, keyed by what stays the
//! same when it is recreated, so two `api` services in different projects
//! never share a source:
//!
//! - `quiet.source=<name>`: that name (give several containers the same one
//!   to merge them on purpose).
//! - Swarm task: the full service name (`<stack>_<svc>`), `.<slot>` for
//!   replicas after the first.
//! - Compose: `<project>.<service>`, `.<n>` for container numbers after 1.
//! - Anything else: the container name.
//!
//! The UI shows a friendly label instead (the service, with ` · <project>`
//! added only when another source shows the same service; see
//! [`Hub::list`](crate::hub::Hub::list)). Before this, sources were keyed by
//! the bare service name, which merged same-named services across projects;
//! [`plan_migration`] carries those old sources over once.

use super::Receiver;
use crate::hub::SourceKind;
use crate::pipeline::{Pipeline, RawLine};
use crate::settings::DockerIdentity;
use async_trait::async_trait;
use bollard::container::{ListContainersOptions, LogOutput, LogsOptions};
use bollard::system::EventsOptions;
use bollard::Docker;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

const SWARM_SERVICE: &str = "com.docker.swarm.service.name";
const SWARM_TASK: &str = "com.docker.swarm.task.name";
use crate::grouping::{COMPOSE_PROJECT, SWARM_STACK};
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_NUMBER: &str = "com.docker.compose.container-number";
/// Opt a container out: `quiet.ignore=true`. Rename: `quiet.source=name`.
const QUIET_IGNORE: &str = "quiet.ignore";
const QUIET_SOURCE: &str = "quiet.source";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Naming {
    /// The stable identity key (before aliases): see the module docs.
    pub source: String,
    /// What versions before d-docker-identity named it (the bare service).
    pub legacy: String,
    /// Friendly label: the service (or container) name, ` #n` for replicas.
    pub base: String,
    /// The Compose project or Swarm stack, added to `base` when two sources
    /// would show the same label.
    pub context: Option<String>,
    /// Named by `quiet.source`: merging is on purpose, never migrated.
    pub explicit: bool,
}

fn label<'a>(labels: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    labels.get(k).map(|v| v.trim()).filter(|v| !v.is_empty())
}

/// The replica number of a Swarm task (`<service>.<slot>.<task id>`); global
/// services (`<service>.<node id>.<task id>`) have none, and quiet only sees
/// one node, so they never collide.
fn swarm_slot(service: &str, task: Option<&str>) -> Option<u32> {
    let rest = task?.strip_prefix(service)?.strip_prefix('.')?;
    rest.split('.').next()?.parse().ok()
}

pub fn name_for(container_name: &str, labels: &HashMap<String, String>) -> Option<Naming> {
    if label(labels, QUIET_IGNORE) == Some("true") {
        return None;
    }
    let container = container_name.trim_start_matches('/').to_string();
    if let Some(s) = label(labels, QUIET_SOURCE) {
        return Some(Naming {
            source: s.to_string(),
            legacy: s.to_string(),
            base: s.to_string(),
            context: None,
            explicit: true,
        });
    }
    if let Some(svc) = label(labels, SWARM_SERVICE) {
        let stack = label(labels, SWARM_STACK);
        // Swarm names services "<stack>_<svc>"; show the short one.
        let short = stack
            .and_then(|st| svc.strip_prefix(&format!("{st}_")))
            .unwrap_or(svc)
            .to_string();
        let slot = swarm_slot(svc, label(labels, SWARM_TASK)).filter(|n| *n > 1);
        return Some(Naming {
            source: match slot {
                Some(n) => format!("{svc}.{n}"),
                None => svc.to_string(),
            },
            base: match slot {
                Some(n) => format!("{short} #{n}"),
                None => short.clone(),
            },
            legacy: short,
            context: stack.map(String::from),
            explicit: false,
        });
    }
    if let Some(svc) = label(labels, COMPOSE_SERVICE) {
        let project = label(labels, COMPOSE_PROJECT);
        let n = label(labels, COMPOSE_NUMBER)
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| *n > 1);
        let key = match project {
            Some(p) => format!("{p}.{svc}"),
            None => svc.to_string(),
        };
        return Some(Naming {
            source: match n {
                Some(n) => format!("{key}.{n}"),
                None => key,
            },
            base: match n {
                Some(n) => format!("{svc} #{n}"),
                None => svc.to_string(),
            },
            legacy: svc.to_string(),
            context: project.map(String::from),
            explicit: false,
        });
    }
    Some(Naming {
        source: container.clone(),
        legacy: container.clone(),
        base: container,
        context: None,
        explicit: false,
    })
}

/// The source name a container's lines land in: its identity key, or the
/// old source it took over in the migration. A key that an alias already
/// uses for another container (a plain container named like an old merged
/// service) gets `.container` so the two never share a source.
pub fn resolve(naming: &Naming, ident: &DockerIdentity) -> String {
    if let Some(name) = ident.aliases.get(&naming.source) {
        return name.clone();
    }
    if !naming.explicit && ident.aliases.values().any(|v| *v == naming.source) {
        return format!("{}.container", naming.source);
    }
    naming.source.clone()
}

/// What the one-time migration from service-name sources does.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Migration {
    /// Identity key → old source it keeps writing to (the old source had
    /// exactly one running container, so its lines, settings, custom group,
    /// mutes and search name carry on unchanged).
    pub aliases: BTreeMap<String, String>,
    /// Old merged source → the keys it splits into. Each new source inherits
    /// the old one's settings (except its display name) and custom group;
    /// the old source keeps its lines until they age out.
    pub split: BTreeMap<String, Vec<String>>,
}

/// Plan the migration from the running containers' namings and the docker
/// sources already stored. Pure, so the collision cases are unit-tested.
pub fn plan_migration(namings: &[Naming], stored: &HashSet<String>) -> Migration {
    let mut by_legacy: BTreeMap<&str, Vec<&Naming>> = BTreeMap::new();
    // `quiet.source` containers resolve to their old name, so they keep it.
    for n in namings {
        by_legacy.entry(n.legacy.as_str()).or_default().push(n);
    }
    let mut m = Migration::default();
    for (legacy, members) in by_legacy {
        if !stored.contains(legacy) {
            continue;
        }
        // A container that still resolves to the old name keeps it as is.
        let keeps = members.iter().any(|n| n.source == legacy);
        let movers: Vec<String> = {
            let mut v: Vec<String> = members
                .iter()
                .filter(|n| n.source != legacy)
                .map(|n| n.source.clone())
                .collect();
            v.sort();
            v.dedup();
            v
        };
        if movers.is_empty() {
            continue;
        }
        if !keeps && movers.len() == 1 && !stored.contains(&movers[0]) {
            m.aliases.insert(movers[0].clone(), legacy.to_string());
        } else {
            m.split.insert(legacy.to_string(), movers);
        }
    }
    m
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
        let running: Vec<(String, String, HashMap<String, String>)> = running
            .into_iter()
            .filter_map(|c| {
                let id = c.id?;
                let name = c
                    .names
                    .and_then(|n| n.into_iter().next())
                    .unwrap_or_else(|| id.chars().take(12).collect());
                Some((id, name, c.labels.unwrap_or_default()))
            })
            .collect();
        self.migrate(&running);
        for (id, name, labels) in running {
            // Attach with a short tail so the stream has context.
            let opts = logs_options(ATTACH_TAIL, None);
            self.follow(&docker, id, name, labels, opts, shutdown);
        }
        self.update_status();

        while let Some(ev) = events.next().await {
            let ev = ev?;
            let since = event_since(ev.time, ev.time_nano);
            let Some(actor) = ev.actor else { continue };
            let Some(id) = actor.id else { continue };
            let attrs = actor.attributes.unwrap_or_default();
            let name = attrs
                .get("name")
                .cloned()
                .unwrap_or_else(|| id.chars().take(12).collect());
            // Only this run's lines. A restarted container (same id, json-file
            // log kept) would otherwise replay its whole history on every
            // restart; a fresh one still gets everything from its start.
            let opts = logs_options(RESTART_TAIL_CAP, since);
            self.follow(&docker, id, name, attrs, opts, shutdown);
            self.update_status();
        }
        Ok(())
    }

    fn update_status(&self) {
        let n = self.following.lock().unwrap().len();
        *self.status.lock().unwrap() = DockerStatus::Connected { containers: n };
    }

    /// Once per data directory: carry sources named by the bare service
    /// (before d-docker-identity) over to per-container identities. An old
    /// source with one running container keeps being written to (alias); an
    /// old merged one keeps its lines and hands its settings and custom group
    /// to each container it splits into. Runs on the first connect only, so
    /// a container that is stopped then keeps its new identity when it starts.
    fn migrate(&self, running: &[(String, String, HashMap<String, String>)]) {
        let settings = self.pipeline.settings();
        if settings.docker_identity().migrated {
            return;
        }
        let namings: Vec<Naming> = running
            .iter()
            .filter_map(|(_, name, labels)| name_for(name, labels))
            .collect();
        let hub = self.pipeline.hub();
        let stored: HashSet<String> = hub
            .labels()
            .into_iter()
            .filter(|(_, kind, _)| *kind == SourceKind::Docker)
            .map(|(name, _, _)| name)
            .collect();
        let plan = plan_migration(&namings, &stored);
        for old in plan.split.keys() {
            if let Some(src) = hub.source(old) {
                src.update_meta(|m| {
                    m.label_base = Some(format!("{old} (merged, before the split)"));
                });
            }
        }
        match settings.finish_docker_migration(plan.aliases.clone(), &plan.split) {
            Ok(_) => tracing::info!(
                kept = plan.aliases.len(),
                split = plan.split.len(),
                "docker sources now one per container"
            ),
            Err(e) => tracing::warn!(error = ?e, "docker source migration not saved"),
        }
    }

    fn follow(
        &self,
        docker: &Docker,
        id: String,
        container_name: String,
        labels: HashMap<String, String>,
        opts: LogsOptions<String>,
        shutdown: &CancellationToken,
    ) {
        let Some(naming) = name_for(&container_name, &labels) else {
            return;
        };
        if !self.following.lock().unwrap().insert(id.clone()) {
            return;
        }
        let source_name = resolve(&naming, &self.pipeline.settings().docker_identity());
        let short = container_name.trim_start_matches('/').to_string();
        let source = self
            .pipeline
            .hub()
            .ensure_source(&source_name, SourceKind::Docker);
        source.update_meta(|m| {
            if !m.containers.contains(&short) {
                m.containers.push(short.clone());
            }
            // One container per source, so its latest labels decide the
            // group; sources merged on purpose (`quiet.source`) keep the
            // first container's.
            if m.labels.is_empty() || !naming.explicit {
                m.labels = labels.clone();
            }
            m.label_base = Some(naming.base.clone());
            m.label_context = naming.context.clone();
        });
        let naming = Naming {
            source: source_name,
            ..naming
        };

        let docker = docker.clone();
        let pipeline = self.pipeline.clone();
        let shutdown = shutdown.clone();
        let following = self.following.clone();
        let status = self.status.clone();
        tokio::spawn(async move {
            tracing::info!(container = %short, source = %naming.source, "following");
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
            // One guard: the `if let` scrutinee's guard lives through the block,
            // so locking again inside it self-deadlocked the std Mutex whenever a
            // followed container stopped, wedging a runtime worker (and then
            // every reader of `status`) until quiet stopped answering /ready.
            {
                let mut st = status.lock().unwrap();
                if let DockerStatus::Connected { .. } = *st {
                    *st = DockerStatus::Connected { containers: n };
                }
            }
            tracing::info!(container = %short, "stopped following");
        });
    }
}

/// Lines read when attaching to a container that was already running.
pub const ATTACH_TAIL: u32 = 200;
/// Safety cap on lines read when a container (re)starts. With `since` set to
/// the start event this is only hit by a run that logs this much in its first
/// moments; it keeps a bad `since` from ever replaying a whole log.
pub const RESTART_TAIL_CAP: u32 = 1000;
/// Read from a little before the start event, so the first lines of the run
/// are not lost to the event being stamped after them.
const SINCE_SLACK_SECS: i64 = 1;

/// Unix seconds to read a started container's logs from: the start event's
/// time (nanosecond stamp when present) minus a little slack. `None` when
/// the event carries no time; the tail cap still bounds the read then.
pub fn event_since(time: Option<i64>, time_nano: Option<i64>) -> Option<i64> {
    let secs = match (time_nano, time) {
        (Some(n), _) if n > 0 => n / 1_000_000_000,
        (_, Some(t)) if t > 0 => t,
        _ => return None,
    };
    Some((secs - SINCE_SLACK_SECS).max(1))
}

/// Follow options for one container. The tail is always a number: `"all"`
/// replays a container's entire log, which on a restart loop re-ingested
/// months of history on every restart.
pub fn logs_options(tail: u32, since: Option<i64>) -> LogsOptions<String> {
    LogsOptions::<String> {
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        since: since.unwrap_or(0),
        tail: tail.to_string(),
        ..Default::default()
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

    fn compose(project: &str, svc: &str, n: &str) -> HashMap<String, String> {
        labels(&[
            (COMPOSE_PROJECT, project),
            (COMPOSE_SERVICE, svc),
            (COMPOSE_NUMBER, n),
        ])
    }

    #[test]
    fn naming_priority() {
        let n = name_for(
            "/shop_api.1.xyz",
            &labels(&[
                (SWARM_SERVICE, "shop_api"),
                (SWARM_STACK, "shop"),
                (SWARM_TASK, "shop_api.1.xyz"),
                (COMPOSE_SERVICE, "x"),
            ]),
        )
        .unwrap();
        assert_eq!(
            n,
            Naming {
                source: "shop_api".into(),
                legacy: "api".into(),
                base: "api".into(),
                context: Some("shop".into()),
                explicit: false,
            }
        );

        let n = name_for("/proj-worker-1", &compose("proj", "worker", "1")).unwrap();
        assert_eq!(
            (n.source.as_str(), n.base.as_str(), n.legacy.as_str()),
            ("proj.worker", "worker", "worker")
        );
        assert_eq!(n.context.as_deref(), Some("proj"));
        let n = name_for("/redis", &labels(&[])).unwrap();
        assert_eq!((n.source.as_str(), n.base.as_str()), ("redis", "redis"));
        let n = name_for("/x", &labels(&[(QUIET_SOURCE, "payments")])).unwrap();
        assert_eq!(n.source, "payments");
        assert!(n.explicit);
        assert!(name_for("/x", &labels(&[(QUIET_IGNORE, "true")])).is_none());
        // Compose without a project label (old engines): the service.
        assert_eq!(
            name_for("/w", &labels(&[(COMPOSE_SERVICE, "worker")]))
                .unwrap()
                .source,
            "worker"
        );
    }

    /// Parnion: Results Checker Hub prod + staging, two Voltx envs and
    /// Outline all run `postgres`/`redis`/`api`; each is its own source.
    #[test]
    fn same_service_in_different_projects_never_shares_a_source() {
        let cases = [
            (
                "/rch-production-postgres",
                compose("rch-infra-b2k5vv", "postgres", "1"),
            ),
            (
                "/rch-staging-postgres",
                compose("rch-infra-fy7d7a", "postgres", "1"),
            ),
            (
                "/outline-postgres-1",
                compose("outline-d63yzb", "postgres", "1"),
            ),
            (
                "/rch-production-api",
                compose("rch-apps-jz0tgd", "api", "1"),
            ),
            ("/rch-staging-api", compose("rch-apps-2wbbnm", "api", "1")),
        ];
        let keys: HashSet<String> = cases
            .iter()
            .map(|(n, l)| name_for(n, l).unwrap().source)
            .collect();
        assert_eq!(keys.len(), cases.len(), "{keys:?}");
        assert!(keys.contains("rch-infra-b2k5vv.postgres"));
        // Swarm stacks: `shop_api` and `blog_api` both show `api`.
        let swarm = |svc: &str, stack: &str, task: &str| {
            name_for(
                task,
                &labels(&[
                    (SWARM_SERVICE, svc),
                    (SWARM_STACK, stack),
                    (SWARM_TASK, task),
                ]),
            )
            .unwrap()
        };
        let a = swarm("shop_api", "shop", "shop_api.1.aaa");
        let b = swarm("blog_api", "blog", "blog_api.1.bbb");
        assert_ne!(a.source, b.source);
        assert_eq!((a.base.as_str(), b.base.as_str()), ("api", "api"));
    }

    #[test]
    fn replicas_and_recreated_containers() {
        // Compose: number 1 keeps the plain key, later numbers get `.n`.
        let one = name_for("/p-worker-1", &compose("p", "worker", "1")).unwrap();
        let two = name_for("/p-worker-2", &compose("p", "worker", "2")).unwrap();
        assert_eq!(
            (one.source.as_str(), two.source.as_str()),
            ("p.worker", "p.worker.2")
        );
        assert_eq!(two.base, "worker #2");
        // Recreated (new id, same labels): same source.
        assert_eq!(
            name_for("/p-worker-1", &compose("p", "worker", "1"))
                .unwrap()
                .source,
            one.source
        );
        // Swarm: the task id changes on every deploy, the slot doesn't.
        let task = |t: &str| {
            name_for(
                t,
                &labels(&[
                    (SWARM_SERVICE, "shop_api"),
                    (SWARM_STACK, "shop"),
                    (SWARM_TASK, t),
                ]),
            )
            .unwrap()
            .source
        };
        assert_eq!(task("shop_api.1.old"), task("shop_api.1.new"));
        assert_eq!(task("shop_api.3.x"), "shop_api.3");
        // Global service (node id, not a slot): no suffix.
        assert_eq!(task("shop_api.k2j3h4.x"), "shop_api");
        assert_eq!(swarm_slot("a", Some("a.2.x")), Some(2));
        assert_eq!(swarm_slot("a", Some("ab.2.x")), None);
        assert_eq!(swarm_slot("a", None), None);
    }

    #[test]
    fn migration_keeps_unique_sources_and_splits_merged_ones() {
        let n = |name: &str, l: HashMap<String, String>| name_for(name, &l).unwrap();
        let running = vec![
            // `postgres` was merged across three projects.
            n("/a", compose("rch-prod", "postgres", "1")),
            n("/b", compose("rch-staging", "postgres", "1")),
            n("/c", compose("outline", "postgres", "1")),
            // `db` only ever had one container: it keeps the old source.
            n("/d", compose("affine", "db", "1")),
            // A plain container still called `redis` keeps it; the compose
            // `redis` next to it splits off.
            n("/redis", labels(&[])),
            n("/e", compose("outline", "redis", "1")),
            // Swarm app without a stack: same name as before, nothing to do.
            n(
                "/dokploy.1.x",
                labels(&[(SWARM_SERVICE, "dokploy"), (SWARM_TASK, "dokploy.1.x")]),
            ),
            // Merged on purpose with `quiet.source`: an `api` in a project
            // must not be aliased into it.
            n("/f", labels(&[(QUIET_SOURCE, "api")])),
            n("/g", compose("rch-prod", "api", "1")),
            // Never stored before (a new project): nothing to migrate.
            n("/h", compose("new", "web", "1")),
        ];
        let stored: HashSet<String> = ["postgres", "db", "redis", "dokploy", "api", "cli"]
            .into_iter()
            .map(String::from)
            .collect();
        let m = plan_migration(&running, &stored);
        assert_eq!(
            m.aliases,
            [("affine.db".to_string(), "db".to_string())].into()
        );
        assert_eq!(
            m.split.get("postgres").unwrap(),
            &vec![
                "outline.postgres".to_string(),
                "rch-prod.postgres".to_string(),
                "rch-staging.postgres".to_string()
            ]
        );
        assert_eq!(
            m.split.get("redis").unwrap(),
            &vec!["outline.redis".to_string()]
        );
        assert_eq!(
            m.split.get("api").unwrap(),
            &vec!["rch-prod.api".to_string()]
        );
        assert_eq!(m.split.len(), 3, "{m:?}");

        // Resolving: the alias wins; everyone else gets their own key.
        let ident = DockerIdentity {
            migrated: true,
            aliases: m.aliases.clone(),
        };
        assert_eq!(resolve(&running[3], &ident), "db");
        assert_eq!(resolve(&running[0], &ident), "rch-prod.postgres");
        // A plain container later named like an aliased source stays apart.
        let late = n("/db", labels(&[]));
        assert_eq!(resolve(&late, &ident), "db.container");
        assert_eq!(resolve(&running[7], &ident), "api");
    }

    #[test]
    fn attach_reads_a_short_tail() {
        let o = logs_options(ATTACH_TAIL, None);
        assert_eq!(o.tail, "200");
        assert_eq!(o.since, 0);
        assert!(o.follow && o.stdout && o.stderr && o.timestamps);
    }

    #[test]
    fn restart_reads_only_this_run_capped() {
        // A start event at 2026-10-23T09:00:00.5Z.
        let nano = 1_792_746_000_500_000_000_i64;
        let since = event_since(Some(1_792_746_000), Some(nano));
        assert_eq!(since, Some(1_792_746_000 - 1));
        let o = logs_options(RESTART_TAIL_CAP, since);
        assert_eq!(o.since, 1_792_746_000 - 1);
        assert_eq!(o.tail, "1000");
        assert_ne!(o.tail, "all");
        assert!(o.follow && o.timestamps);
    }

    #[test]
    fn event_since_falls_back_and_never_reads_all() {
        assert_eq!(event_since(Some(100), None), Some(99));
        assert_eq!(event_since(None, Some(0)), None);
        assert_eq!(event_since(None, None), None);
        // No event time: no since filter, but the tail stays capped.
        let o = logs_options(RESTART_TAIL_CAP, event_since(None, None));
        assert_eq!(o.since, 0);
        assert_eq!(o.tail, "1000");
        for t in [0, ATTACH_TAIL, RESTART_TAIL_CAP, u32::MAX] {
            assert_ne!(logs_options(t, None).tail, "all");
        }
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
