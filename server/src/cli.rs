//! Command line. `quiet` with no subcommand runs the server, so the old
//! env-only setup (`QUIET_ADDR=… quiet`) keeps working.

use crate::auth::{AuthMode, CookieSecure};
use crate::grouping::GroupMode;
use crate::receiver::IngestAuth;
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StoreKind {
    Sqlite,
    Memory,
}

#[derive(Debug, Parser)]
#[command(
    name = "quiet",
    version,
    about = "A calm, realtime canonical-log viewer",
    args_conflicts_with_subcommands = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[command(flatten)]
    pub server: ServerArgs,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the server: receivers, store, API and web UI (the default).
    Server(ServerArgs),
    /// Ship this host's container logs to a quiet server (v0.2).
    Agent(AgentArgs),
    /// Send stdin to a quiet server, one line per row: `my-app | quiet pipe --name my-app`.
    Pipe(PipeArgs),
    /// Account recovery on the host: `quiet admin reset-password <email>`.
    Admin(AdminArgs),
    /// Exit 0 when the local server answers /ready (for container healthchecks).
    #[command(hide = true)]
    Healthcheck(HealthcheckArgs),
}

#[derive(Debug, Clone, Args)]
pub struct HealthcheckArgs {
    /// The server's listen address; 0.0.0.0 is checked on loopback.
    #[arg(long, env = "QUIET_ADDR", default_value = "127.0.0.1:7070")]
    pub addr: SocketAddr,
}

#[derive(Debug, Clone, Args)]
pub struct AdminArgs {
    #[command(subcommand)]
    pub command: AdminCommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum AdminCommand {
    /// Print a one-time password-reset link for a user (valid for 1 hour).
    /// For a locked-out owner; owners can make links for members in Settings → Members.
    ResetPassword {
        /// The account's email.
        email: String,
        /// Directory holding `quiet.db` (the server's --data-dir).
        #[arg(long, env = "QUIET_DATA_DIR", default_value = "data")]
        data_dir: PathBuf,
        /// The address people open quiet at, to print a full link
        /// (e.g. https://quiet.example.com). Without it only the path is printed.
        #[arg(long, env = "QUIET_PUBLIC_URL")]
        url: Option<String>,
    },
}

#[derive(Debug, Clone, Args)]
pub struct ServerArgs {
    /// Listen address. Everything but /health, /ready and token-gated ingest
    /// needs a signed-in session, so 0.0.0.0 is fine behind TLS.
    #[arg(long, env = "QUIET_ADDR", default_value = "127.0.0.1:7070")]
    pub addr: SocketAddr,

    /// Sign-in: `on` (accounts, the default) or `off` (no sign-in, every
    /// request is a local owner; only allowed on a loopback address).
    #[arg(long, env = "QUIET_AUTH", value_enum, default_value_t = AuthMode::On)]
    pub auth: AuthMode,

    /// Session cookie `Secure` flag: `auto` (when the proxy says
    /// `X-Forwarded-Proto: https`), `on` or `off`.
    #[arg(long, env = "QUIET_COOKIE_SECURE", value_enum, default_value_t = CookieSecure::Auto)]
    pub cookie_secure: CookieSecure,

    /// Read the client address from `X-Forwarded-For` / `X-Real-IP` (sign-in
    /// backoff, session list). Turn on only behind a reverse proxy that sets them.
    #[arg(long, env = "QUIET_TRUST_PROXY", default_value = "off", value_parser = parse_switch, action = clap::ArgAction::Set)]
    pub trust_proxy: bool,

    /// Read container logs from the local Docker socket (on/off).
    #[arg(long, env = "QUIET_DOCKER", default_value = "on", value_parser = parse_switch, action = clap::ArgAction::Set)]
    pub docker: bool,

    /// Live lines kept in memory per source.
    #[arg(long, env = "QUIET_RING", default_value_t = 10_000)]
    pub ring: usize,

