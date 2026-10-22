//! What can go wrong while quiet runs, in one place: Docker unreachable, the
//! disk cap (or the disk itself) filling up, ingest requests being refused,
//! the SQLite writer failing. `GET /api/system` reports it and the UI turns
//! each issue into a banner.
//!
//! [`SystemState`] holds the counters the receivers, pipeline and retention
//! job update; [`status`] turns them plus live readings into [`SystemStatus`].

use crate::receiver::DockerStatus;
use crate::store::StoreHealth;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use ts_rs::TS;

const MINUTE: i64 = 60_000;
/// Rejections are kept (grouped per minute) for a day, at most this many groups.
const MAX_GROUPS: usize = 2_000;
const KEEP_MS: i64 = 24 * 3_600_000;
/// Disk use at or above this share of the cap is "near".
pub const NEAR_CAP: f64 = 0.9;
/// The filesystem is "low" under this many free bytes or this share free.
const FS_LOW_BYTES: u64 = 500_000_000;
const FS_LOW_SHARE: f64 = 0.05;

/// Refused ingest requests, grouped per minute (bodies are never kept).
#[derive(Debug, Clone, Serialize, TS)]
pub struct Rejection {
    /// Start of the minute, unix ms.
    pub minute: i64,
    /// `ndjson`, `vector`, `fluentbit`, `otlp-logs`, `otlp-traces`.
    pub endpoint: String,
    pub status: u16,
    pub reason: String,
    /// The source it was meant for, when the request named one.
    pub source: Option<String>,
    /// `qi_••••1a77`, or `null` when no token was sent.
    pub token: Option<String>,
    #[ts(type = "number")]
    pub count: u64,
}

#[derive(Debug, Default)]
struct Inner {
    rejections: VecDeque<Rejection>,
    paused: HashMap<String, u64>,
    /// Lines dropped by the cap since start, and when it last dropped.
    capped_lines: u64,
    capped_at: Option<i64>,
    last_sweep: Option<i64>,
    /// Ingest batches the store refused (writer gone, disk full).
    append_errors: u64,
    last_append_error: Option<(i64, String)>,
}

#[derive(Debug, Default)]
pub struct SystemState {
    inner: Mutex<Inner>,
}

impl SystemState {
    pub fn reject(
        &self,
        now: i64,
        endpoint: &str,
        status: u16,
        reason: &str,
        source: Option<&str>,
        token: Option<String>,
    ) {
        let minute = now.div_euclid(MINUTE) * MINUTE;
        let mut g = self.inner.lock().unwrap();
        let hit = g.rejections.iter_mut().rev().take(50).find(|r| {
            r.minute == minute
                && r.endpoint == endpoint
                && r.status == status
                && r.reason == reason
                && r.source.as_deref() == source
                && r.token == token
        });
        match hit {
            Some(r) => r.count += 1,
            None => g.rejections.push_back(Rejection {
                minute,
                endpoint: endpoint.into(),
                status,
                reason: reason.chars().take(200).collect(),
                source: source.map(str::to_string),
                token,
                count: 1,
            }),
        }
        while g.rejections.len() > MAX_GROUPS
            || g.rejections
                .front()
                .is_some_and(|r| r.minute < now - KEEP_MS)
        {
            g.rejections.pop_front();
        }
    }

