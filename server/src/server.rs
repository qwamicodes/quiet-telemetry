//! `quiet server`: wire receivers → pipeline → store/hub → API + UI, and stop cleanly.
//!
//! Shutdown on SIGTERM/SIGINT: `/ready` flips to 503 → wait `drain_ms` →
//! stop accepting, close open streams (code 1012, the UI reconnects) and stop
//! receivers → give up after `shutdown_timeout_ms`.

use crate::accounts::Accounts;
use crate::api::{self, AppState, HostInfo};
use crate::auth::{AuthConfig, AuthMode};
use crate::cli::{ServerArgs, StoreKind};
use crate::hub::Hub;
use crate::pipeline::Pipeline;
use crate::receiver::{DockerReceiver, DockerStatus, HttpReceiver, IngestConfig, Receiver};
use crate::retention::{self, Retention};
use crate::store::{MemoryStore, SqliteOptions, SqliteStore, Store};
use crate::tokens::IngestTokens;
use crate::web;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::task::TaskTracker;

pub async fn run(args: ServerArgs) -> anyhow::Result<()> {
    if args.auth == AuthMode::Off && !args.addr.ip().is_loopback() {
        anyhow::bail!(
            "QUIET_AUTH=off only works on a loopback address (QUIET_ADDR={}): without sign-in \
             anyone who can reach quiet can read every log. Use 127.0.0.1, or keep auth on.",
            args.addr
        );
    }
    let store: Arc<dyn Store> = match args.store {
        StoreKind::Memory => Arc::new(MemoryStore::new(args.ring)),
        StoreKind::Sqlite => {
            let opts = SqliteOptions {
                path: args.data_dir.join("quiet.db"),
                ring: args.ring,
            };
            tracing::info!(path = %opts.path.display(), "opening sqlite store");
            Arc::new(tokio::task::spawn_blocking(move || SqliteStore::open(opts)).await??)
        }
    };
    let pipeline = Pipeline::new(store.clone(), Hub::new());
    pipeline.restore().await?;

    // Ingest tokens live next to the lines (same quiet.db), or in memory.
    let tokens_path = (args.store == StoreKind::Sqlite).then(|| args.data_dir.join("quiet.db"));
    let rate = args.ingest_rate;
    let ingest_tokens = Arc::new(
        tokio::task::spawn_blocking(move || IngestTokens::open(tokens_path.as_deref(), rate))
            .await??,
    );
    let ingest = IngestConfig {
        auth: args.ingest_auth,
        max_body: args.ingest_max_body,
        rate: args.ingest_rate,
        loopback: args.addr.ip().is_loopback(),
    };

    let mut receivers: Vec<Arc<dyn Receiver>> = vec![Arc::new(HttpReceiver::new(
        pipeline.clone(),
        ingest_tokens.clone(),
        ingest,
    ))];
    let docker_status = if args.docker {
        let docker = Arc::new(DockerReceiver::new(pipeline.clone()));
        let status = docker.status.clone();
        receivers.push(docker);
        status
    } else {
        Arc::new(Mutex::new(DockerStatus::Disabled))
    };

    // Accounts always live on disk (even with --store memory): forgetting them
    // on restart would offer owner setup to whoever arrives first.
    let accounts_path = args.data_dir.join("quiet.db");
    let accounts =
        Arc::new(tokio::task::spawn_blocking(move || Accounts::open(Some(&accounts_path))).await??);
    let auth = AuthConfig {
        mode: args.auth,
        cookie_secure: args.cookie_secure,
        trust_proxy: args.trust_proxy,
    };

    let retention_ms = args.retention.as_millis() as i64;
    let state = AppState::new(pipeline, docker_status)
        .with_retention(retention_ms)
        .with_ingest(ingest_tokens.clone(), ingest)
        .with_accounts(accounts.clone(), auth)
        .with_host(HostInfo {
            data_dir: Some(args.data_dir.clone()),
            max_disk: args.max_disk,
        });
    let shutdown = state.shutdown.clone();
    let ready = state.ready.clone();

    let tasks = TaskTracker::new();
    let mut app = api::router(state);
    for r in &receivers {
        app = app.merge(r.routes());
        let (r, token) = (r.clone(), shutdown.clone());
        tasks.spawn(async move {
            let name = r.name();
            if let Err(e) = r.run(token).await {
                tracing::error!(receiver = name, error = %e, "receiver stopped");
            }
        });
    }
    tasks.spawn(retention::run(
        store.clone(),
        Retention {
            window: args.retention,
            max_bytes: args.max_disk,
        },
        shutdown.clone(),
    ));
    tasks.close();
    let app = security_headers(web::attach(app, args.web_dir.clone()));

    let listener = tokio::net::TcpListener::bind(args.addr).await?;
    tracing::info!(
        addr = %args.addr,
        docker = args.docker,
        ring = args.ring,
        store = store.kind(),
        retention_h = args.retention.as_secs() / 3600,
        max_disk_mb = args.max_disk / 1_000_000,
        ingest_auth = ?args.ingest_auth,
        ingest_tokens = ingest_tokens.active(),
        auth = ?args.auth,
        "quiet listening"
    );
    if ingest.loopback {
        tracing::info!("listening on loopback only: shippers on other machines need QUIET_ADDR=0.0.0.0:7070 (ingest stays gated by qi_ tokens, the UI and /api by sign-in)");
    }
    match args.auth {
        AuthMode::Off => tracing::warn!(
            "QUIET_AUTH=off: no sign-in, every request acts as a local owner (development only)"
        ),
        AuthMode::On => {
            if accounts.setup_required().unwrap_or(false) {
                tracing::warn!("no owner yet: open the UI to create the owner account (first visitor becomes owner)");
            }
        }
    }
    if args.ingest_auth == crate::receiver::IngestAuth::Open {
        tracing::warn!("--ingest-auth open: HTTP ingest accepts lines without a token");
    }

    let drain = Duration::from_millis(args.drain_ms);
    let hard = Duration::from_millis(args.shutdown_timeout_ms);
    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let sig = wait_for_signal().await;
            tracing::info!(
                signal = sig,
                drain_ms = drain.as_millis() as u64,
                "shutting down: not ready"
            );
            ready.store(false, Ordering::Relaxed);
            tokio::time::sleep(drain).await;
            shutdown.cancel();
        });
    }

    // Peer addresses feed sign-in backoff and the sessions list.
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.clone().cancelled_owned());
    let deadline = async {
        shutdown.cancelled().await;
        tokio::time::sleep(hard).await;
    };
    tokio::select! {
        r = server => r?,
        _ = deadline => tracing::warn!("connections still open after timeout; exiting"),
    }
    if tokio::time::timeout(hard, tasks.wait()).await.is_err() {
        tracing::warn!("receivers still running after timeout; exiting");
    }
    if let Err(e) = ingest_tokens.flush() {
        tracing::warn!(error = %e, "saving ingest token last-used times failed");
    }
    if let Err(e) = store.flush().await {
        tracing::warn!(error = %e, "final flush failed");
    }
    tracing::info!("bye");
    Ok(())
}

/// Headers on every response: no framing (clickjacking on the sign-in page),
/// no sniffing, and no Referer leaving the origin (invite and reset links
/// carry their token in the path).
fn security_headers(app: axum::Router) -> axum::Router {
    use axum::http::{header, HeaderValue};
    use tower_http::set_header::SetResponseHeaderLayer;
    app.layer(SetResponseHeaderLayer::if_not_present(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    ))
    .layer(SetResponseHeaderLayer::if_not_present(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::if_not_present(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    ))
}

async fn wait_for_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = tokio::signal::ctrl_c() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "ctrl-c"
    }
}