    /// Memory for those live lines, all sources together (estimated; e.g.
    /// `64MB`). Split evenly between sources; each drops its oldest lines
    /// when over its share. Keeps quiet inside a 256MB container limit.
    #[arg(long, env = "QUIET_RING_MEMORY", default_value = "64MB", value_parser = parse_ring_memory)]
    pub ring_memory: usize,

    /// Where lines are kept: `sqlite` (searchable window on disk) or `memory`
    /// (the live ring only, gone on restart).
    #[arg(long, env = "QUIET_STORE", value_enum, default_value_t = StoreKind::Sqlite)]
    pub store: StoreKind,

    /// Directory for the SQLite database (`quiet.db`). Mount a volume here.
    #[arg(long, env = "QUIET_DATA_DIR", default_value = "data")]
    pub data_dir: PathBuf,

    /// How long lines stay searchable: 1h … 7d (e.g. `24h`, `3d`, `7d`).
    /// Whole hours are dropped, so a line can outlive it by up to an hour.
    #[arg(long, env = "QUIET_RETENTION", default_value = "24h", value_parser = parse_retention)]
    pub retention: Duration,

    /// Disk cap for the database; the oldest hour goes first (e.g. `5GB`, `500MB`).
    #[arg(long, env = "QUIET_MAX_DISK", default_value = "5GB", value_parser = parse_bytes)]
    pub max_disk: u64,

    /// How sources are grouped in the UI: `auto` (quiet.group label, then
    /// Compose project, then Swarm stack), `label` (see --group-label) or `off`.
    /// When set it wins over Settings → General and locks that control.
    #[arg(long, env = "QUIET_GROUP_BY", value_enum)]
    pub group_by: Option<GroupMode>,

    /// The Docker label `--group-by label` reads (default `quiet.group`).
    /// When set it also locks the control.
    #[arg(long, env = "QUIET_GROUP_LABEL")]
    pub group_label: Option<String>,

    /// Serve the UI from this directory instead of the copy built into the binary.
    #[arg(long, env = "QUIET_WEB_DIR")]
    pub web_dir: Option<PathBuf>,

    /// On SIGTERM, how long /ready reports 503 before connections close (ms).
    #[arg(long, env = "QUIET_DRAIN_MS", default_value_t = 1_000)]
    pub drain_ms: u64,

    /// Hard limit for a graceful stop after the drain (ms).
    #[arg(long, env = "QUIET_SHUTDOWN_TIMEOUT_MS", default_value_t = 10_000)]
    pub shutdown_timeout_ms: u64,

    /// HTTP ingest auth: `token` (every request needs a `qi_` ingest token)
    /// or `open` (tokenless requests accepted; for local development).
    #[arg(long, env = "QUIET_INGEST_AUTH", value_enum, default_value_t = IngestAuth::Token)]
    pub ingest_auth: IngestAuth,

    /// Largest ingest body, after decompression (e.g. `16MB`, `512KB`).
    #[arg(long, env = "QUIET_INGEST_MAX_BODY", default_value = "16MB", value_parser = parse_body_size)]
    pub ingest_max_body: u64,

    /// Lines per second per ingest token, bursts of 5 s worth (0 = unlimited).
    #[arg(long, env = "QUIET_INGEST_RATE", default_value_t = 20_000)]
    pub ingest_rate: u32,
}

#[derive(Debug, Clone, Args)]
pub struct PipeArgs {
    /// Source name the lines land in.
    #[arg(long, short = 'n', env = "QUIET_SOURCE")]
    pub name: String,

    /// The quiet server (plain http; use curl or a shipper for https).
    #[arg(long, env = "QUIET_URL", default_value = "http://127.0.0.1:7070")]
    pub url: String,

    /// An ingest token (`qi_…`).
    #[arg(long, env = "QUIET_TOKEN", hide_env_values = true)]
    pub token: Option<String>,

