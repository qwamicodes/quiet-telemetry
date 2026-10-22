//! The hourly drop job: expire hours older than the retention window, then
//! drop the oldest hours while the database is over its disk cap. Whichever
//! hits first wins. Runs at startup and once a minute (cheap when there is
//! nothing to drop; an hour boundary is never more than a minute late).
//! Settings UI for both lands in slice 6; until then they are flags.

use crate::store::Store;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub window: Duration,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Swept {
    pub expired: u64,
    pub capped: u64,
}

/// One pass at `now` (unix ms).
pub async fn sweep(store: &dyn Store, r: Retention, now: i64) -> anyhow::Result<Swept> {
    let cutoff = now - r.window.as_millis() as i64;
    let expired = store.expire(cutoff).await?;
    let capped = store.enforce_cap(r.max_bytes).await?;
    Ok(Swept { expired, capped })
}

const EVERY: Duration = Duration::from_secs(60);

pub async fn run(store: Arc<dyn Store>, r: Retention, shutdown: CancellationToken) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = shutdown.cancelled() => return,
        }
        let now = chrono::Utc::now().timestamp_millis();
        match sweep(store.as_ref(), r, now).await {
            Ok(s) if s != Swept::default() => {
                tracing::info!(
                    expired = s.expired,
                    capped = s.capped,
                    "retention dropped old hours"
                )
            }
            Ok(_) => {}
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
        };
        // 24h back from half past lands mid-hour: hours 25…29 old are wholly
        // older (5 lines), the hour holding the 24h-old line survives.
        let s = sweep(&store, r, now).await.unwrap();
        assert_eq!(
            s,
            Swept {
                expired: 5,
                capped: 0
            }
        );
        assert_eq!(store.usage().await.unwrap().lines, 25);

        let s = sweep(&store, Retention { max_bytes: 1, ..r }, now)
            .await
            .unwrap();
        assert_eq!(
            s,
            Swept {
                expired: 0,
                capped: 24
            }
        );
        assert_eq!(store.usage().await.unwrap().lines, 1);
    }
}
