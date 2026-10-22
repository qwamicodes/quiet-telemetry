mod accounts;
mod admin;
mod api;
mod auth;
mod auth_api;
mod cli;
mod export;
mod flow;
mod flow_api;
mod hub;
mod idpolicy;
mod normalize;
mod pipe;
mod pipeline;
mod receiver;
mod retention;
mod search;
mod search_api;
mod server;
mod settings;
mod settings_api;
mod store;
mod stream_api;
mod system;
mod tokens;
mod tokens_api;
mod web;

#[cfg(test)]
mod bindings;

use clap::Parser;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = cli::Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quiet=info,tower_http=warn".into()),
        )
        .init();

    match cli.command {
        None => server::run(cli.server).await,
        Some(cli::Command::Server(args)) => server::run(args).await,
        Some(cli::Command::Pipe(args)) => std::process::exit(pipe::run(args)),
        Some(cli::Command::Admin(args)) => std::process::exit(admin::run(args)),
        Some(cli::Command::Healthcheck(args)) => {
            std::process::exit(if healthcheck(args.addr) { 0 } else { 1 })
        }
        Some(cli::Command::Agent(_)) => {
            eprintln!(
                "quiet agent is not available until v0.2. Run `quiet server` on the host for now."
            );
            std::process::exit(2);
        }
    }
}

/// GET /ready over a plain socket, so the image needs no curl/wget.
fn healthcheck(mut addr: std::net::SocketAddr) -> bool {
    use std::io::{Read, Write};
    use std::time::Duration;
    if addr.ip().is_unspecified() {
        addr.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
    }
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /ready HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 32];
    let n = s.read(&mut buf).unwrap_or(0);
    std::str::from_utf8(&buf[..n]).is_ok_and(|h| h.split(' ').nth(1) == Some("200"))
}
