//! The hourly drop job: expire hours older than the retention window, then
//! drop the oldest hours while the database is over its disk cap. Whichever
//! hits first wins. Runs at startup and once a minute (cheap when there is
//! nothing to drop; an hour boundary is never more than a minute late).
//!
//! The window and the cap are read from [`Settings`] on every pass (UI value,
//! else flag, else default), and a settings change wakes the job at once, so
//! a shorter window or a lower cap applies within seconds. Sources with a
//! shorter window of their own lose their older lines line by line.

use crate::settings::Settings;
use crate::store::Store;
use crate::system::SystemState;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub window: Duration,
    pub max_bytes: u64,
    /// Skip window (and per-source window) expiry this pass; the cap still runs.
    pub hold_window: bool,
}

impl Retention {
    /// What the settings say now.
    pub fn of(settings: &Settings) -> Self {
        let st = settings.storage();
        Retention {
            window: Duration::from_millis(st.retention_ms as u64),
            max_bytes: st.max_disk,
            hold_window: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Swept {
    pub expired: u64,
    /// Lines dropped from sources with a shorter window of their own.
    pub per_source: u64,
    pub capped: u64,
}

/// One pass at `now` (unix ms): the window, then per-source windows, then the cap.
pub async fn sweep(
    store: &dyn Store,
    r: Retention,
    sources: &[(String, i64)],
    now: i64,
) -> anyhow::Result<Swept> {
    let cutoff = now - r.window.as_millis() as i64;
    let mut expired = 0;
    let mut per_source = 0;
    if !r.hold_window {
        expired = store.expire(cutoff).await?;
        for (name, window) in sources {
            per_source += store.expire_source(name, now - window).await?;
        }
    }
    let capped = store.enforce_cap(r.max_bytes).await?;
    Ok(Swept {
        expired,
        per_source,
        capped,
    })
}

const EVERY: Duration = Duration::from_secs(60);

pub async fn run(
    store: Arc<dyn Store>,
    settings: Arc<Settings>,
    system: Arc<SystemState>,
    hold: Arc<AtomicUsize>,
    shutdown: CancellationToken,
) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = settings.changed.notified() => {}
            _ = shutdown.cancelled() => return,
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut r = Retention::of(&settings);
        // An export being prepared on the server (05.7) includes lines that
        // expire meanwhile: the window waits, the disk cap does not.
        if hold.load(Ordering::SeqCst) > 0 {
            r.hold_window = true;
        }
        match sweep(store.as_ref(), r, &settings.source_windows(), now).await {
            Ok(s) => {
                system.swept(now, s.capped);
                if s != Swept::default() {
                    tracing::info!(
                        expired = s.expired,
                        per_source = s.per_source,
                        capped = s.capped,
                        window_h = r.window.as_secs() / 3600,
                        max_disk_mb = r.max_bytes / 1_000_000,
                        "retention dropped old lines"
                    )
                }
            }
            Err(e) => tracing::warn!(error = %e, "retention sweep failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::SourceKind;
    use crate::normalize::normalize;
    use crate::store::{SqliteOptions, SqliteStore};

    #[tokio::test]
    async fn sweep_expires_by_window_then_caps() {
        let dir = std::env::temp_dir().join(format!("quiet-ret-{}", rand::random::<u32>()));
        let store = SqliteStore::open(SqliteOptions {
            path: dir.join("quiet.db"),
            ring: 10,
            ring_memory: crate::store::DEFAULT_RING_MEMORY,
        })
        .unwrap();
        const H: i64 = 3_600_000;
        let now = 1_792_000_000_000 / H * H + 30 * 60_000; // half past an hour
        let lines: Vec<_> = (0..30i64)
            .map(|i| {
                // one line per hour, 0 … 29 hours old
                let mut l = normalize(&format!("line {i}"), "api", None, now - i * H);
                l.id = (30 - i) as u64;
                Arc::new(l)
            })
            .collect();
        store.append(SourceKind::Http, &lines).await.unwrap();
        store.flush().await.unwrap();

        let r = Retention {
            window: Duration::from_secs(24 * 3600),
            max_bytes: u64::MAX,
            hold_window: false,
        };
        // While an export is being prepared the window waits (05.7).
        let held = Retention {
            hold_window: true,
            ..r
        };
        assert_eq!(
            sweep(&store, held, &[], now).await.unwrap(),
            Swept::default()
        );
        assert_eq!(store.usage().await.unwrap().lines, 30);
        // 24h back from half past lands mid-hour: hours 25…29 old are wholly
        // older (5 lines), the hour holding the 24h-old line survives.
        let s = sweep(&store, r, &[], now).await.unwrap();
        assert_eq!(
            s,
            Swept {
                expired: 5,
                ..Default::default()
            }
        );
        assert_eq!(store.usage().await.unwrap().lines, 25);

        let s = sweep(&store, Retention { max_bytes: 1, ..r }, &[], now)
            .await
            .unwrap();
        assert_eq!(
            s,
            Swept {
                capped: 24,
                ..Default::default()
            }
        );
        assert_eq!(store.usage().await.unwrap().lines, 1);
    }

    /// The running job reads the settings live: lowering the window in the
    /// UI wakes it and old hours go without waiting for the next minute.
    #[tokio::test]
    async fn job_reads_live_settings_and_per_source_windows() {
        let dir = std::env::temp_dir().join(format!("quiet-ret-{}", rand::random::<u32>()));
        let store: Arc<dyn Store> = Arc::new(
            SqliteStore::open(SqliteOptions {
                path: dir.join("quiet.db"),
                ring: 100,
                ring_memory: crate::store::DEFAULT_RING_MEMORY,
            })
            .unwrap(),
        );
        const H: i64 = 3_600_000;
        let now = chrono::Utc::now().timestamp_millis();
        let mut lines = Vec::new();
        for (i, (src, age)) in [
            ("api", 30),
            ("api", 2),
            ("api", 0),
            ("worker", 2),
            ("worker", 0),
        ]
        .iter()
        .enumerate()
        {
            let mut l = normalize(&format!("{src} {age}h"), src, None, now - age * H);
            l.id = i as u64 + 1;
            lines.push(Arc::new(l));
        }
        store.append(SourceKind::Http, &lines).await.unwrap();
        store.flush().await.unwrap();

        let settings = Arc::new(crate::settings::Settings::memory());
        let system = Arc::new(SystemState::default());
        let shutdown = CancellationToken::new();
        let job = tokio::spawn(run(
            store.clone(),
            settings.clone(),
            system.clone(),
            Arc::new(AtomicUsize::new(0)),
            shutdown.clone(),
        ));
        // First tick is immediate: the 30h-old line goes (default 24h).
        let wait_for = |n: u64| {
            let store = store.clone();
            async move {
                for _ in 0..100 {
                    if store.usage().await.unwrap().lines == n {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                false
            }
        };
        assert!(wait_for(4).await);

        // worker keeps 1h only: its 2h-old line goes once the job wakes.
        settings
            .put_source(
                "worker",
                crate::settings::SourceSettings {
                    retention_ms: Some(H),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert!(wait_for(3).await, "per-source window applied");
        // The instance window drops to 1h: api's 2h-old line goes too.
        settings
            .put_storage(
                crate::settings::UpdateStorage {
                    retention_ms: Some(Some(H)),
                    max_disk: None,
                },
                None,
            )
            .unwrap();
        assert!(wait_for(2).await, "live window applied");
        shutdown.cancel();
        job.await.unwrap();
    }
}
