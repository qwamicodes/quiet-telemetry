//! Command line. `quiet` with no subcommand runs the server, so the old
//! env-only setup (`QUIET_ADDR=… quiet`) keeps working.

use clap::{Args, Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;

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
pub struct ServerArgs {
    /// Listen address. Loopback until accounts land (slice 5).
    #[arg(long, env = "QUIET_ADDR", default_value = "127.0.0.1:7070")]
    pub addr: SocketAddr,

    /// Read container logs from the local Docker socket (on/off).
    #[arg(long, env = "QUIET_DOCKER", default_value = "on", value_parser = parse_switch, action = clap::ArgAction::Set)]
    pub docker: bool,

    /// Live lines kept in memory per source.
    #[arg(long, env = "QUIET_RING", default_value_t = 10_000)]
    pub ring: usize,

    /// Serve the UI from this directory instead of the copy built into the binary.
    #[arg(long, env = "QUIET_WEB_DIR")]
    pub web_dir: Option<PathBuf>,

    /// On SIGTERM, how long /ready reports 503 before connections close (ms).
    #[arg(long, env = "QUIET_DRAIN_MS", default_value_t = 1_000)]
    pub drain_ms: u64,

    /// Hard limit for a graceful stop after the drain (ms).
    #[arg(long, env = "QUIET_SHUTDOWN_TIMEOUT_MS", default_value_t = 10_000)]
    pub shutdown_timeout_ms: u64,
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
