mod api;
mod docker;
mod hub;
mod normalize;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

struct Config {
    addr: SocketAddr,
    docker: bool,
    ring: usize,
    web_dir: Option<PathBuf>,
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Ok(Config {
            // Loopback by default: there is no auth until the accounts slice lands.
            addr: var("QUIET_ADDR")
                .unwrap_or_else(|| "127.0.0.1:7070".into())
                .parse()?,
            docker: !matches!(var("QUIET_DOCKER").as_deref(), Some("0" | "false" | "off")),
            ring: var("QUIET_RING")
                .map(|v| v.parse())
                .transpose()?
                .unwrap_or(10_000),
            web_dir: var("QUIET_WEB_DIR")
                .map(PathBuf::from)
                .or_else(|| Some(PathBuf::from("web/dist")))
                .filter(|p| p.join("index.html").exists()),
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quiet=info,tower_http=warn".into()),
        )
        .init();
    let cfg = Config::from_env()?;

    let hub = hub::Hub::new(cfg.ring);
    let docker_status = if cfg.docker {
        let rx = docker::DockerReceiver::new(hub.clone());
        let status = rx.status.clone();
        tokio::spawn(rx.run());
        status
    } else {
        Arc::new(Mutex::new(docker::DockerStatus::Disabled))
    };

    let state = api::AppState {
        hub,
        docker: docker_status,
        started: chrono::Utc::now().timestamp_millis(),
    };
    let mut app = api::router(state);
    if let Some(dir) = &cfg.web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
        tracing::info!(dir = %dir.display(), "serving web ui");
    }

    let listener = tokio::net::TcpListener::bind(cfg.addr).await?;
    tracing::info!(addr = %cfg.addr, "quiet listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