    /// Don't echo stdin to stdout.
    #[arg(long, short = 's')]
    pub silent: bool,
}

#[derive(Debug, Clone, Args)]
pub struct AgentArgs {
    /// Accepted and ignored until the agent exists.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
    pub rest: Vec<String>,
}

/// `QUIET_DOCKER=0|false|off|no` disables; anything else enables (as in slice 1).
fn parse_switch(v: &str) -> Result<bool, String> {
    Ok(!matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    ))
}

/// `90m`, `24h`, `3d`, `1w` → a duration between one hour and seven days.
fn parse_retention(v: &str) -> Result<Duration, String> {
    let v = v.trim().to_ascii_lowercase();
    let split = v.find(|c: char| !c.is_ascii_digit()).unwrap_or(v.len());
    let (n, unit) = v.split_at(split);
    let n: u64 = n
        .parse()
        .map_err(|_| format!("`{v}`: expected e.g. 24h, 3d, 7d"))?;
    let secs = match unit {
        "m" | "min" => n * 60,
        "h" | "" => n * 3600,
        "d" => n * 86_400,
        "w" => n * 7 * 86_400,
        _ => return Err(format!("`{v}`: unit must be m, h, d or w")),
    };
    if !(3600..=7 * 86_400).contains(&secs) {
        return Err(format!("`{v}`: retention must be between 1h and 7d"));
    }
    Ok(Duration::from_secs(secs))
}

/// `5GB`, `500MB`, `1.5GiB`, `1048576` → bytes, at least 10MB (the disk cap).
fn parse_bytes(v: &str) -> Result<u64, String> {
    let bytes = bytes_of(v)?;
    if bytes < 10_000_000 {
        return Err(format!("`{v}`: the disk cap must be at least 10MB"));
    }
    Ok(bytes)
}

/// The ring memory budget: 1MB … 64GB.
fn parse_ring_memory(v: &str) -> Result<usize, String> {
    let bytes = bytes_of(v)?;
    if !(1_000_000..=64_000_000_000).contains(&bytes) {
        return Err(format!("`{v}`: ring memory must be between 1MB and 64GB"));
    }
    Ok(bytes as usize)
}

/// An ingest body cap: 1KB … 1GB.
fn parse_body_size(v: &str) -> Result<u64, String> {
    let bytes = bytes_of(v)?;
    if !(1_000..=1_000_000_000).contains(&bytes) {
        return Err(format!(
            "`{v}`: the ingest body cap must be between 1KB and 1GB"
        ));
    }
    Ok(bytes)
}

