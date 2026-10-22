mod api;
mod cli;
mod hub;
mod normalize;
mod pipeline;
mod receiver;
mod server;
mod store;
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
        Some(cli::Command::Agent(_)) => {
            eprintln!(
                "quiet agent is not available until v0.2. Run `quiet server` on the host for now."
            );
            std::process::exit(2);
        }
    }
}
