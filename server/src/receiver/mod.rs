//! Inputs. Every receiver feeds the same [`Pipeline`]; adding OTLP or the
//! remote agent (v0.2) is a new impl here, nothing else changes.
//!
//! - Pull receivers (Docker) do their work in [`Receiver::run`].
//! - Push receivers (HTTP NDJSON) mount endpoints via [`Receiver::routes`].

pub mod docker;
pub mod http;

use async_trait::async_trait;
use axum::Router;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub use docker::{DockerReceiver, DockerStatus};
pub use http::NdjsonReceiver;

#[async_trait]
pub trait Receiver: Send + Sync + 'static {
    /// Short stable name for logs.
    fn name(&self) -> &'static str;

    /// HTTP endpoints this receiver accepts lines on. Mounted at the root.
    fn routes(&self) -> Router {
        Router::new()
    }

    /// Long-running work. Return once `shutdown` is cancelled.
    async fn run(self: Arc<Self>, shutdown: CancellationToken) -> anyhow::Result<()> {
        shutdown.cancelled().await;
        Ok(())
    }
}