/// `5GB`, `500MB`, `1.5GiB`, `1048576` → bytes (KB/MB/GB/TB are powers of 1000).
fn bytes_of(v: &str) -> Result<u64, String> {
    let v = v.trim();
    let split = v
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(v.len());
    let (n, unit) = v.split_at(split);
    let n: f64 = n.parse().map_err(|_| format!("`{v}`: expected e.g. 5GB"))?;
    let mult: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "kb" | "k" => 1e3,
        "mb" | "m" => 1e6,
        "gb" | "g" => 1e9,
        "tb" | "t" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024f64.powi(2),
        "gib" => 1024f64.powi(3),
        "tib" => 1024f64.powi(4),
        u => return Err(format!("`{v}`: unknown unit `{u}`")),
    };
    Ok((n * mult) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn no_subcommand_runs_server_with_flags() {
        let cli =
            Cli::try_parse_from(["quiet", "--addr", "0.0.0.0:9000", "--docker", "off"]).unwrap();
        assert!(cli.command.is_none());
        assert_eq!(cli.server.addr.port(), 9000);
        assert!(!cli.server.docker);

        let cli = Cli::try_parse_from(["quiet", "server", "--ring", "5"]).unwrap();
        match cli.command {
            Some(Command::Server(a)) => assert_eq!(a.ring, 5),
            other => panic!("expected server, got {other:?}"),
        }
        let cli = Cli::try_parse_from(["quiet", "agent", "--server", "x"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Agent(_))));
    }

    #[test]
    fn storage_flags() {
        let cli = Cli::try_parse_from(["quiet"]).unwrap();
        assert_eq!(cli.server.store, StoreKind::Sqlite);
        assert_eq!(cli.server.retention, Duration::from_secs(86_400));
        assert_eq!(cli.server.max_disk, 5_000_000_000);
        assert_eq!(cli.server.group_by, None::<GroupMode>);
        assert_eq!(cli.server.group_label, None);
        assert_eq!(cli.server.ring_memory, 64_000_000);
        assert_eq!(parse_ring_memory("128MB"), Ok(128_000_000));
        assert!(parse_ring_memory("10KB").is_err());
        let cli = Cli::try_parse_from([
            "quiet",
            "--retention",
            "7d",
            "--max-disk",
            "500MB",
            "--store",
            "memory",
            "--data-dir",
            "/data",
        ])
        .unwrap();
        assert_eq!(cli.server.retention, Duration::from_secs(7 * 86_400));
        assert_eq!(cli.server.max_disk, 500_000_000);
        assert_eq!(cli.server.store, StoreKind::Memory);
        assert_eq!(parse_retention("3d"), Ok(Duration::from_secs(3 * 86_400)));
        assert_eq!(parse_bytes("1GiB"), Ok(1 << 30));
        assert!(parse_retention("30m").is_err());
        assert!(parse_retention("8d").is_err());
        assert!(parse_bytes("5XB").is_err());
        assert!(parse_bytes("1MB").is_err());
    }

    #[test]
    fn auth_flags_and_admin() {
        let cli = Cli::try_parse_from(["quiet"]).unwrap();
        assert_eq!(cli.server.auth, AuthMode::On);
        assert_eq!(cli.server.cookie_secure, CookieSecure::Auto);
        assert!(!cli.server.trust_proxy);
        let cli = Cli::try_parse_from([
            "quiet",
            "--auth",
            "off",
            "--cookie-secure",
            "on",
            "--trust-proxy",
            "on",
        ])
        .unwrap();
        assert_eq!(cli.server.auth, AuthMode::Off);
        assert_eq!(cli.server.cookie_secure, CookieSecure::On);
        assert!(cli.server.trust_proxy);
        let cli = Cli::try_parse_from([
            "quiet",
            "admin",
            "reset-password",
            "k@x.co",
            "--data-dir",
            "/data",
        ])
        .unwrap();
        match cli.command {
            Some(Command::Admin(AdminArgs {
                command:
                    AdminCommand::ResetPassword {
                        email, data_dir, ..
                    },
            })) => {
                assert_eq!(email, "k@x.co");
                assert_eq!(data_dir, PathBuf::from("/data"));
            }
            other => panic!("expected admin, got {other:?}"),
        }
    }

    #[test]
    fn ingest_flags_and_pipe() {
        let cli = Cli::try_parse_from(["quiet"]).unwrap();
        assert_eq!(cli.server.ingest_auth, IngestAuth::Token);
        assert_eq!(cli.server.ingest_max_body, 16_000_000);
        assert_eq!(cli.server.ingest_rate, 20_000);
        let cli = Cli::try_parse_from([
            "quiet",
            "--ingest-auth",
            "open",
            "--ingest-max-body",
            "512KB",
            "--ingest-rate",
            "0",
        ])
        .unwrap();
        assert_eq!(cli.server.ingest_auth, IngestAuth::Open);
        assert_eq!(cli.server.ingest_max_body, 512_000);
        assert!(parse_body_size("10").is_err());
        let cli = Cli::try_parse_from(["quiet", "pipe", "--name", "api", "-s"]).unwrap();
        match cli.command {
            Some(Command::Pipe(p)) => {
                assert_eq!(p.name, "api");
                assert!(p.silent);
                assert_eq!(p.url, "http://127.0.0.1:7070");
            }
            other => panic!("expected pipe, got {other:?}"),
        }
    }

    #[test]
    fn docker_switch_values() {
        for (v, want) in [
            ("0", false),
            ("off", false),
            ("FALSE", false),
            ("1", true),
            ("on", true),
        ] {
            assert_eq!(parse_switch(v), Ok(want), "{v}");
        }
    }
}