    /// Newest first, optionally for one source, at most `limit` groups.
    pub fn rejections(&self, source: Option<&str>, limit: usize) -> Vec<Rejection> {
        let g = self.inner.lock().unwrap();
        g.rejections
            .iter()
            .rev()
            .filter(|r| source.is_none_or(|s| r.source.as_deref() == Some(s)))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Rejected requests since `since` (unix ms), optionally for one source.
    pub fn rejected_since(&self, since: i64, source: Option<&str>) -> u64 {
        let g = self.inner.lock().unwrap();
        g.rejections
            .iter()
            .filter(|r| r.minute + MINUTE > since)
            .filter(|r| source.is_none_or(|s| r.source.as_deref() == Some(s)))
            .map(|r| r.count)
            .sum()
    }

    pub fn paused_drop(&self, source: &str, n: u64) {
        *self
            .inner
            .lock()
            .unwrap()
            .paused
            .entry(source.to_string())
            .or_default() += n;
    }

    pub fn paused_dropped(&self, source: &str) -> u64 {
        self.inner
            .lock()
            .unwrap()
            .paused
            .get(source)
            .copied()
            .unwrap_or(0)
    }

    pub fn swept(&self, now: i64, capped_lines: u64) {
        let mut g = self.inner.lock().unwrap();
        g.last_sweep = Some(now);
        if capped_lines > 0 {
            g.capped_lines += capped_lines;
            g.capped_at = Some(now);
        }
    }

    pub fn store_error(&self, e: &anyhow::Error) {
        let mut g = self.inner.lock().unwrap();
        g.append_errors += 1;
        g.last_append_error = Some((chrono::Utc::now().timestamp_millis(), e.to_string()));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DiskState {
    Ok,
    /// At or above 90% of the cap.
    Near,
    /// The cap is dropping hours (within the last hour), or use is at the cap.
    Full,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct DiskStatus {
    pub state: DiskState,
    /// Bytes the database uses (0 for the memory store).
    pub used: u64,
    pub cap: u64,
    /// `used / cap`, 0…1+.
    pub ratio: f64,
    /// Free / total bytes on the data directory's filesystem, when known.
    pub fs_free: Option<u64>,
    pub fs_total: Option<u64>,
    /// The filesystem itself is nearly full (whatever the cap says).
    pub fs_low: bool,
    /// The searchable window setting, ms.
    pub window_ms: i64,
    /// How far back stored lines really reach now, ms (`now − oldest`).
    pub reaches_ms: Option<i64>,
    /// Lines the cap dropped since the server started, and when it last did.
    #[ts(type = "number")]
    pub capped_lines: u64,
    pub capped_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct PausedSource {
    pub source: String,
    /// Lines dropped since the server started.
    #[ts(type = "number")]
    pub dropped: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct IngestHealth {
    #[ts(type = "number")]
    pub rejected_15m: u64,
    #[ts(type = "number")]
    pub rejected_24h: u64,
    /// Newest groups first (at most 20).
    pub recent: Vec<Rejection>,
    pub paused: Vec<PausedSource>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct StoreStatus {
    /// `sqlite` or `memory`.
    pub kind: String,
    #[ts(type = "number")]
    pub write_errors: u64,
    pub last_error: Option<String>,
    pub last_error_at: Option<i64>,
    /// The last write failed because the disk (or the database) is full.
    pub disk_full: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    DockerUnavailable,
    DiskNearCap,
    DiskAtCap,
    DiskLow,
    StoreErrors,
    IngestRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    Error,
}

/// One thing that needs attention, worded for a banner.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Issue {
    pub kind: IssueKind,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
}

/// `GET /api/system`.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SystemStatus {
    /// Nothing needs attention.
    pub ok: bool,
    pub issues: Vec<Issue>,
    pub docker: DockerStatus,
    pub disk: DiskStatus,
    pub ingest: IngestHealth,
    pub store: StoreStatus,
    /// Server time, unix ms.
    pub now: i64,
}

/// Free and total bytes on the filesystem holding `dir`.
pub fn fs_space(dir: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        // The data dir may not exist yet on a fresh start; ask its parent.
        let dir = std::iter::successors(Some(dir), |d| d.parent()).find(|d| d.exists())?;
        let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path and `st` a valid out pointer.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        let frsize = st.f_frsize as u64;
        Some((st.f_bavail as u64 * frsize, st.f_blocks as u64 * frsize))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

/// Inputs read live by the API handler.
pub struct Readings {
    pub now: i64,
    pub docker: DockerStatus,
    pub store_kind: String,
    pub store_health: StoreHealth,
    pub used: u64,
    pub oldest: Option<i64>,
    pub cap: u64,
    pub window_ms: i64,
    pub fs: Option<(u64, u64)>,
}

pub fn status(sys: &SystemState, r: Readings) -> SystemStatus {
    let (capped_lines, capped_at, append_errors, last_append) = {
        let g = sys.inner.lock().unwrap();
        (
            g.capped_lines,
            g.capped_at,
            g.append_errors,
            g.last_append_error.clone(),
        )
    };
    let ratio = if r.cap == 0 {
        0.0
    } else {
        r.used as f64 / r.cap as f64
    };
    let capping = capped_at.is_some_and(|t| r.now - t < 3_600_000);
    let state = if ratio >= 1.0 || capping {
        DiskState::Full
    } else if ratio >= NEAR_CAP {
        DiskState::Near
    } else {
        DiskState::Ok
    };
    let fs_low = r.fs.is_some_and(|(free, total)| {
        free < FS_LOW_BYTES || (total > 0 && (free as f64) < FS_LOW_SHARE * total as f64)
    });
    let reaches_ms = r.oldest.map(|o| (r.now - o).max(0));
    let disk = DiskStatus {
        state,
        used: r.used,
        cap: r.cap,
        ratio,
        fs_free: r.fs.map(|f| f.0),
        fs_total: r.fs.map(|f| f.1),
        fs_low,
        window_ms: r.window_ms,
        reaches_ms,
        capped_lines,
        capped_at,
    };

    let rejected_15m = sys.rejected_since(r.now - 15 * MINUTE, None);
    let ingest = IngestHealth {
        rejected_15m,
        rejected_24h: sys.rejected_since(r.now - KEEP_MS, None),
        recent: sys.rejections(None, 20),
        paused: {
            let g = sys.inner.lock().unwrap();
            let mut v: Vec<_> = g
                .paused
                .iter()
                .map(|(s, n)| PausedSource {
                    source: s.clone(),
                    dropped: *n,
                })
                .collect();
            v.sort_by(|a, b| a.source.cmp(&b.source));
            v
        },
    };

    // The writer's own errors and refused appends both count.
    let (last_error, last_error_at) = match (&r.store_health.last_error, &last_append) {
        (Some((at, e)), Some((at2, e2))) if at2 > at => (Some(e2.clone()), Some(*at2)),
        (Some((at, e)), _) => (Some(e.clone()), Some(*at)),
        (None, Some((at, e))) => (Some(e.clone()), Some(*at)),
        (None, None) => (None, None),
    };
    let disk_full = last_error.as_deref().is_some_and(is_disk_full);
    let store = StoreStatus {
        kind: r.store_kind,
        write_errors: r.store_health.write_errors + append_errors,
        last_error,
        last_error_at,
        disk_full,
    };

    let mut issues = Vec::new();
    if let DockerStatus::Unavailable { error } = &r.docker {
        issues.push(Issue {
            kind: IssueKind::DockerUnavailable,
            severity: Severity::Error,
            title: "Docker is unavailable".into(),
            detail: format!(
                "quiet can't reach the Docker engine: {error}. Container logs pause until it comes \
                 back; quiet retries every 5 s and backfills from Docker's own log."
            ),
        });
    }
    let gb = |b: u64| format!("{:.1} GB", b as f64 / 1e9);
    match disk.state {
        DiskState::Full => issues.push(Issue {
            kind: IssueKind::DiskAtCap,
            severity: Severity::Warn,
            title: format!("Disk is at {:.0}% of the {} cap", ratio * 100.0, gb(r.cap)),
            detail: match reaches_ms {
                Some(ms) if ms < r.window_ms => format!(
                    "quiet is dropping the oldest hour first: search now reaches back {}, not {}. \
                     The live stream is unaffected.",
                    span(ms),
                    span(r.window_ms)
                ),
                _ => {
                    "quiet is dropping the oldest hour first. The live stream is unaffected.".into()
                }
            },
        }),
        DiskState::Near => issues.push(Issue {
            kind: IssueKind::DiskNearCap,
            severity: Severity::Warn,
            title: format!("Disk is at {:.0}% of the {} cap", ratio * 100.0, gb(r.cap)),
            detail: "At the cap quiet drops the oldest hour first. Raise the cap, shorten the \
                     window or mute a noisy source in Settings → Storage."
                .into(),
        }),
        DiskState::Ok => {}
    }
    if fs_low || disk_full {
        issues.push(Issue {
            kind: IssueKind::DiskLow,
            severity: Severity::Error,
            title: "The disk quiet writes to is almost full".into(),
            detail: format!(
                "{} free on the data volume. New lines may fail to save; free space or lower the \
                 disk cap below what's available.",
                disk.fs_free.map(gb).unwrap_or_else(|| "little".into())
            ),
        });
    }
    if store.write_errors > 0 && last_error_at.is_some_and(|t| r.now - t < 15 * MINUTE) {
        issues.push(Issue {
            kind: IssueKind::StoreErrors,
            severity: Severity::Error,
            title: "Lines failed to save".into(),
            detail: format!(
                "{} write error(s); last: {}",
                store.write_errors,
                store.last_error.clone().unwrap_or_default()
            ),
        });
    }
    if rejected_15m > 0 {
        issues.push(Issue {
            kind: IssueKind::IngestRejected,
            severity: Severity::Warn,
            title: format!("{rejected_15m} ingest request(s) refused in the last 15 min"),
            detail: ingest
                .recent
                .first()
                .map(|r| format!("latest: {} {} on /{}", r.status, r.reason, r.endpoint))
                .unwrap_or_default(),
        });
    }

    SystemStatus {
        ok: issues.is_empty(),
        issues,
        docker: r.docker,
        disk,
        ingest,
        store,
        now: r.now,
    }
}

/// SQLite's SQLITE_FULL / the OS's ENOSPC, as they read in an error message.
pub fn is_disk_full(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("disk is full") || m.contains("database or disk is full") || m.contains("no space")
}

/// `2d 13h`, `24h`, `40m` (days from 48h on, like the design's "2d 13h instead of 3d").
pub fn span(ms: i64) -> String {
    let h = ms / 3_600_000;
    if h >= 48 {
        let (d, h) = (h / 24, h % 24);
        if h == 0 {
            format!("{d}d")
        } else {
            format!("{d}d {h}h")
        }
    } else if h >= 1 {
        format!("{h}h")
    } else {
        format!("{}m", ms / 60_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readings(used: u64, cap: u64) -> Readings {
        Readings {
            now: 10 * 3_600_000,
            docker: DockerStatus::Connected { containers: 2 },
            store_kind: "sqlite".into(),
            store_health: StoreHealth::default(),
            used,
            oldest: Some(0),
            cap,
            window_ms: 24 * 3_600_000,
            fs: Some((50_000_000_000, 100_000_000_000)),
        }
    }

    #[test]
    fn rejections_group_per_minute_and_by_source() {
        let s = SystemState::default();
        let now = 1_792_000_000_000;
        for _ in 0..3 {
            s.reject(
                now,
                "otlp-logs",
                401,
                "token revoked",
                Some("pay"),
                Some("qi_••••77e0".into()),
            );
        }
        s.reject(now + 61_000, "ndjson", 413, "too large", None, None);
        let all = s.rejections(None, 10);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].status, 413, "newest first");
        assert_eq!(all[1].count, 3);
        assert_eq!(s.rejections(Some("pay"), 10).len(), 1);
        assert_eq!(s.rejected_since(now, None), 4);
        assert_eq!(s.rejected_since(now, Some("pay")), 3);
        assert_eq!(s.rejected_since(now + 10 * 60_000, None), 0);
    }

    #[test]
    fn disk_states_and_issues() {
        let s = SystemState::default();
        let st = status(&s, readings(1_000, 10_000));
        assert!(st.ok && st.disk.state == DiskState::Ok);

        let st = status(&s, readings(9_500, 10_000));
        assert_eq!(st.disk.state, DiskState::Near);
        assert_eq!(st.issues[0].kind, IssueKind::DiskNearCap);

        // The cap dropped hours a moment ago: at cap, and the window shrank.
        s.swept(10 * 3_600_000 - 60_000, 500);
        let mut r = readings(9_000, 10_000);
        r.oldest = Some(r.now - 5 * 3_600_000);
        let st = status(&s, r);
        assert_eq!(st.disk.state, DiskState::Full);
        assert!(
            st.issues[0].detail.contains("reaches back 5h, not 24h"),
            "{}",
            st.issues[0].detail
        );

        let mut r = readings(0, 10_000);
        r.docker = DockerStatus::Unavailable {
            error: "permission denied".into(),
        };
        r.fs = Some((100_000_000, 100_000_000_000));
        let st = status(&SystemState::default(), r);
        let kinds: Vec<_> = st.issues.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            vec![IssueKind::DockerUnavailable, IssueKind::DiskLow]
        );
        assert!(!st.ok);
    }

    #[test]
    fn store_errors_and_disk_full() {
        let s = SystemState::default();
        s.store_error(&anyhow::anyhow!("database or disk is full"));
        let mut r = readings(0, 10_000);
        r.now = chrono::Utc::now().timestamp_millis();
        r.oldest = None;
        let st = status(&s, r);
        assert!(st.store.disk_full);
        assert_eq!(st.store.write_errors, 1);
        let kinds: Vec<_> = st.issues.iter().map(|i| i.kind).collect();
        assert!(kinds.contains(&IssueKind::StoreErrors) && kinds.contains(&IssueKind::DiskLow));
        assert_eq!(span(61 * 3_600_000), "2d 13h");
    }
}
