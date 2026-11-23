//! Our queue-neutral adaptation of the author's wide-event pattern, not a queue SDK.
use crate::{finish, Completion, Config, Event};
use serde_json::{json, Value};
use std::{
    ops::AsyncFnOnce,
    sync::Arc,
    time::{Duration, Instant},
};

/// Copy actual queue-native identity, attempt numbering, timings and correlation here.
/// No inferred attempt index, parent, queue state or HTTP field is added by this adapter.
pub struct QueueFacts {
    pub metadata: Event,
}

#[derive(Clone, Copy, Default)]
pub enum QueueCompletion {
    #[default]
    Unknown,
    /// Supply only after the queue's own completion boundary, not handler return.
    Successful { after_retry: bool },
}

struct Attempt<'a> {
    event: &'a mut Event,
    owned: Event,
    config: Arc<Config>,
    started: Instant,
    execution: Option<Duration>,
    done: bool,
}

impl Attempt<'_> {
    fn finish(&mut self, returned: bool, evidence: QueueCompletion) {
        if self.done {
            return;
        }
        self.done = true;
        let mut event = std::mem::take(self.event);
        for key in [
            "timestamp",
            "level",
            "service",
            "env",
            "duration_ms",
            "method",
            "path",
            "status_code",
            "request",
            "response",
        ] {
            event.remove(key);
        }
        event.remove("request_id");
        event.extend(std::mem::take(&mut self.owned));
        // Even accidentally supplied queue metadata cannot introduce HTTP fields.
        for key in ["method", "path", "status_code", "request", "response"] {
            event.remove(key);
        }
        if !returned {
            event.entry("error").or_insert_with(|| json!({"name": if std::thread::panicking() { "HandlerPanic" } else { "LocalAttemptInterrupted" }, "message": "Local future dropped; queue completion unknown"}));
        }
        let success = returned && !event.contains_key("error");
        let recovery =
            success && matches!(evidence, QueueCompletion::Successful { after_retry: true });
        finish(
            event,
            self.execution.unwrap_or_else(|| self.started.elapsed()),
            Completion {
                successful: success,
                confirmed_retry_completion: recovery,
                context_available: true,
            },
            &self.config,
        );
    }
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        self.finish(false, QueueCompletion::Unknown);
    }
}

/// Execution time stops at handler return. Confirmation runs afterwards and may await
/// the real queue boundary. If that hook is unavailable, return Unknown, never guess.
/// The adapter must serialize native errors into JSON explicitly (including Display
/// message + useful custom fields), without Debug/opaque panic-payload fallbacks.
pub async fn wide_event_worker<T>(
    event: &mut Event,
    facts: QueueFacts,
    config: Arc<Config>,
    handler: impl AsyncFnOnce(&mut Event) -> Result<T, Value>,
    confirm: impl AsyncFnOnce(&Result<T, Value>) -> QueueCompletion,
) -> Result<T, Value> {
    for (key, value) in &config.deployment {
        event.entry(key.clone()).or_insert_with(|| value.clone());
    }
    event.extend(facts.metadata.clone());
    for key in ["method", "path", "status_code", "request", "response"] {
        event.remove(key);
    }
    let mut attempt = Attempt {
        event,
        owned: facts.metadata,
        config,
        started: Instant::now(),
        execution: None,
        done: false,
    };
    let result = handler(attempt.event).await;
    attempt.execution = Some(attempt.started.elapsed());
    if let Err(error) = &result {
        attempt
            .event
            .insert("error".into(), crate::bounded_error(error));
    }
    let evidence = confirm(&result).await;
    attempt.finish(true, evidence);
    result
}
