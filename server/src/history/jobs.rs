//! The retained-history worker (v0.1.1 Phase 5b): everything that moves or
//! deletes archived hours in the background.
//!
//! Each step does a bounded amount of object-store work, in this order:
//!
//! 1. **History retention:** hours older than the history window, in every
//!    destination, are deleted (segment + manifest, then the catalog row).
//! 2. **Capacity (evict oldest):** while the active destination holds more
//!    than its capacity, its oldest hours go (never its newest).
//! 3. **Jobs** (`history_jobs`), oldest first: backfill (archive local hours
//!    now), copy (one destination's hours to another), delete (a
//!    destination's history, then forget it).
//!
//! What a job still has to move is re-derived from the catalog on every
//! step (a catalog row is written only after the object is checked), so a
//! job survives a restart and resumes where it was. A refused delete
//! (AccessDenied, object lock) marks the hours `cleanup_blocked`, raises the
//! `history_cleanup_blocked` banner and backs off (5 min, doubling to 6 h);
//! Retry tries again at once. Other failures back off from 30 s.

use super::catalog::{DestinationRow, JobRow};
use super::remote::{self, Remote};
use super::{retention_before, AtCapacity, History, HourRecord, JobKind, JobState};
use crate::store::Store;
use crate::system::{Issue, IssueKind, Severity, SystemState};
use object_store::path::Path as ObjPath;
use object_store::ObjectStoreExt;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Object operations per step, so a big delete never starves the rest.
pub const BUDGET: usize = 32;
const REFUSED_BACKOFF_MS: i64 = 5 * 60_000;
const REFUSED_MAX_MS: i64 = 6 * 3_600_000;
const TRANSIENT_BACKOFF_MS: i64 = 30_000;
const TRANSIENT_MAX_MS: i64 = 15 * 60_000;
/// How often the Garage bucket quota is read.
const GARAGE_EVERY_MS: i64 = 5 * 60_000;

/// Why an object operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpError {
    /// The destination said no (permissions, object lock): don't hammer it.
    Refused(String),
    /// Network, 5xx, timeouts: try again soon.
    Transient(String),
}

impl OpError {
    pub fn message(&self) -> &str {
        match self {
            OpError::Refused(m) | OpError::Transient(m) => m,
        }
    }
}

/// Refused (`PermissionDenied`, `Unauthenticated`, AccessDenied / object
/// lock / 403 in the message) or transient.
pub fn classify(e: &object_store::Error) -> OpError {
    let msg = short(e);
    match e {
        object_store::Error::PermissionDenied { .. }
        | object_store::Error::Unauthenticated { .. } => OpError::Refused(msg),
        _ => {
            let m = msg.to_ascii_lowercase();
            let refused = [
                "accessdenied",
                "access denied",
                "objectlock",
                "object lock",
                "worm",
                " 403",
                "forbidden",
            ]
            .iter()
            .any(|k| m.contains(k));
            if refused {
                OpError::Refused(msg)
            } else {
                OpError::Transient(msg)
            }
        }
    }
}

fn short(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 240 {
        format!("{}…", s.chars().take(240).collect::<String>())
    } else {
        s
    }
}

fn backoff(base: i64, max: i64, attempts: u32) -> i64 {
    (base << attempts.saturating_sub(1).min(10)).min(max)
}

/// What one step did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Work {
    /// Hours deleted (retention, eviction, delete jobs).
    pub deleted: u64,
    /// Hours archived by backfill.
    pub archived: u64,
    /// Hours copied between destinations.
    pub copied: u64,
}

impl Work {
    pub fn busy(&self) -> bool {
        self.deleted + self.archived + self.copied > 0
    }
}

/// Outcome of deleting a run of hours from one destination.
#[derive(Debug, Default)]
struct Cleanup {
    deleted: u64,
    bytes: u64,
    /// Stopped because the destination refused or failed; retry later.
    stopped: Option<OpError>,
    /// Still backing off from an earlier failure.
    waiting: bool,
}

impl History {
    /// Delete one archived hour's objects, then its catalog row. A missing
    /// object counts as deleted.
    async fn delete_hour(
        &self,
        remote: &Remote,
        d: &DestinationRow,
        rec: &HourRecord,
    ) -> Result<(), OpError> {
        for key in [rec.key.clone(), remote::manifest_key(&d.prefix, rec.hour)] {
            match remote.delete(&ObjPath::from(key)).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                Err(e) => return Err(classify(&e)),
            }
        }
        self.catalog
            .remove_hour(d.id, rec.hour)
            .map_err(|e| OpError::Transient(format!("{e:#}")))
    }

    /// Delete `recs` (one destination's, oldest first) within the budget,
    /// with the refused / transient backoff kept on the destination.
    async fn cleanup(
        &self,
        d: &DestinationRow,
        recs: &[HourRecord],
        now: i64,
        budget: &mut usize,
    ) -> anyhow::Result<Cleanup> {
        let mut out = Cleanup::default();
        if recs.is_empty() || *budget == 0 {
            return Ok(out);
        }
        if d.cleanup_retry_at.is_some_and(|t| now < t) {
            out.waiting = true;
            return Ok(out);
        }
        let remote = match self.remote(d) {
            Ok(r) => r,
            Err(e) => {
                let err = OpError::Transient(format!("{e:#}"));
                self.cleanup_failed(d, recs, &err, now)?;
                out.stopped = Some(err);
                return Ok(out);
            }
        };
        for (i, rec) in recs.iter().enumerate() {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            match self.delete_hour(&remote, d, rec).await {
                Ok(()) => {
                    out.deleted += 1;
                    out.bytes += rec.bytes_stored;
                }
                Err(err) => {
                    self.cleanup_failed(d, &recs[i..], &err, now)?;
                    out.stopped = Some(err);
                    return Ok(out);
                }
            }
        }
        if out.deleted > 0 && (d.cleanup_error.is_some() || d.cleanup_retry_at.is_some()) {
            self.catalog.set_cleanup(d.id, None, None, 0)?;
        }
        Ok(out)
    }

    fn cleanup_failed(
        &self,
        d: &DestinationRow,
        left: &[HourRecord],
        err: &OpError,
        now: i64,
    ) -> anyhow::Result<()> {
        let attempts = d.cleanup_attempts + 1;
        let wait = match err {
            OpError::Refused(_) => backoff(REFUSED_BACKOFF_MS, REFUSED_MAX_MS, attempts),
            OpError::Transient(_) => backoff(TRANSIENT_BACKOFF_MS, TRANSIENT_MAX_MS, attempts),
        };
        self.catalog
            .set_cleanup(d.id, Some(err.message()), Some(now + wait), attempts)?;
        if let OpError::Refused(m) = err {
            let hours: Vec<i64> = left.iter().map(|h| h.hour).collect();
            self.catalog.set_cleanup_blocked(d.id, &hours, Some(m))?;
        }
        tracing::warn!(destination = %d.name, attempts, error = %err.message(), "history: cleanup failed");
        Ok(())
    }

    /// Read the Garage quota (bytes) at most every few minutes.
    async fn refresh_garage(&self, now: i64) {
        let Some(env) = self.garage.as_ref() else {
            return;
        };
        let due = self
            .runtime
            .lock()
            .unwrap()
            .garage_checked
            .is_none_or(|t| now - t >= GARAGE_EVERY_MS);
        if !due {
            return;
        }
        let q = super::garage::quota(env).await;
        let mut rt = self.runtime.lock().unwrap();
        rt.garage_checked = Some(now);
        match q {
            Ok(q) => rt.garage_quota = q,
            Err(e) => {
                tracing::debug!(error = %format!("{e:#}"), "history: reading the garage quota failed")
            }
        }
    }

    /// One bounded step of background work at `now`.
    pub async fn work(
        &self,
        store: &dyn Store,
        exclude: &[String],
        now: i64,
        system: &SystemState,
    ) -> anyhow::Result<Work> {
        self.work_budget(store, exclude, now, system, BUDGET).await
    }

    /// [`History::work`] with at most `budget` object operations.
    pub async fn work_budget(
        &self,
        store: &dyn Store,
        exclude: &[String],
        now: i64,
        system: &SystemState,
        budget: usize,
    ) -> anyhow::Result<Work> {
        self.refresh_garage(now).await;
        let mut budget = budget;
        let mut work = Work::default();

        // 1. History retention, every destination.
        let policy = self.catalog.policy()?;
        if let Some(before) = retention_before(&policy, now) {
            let old = self.catalog.hours_before(before)?;
            for d in self.catalog.destinations()? {
                let mine: Vec<HourRecord> = old
                    .iter()
                    .filter(|h| h.destination_id == d.id)
                    .cloned()
                    .collect();
                work.deleted += self.cleanup(&d, &mine, now, &mut budget).await?.deleted;
            }
        }

        // 2. Evict oldest while the active destination is over capacity.
        if policy.at_capacity == AtCapacity::Evict {
            if let Some(d) = self.catalog.active()? {
                if let Some((cap, _)) = self.capacity(&d) {
                    let hours = self.catalog.hours_of(d.id)?;
                    let mut used: u64 = hours.iter().map(|h| h.bytes_stored).sum();
                    let mut evict = Vec::new();
                    // Never the newest hour: evicting what was just archived
                    // would loop forever on a capacity smaller than an hour.
                    for h in hours.iter().take(hours.len().saturating_sub(1)) {
                        if used <= cap {
                            break;
                        }
                        used -= h.bytes_stored;
                        evict.push(h.clone());
                    }
                    if !evict.is_empty() {
                        let c = self.cleanup(&d, &evict, now, &mut budget).await?;
                        // Deletes run oldest first and stop at the first failure.
                        let gone = &evict[..(c.deleted as usize).min(evict.len())];
                        self.catalog.record_evictions(d.id, gone, now)?;
                        if c.deleted > 0 {
                            tracing::info!(hours = c.deleted, destination = %d.name, "history: evicted oldest hours at capacity");
                        }
                        work.deleted += c.deleted;
                    }
                }
            }
        }

        // 3. Jobs, oldest first.
        for job in self.catalog.open_jobs()? {
            if budget == 0 {
                break;
            }
            if job.next_retry.is_some_and(|t| now < t) {
                continue;
            }
            match job.kind {
                JobKind::Backfill => {
                    work.archived += self
                        .step_backfill(job, store, exclude, now, &mut budget)
                        .await?
                }
                JobKind::Copy => work.copied += self.step_copy(job, now, &mut budget).await?,
                JobKind::Delete => work.deleted += self.step_delete(job, now, &mut budget).await?,
            }
        }

        self.cleanup_banner(system)?;
        Ok(work)
    }

    /// `history_cleanup_blocked` while any destination has refused hours.
    fn cleanup_banner(&self, system: &SystemState) -> anyhow::Result<()> {
        let mut blocked = Vec::new();
        for d in self.catalog.destinations()? {
            let (n, _) = self.catalog.blocked_hours(d.id)?;
            if n > 0 {
                blocked.push((d, n));
            }
        }
        let issue = blocked.first().map(|(d, n)| Issue {
            kind: IssueKind::HistoryCleanupBlocked,
            severity: Severity::Warn,
            title: format!("Retained history cleanup blocked on {}", d.name),
            detail: format!(
                "{n} hour{} can't be deleted: {}{}",
                if *n == 1 { "" } else { "s" },
                d.cleanup_error.clone().unwrap_or_default(),
                if blocked.len() > 1 {
                    format!(" · {} more destinations", blocked.len() - 1)
                } else {
                    String::new()
                }
            ),
        });
        system.set_history_issue_of(IssueKind::HistoryCleanupBlocked, issue);
        Ok(())
    }

    fn finish(
        &self,
        mut job: JobRow,
        state: JobState,
        error: Option<String>,
        now: i64,
    ) -> anyhow::Result<()> {
        job.state = state;
        job.error = error;
        job.next_retry = None;
        job.updated_at = now;
        self.catalog.save_job(&job)?;
        Ok(())
    }

    fn retry_later(&self, mut job: JobRow, err: &OpError, now: i64) -> anyhow::Result<()> {
        job.attempts += 1;
        job.error = Some(err.message().to_string());
        job.next_retry = Some(now + backoff(TRANSIENT_BACKOFF_MS, TRANSIENT_MAX_MS, job.attempts));
        job.updated_at = now;
        self.catalog.save_job(&job)?;
        Ok(())
    }

    async fn step_backfill(
        &self,
        mut job: JobRow,
        store: &dyn Store,
        exclude: &[String],
        now: i64,
        budget: &mut usize,
    ) -> anyhow::Result<u64> {
        let Some(d) = self
            .catalog
            .active()?
            .filter(|d| Some(d.id) == job.destination_id)
        else {
            self.finish(
                job,
                JobState::Failed,
                Some("the destination is no longer active".into()),
                now,
            )?;
            return Ok(0);
        };
        let todo = self.backfill_candidates(store, now).await?;
        if todo.is_empty() {
            self.finish(job, JobState::Done, None, now)?;
            return Ok(0);
        }
        let remote = match self.remote(&d) {
            Ok(r) => r,
            Err(e) => {
                self.retry_later(job, &OpError::Transient(format!("{e:#}")), now)?;
                return Ok(0);
            }
        };
        let mut n = 0;
        for hour in todo {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            match self
                .archive_hour(store, &d, &remote, hour, exclude, now)
                .await
            {
                Ok(rec) => {
                    n += 1;
                    job.done += 1;
                    job.bytes += rec.map_or(0, |r| r.bytes_stored);
                    job.attempts = 0;
                    job.error = None;
                }
                Err(e) => {
                    let err = e
                        .downcast_ref::<object_store::Error>()
                        .map(classify)
                        .unwrap_or_else(|| OpError::Transient(format!("{e:#}")));
                    job.total = job.total.max(job.done);
                    self.retry_later(job, &err, now)?;
                    return Ok(n);
                }
            }
        }
        job.total = job.total.max(job.done);
        job.updated_at = now;
        self.catalog.save_job(&job)?;
        if self.backfill_candidates(store, now).await?.is_empty() {
            let _ = self.write_instance(&remote, &d, now).await;
            self.finish(job, JobState::Done, None, now)?;
        }
        Ok(n)
    }

    async fn step_copy(
        &self,
        mut job: JobRow,
        now: i64,
        budget: &mut usize,
    ) -> anyhow::Result<u64> {
        let from = job
            .source_id
            .and_then(|id| self.catalog.destination(id).ok().flatten());
        let to = job
            .destination_id
            .and_then(|id| self.catalog.destination(id).ok().flatten());
        let (Some(from), Some(to)) = (from, to) else {
            self.finish(
                job,
                JobState::Failed,
                Some("a destination of this copy was removed".into()),
                now,
            )?;
            return Ok(0);
        };
        let todo = self.copy_remaining(from.id, to.id)?;
        if todo.is_empty() {
            if let Ok(r) = self.remote(&to) {
                let _ = self.write_instance(&r, &to, now).await;
            }
            self.finish(job, JobState::Done, None, now)?;
            return Ok(0);
        }
        let (src, dst) = match (self.remote(&from), self.remote(&to)) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => {
                self.retry_later(job, &OpError::Transient(format!("{e:#}")), now)?;
                return Ok(0);
            }
        };
        // Same bucket and credentials: the store copies server-side.
        let same = from.kind == to.kind
            && from.endpoint == to.endpoint
            && from.bucket == to.bucket
            && from.region == to.region
            && from.access_key_id == to.access_key_id;
        let mut n = 0;
        for rec in todo {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            match self.copy_hour(&src, &dst, &to, &rec, same, now).await {
                Ok(true) => {
                    n += 1;
                    job.done += 1;
                    job.bytes += rec.bytes_stored;
                    job.attempts = 0;
                    job.error = None;
                }
                Ok(false) => {
                    // The source object is gone: it can't be copied; the
                    // catalog stops claiming it.
                    tracing::warn!(hour = rec.hour, source = %from.name, "history: copy skipped a missing hour");
                    self.catalog.remove_hour(from.id, rec.hour)?;
                    job.total = job.total.saturating_sub(1);
                }
                Err(OpError::Refused(m)) => {
                    self.finish(job, JobState::Failed, Some(m), now)?;
                    return Ok(n);
                }
                Err(err) => {
                    self.retry_later(job, &err, now)?;
                    return Ok(n);
                }
            }
        }
        job.updated_at = now;
        self.catalog.save_job(&job)?;
        if self.copy_remaining(from.id, to.id)?.is_empty() {
            let _ = self.write_instance(&dst, &to, now).await;
            self.finish(job, JobState::Done, None, now)?;
        }
        Ok(n)
    }

    /// Copy one hour (segment + a fresh manifest) and record it for `to`.
    /// `Ok(false)`: the source object no longer exists.
    async fn copy_hour(
        &self,
        src: &Remote,
        dst: &Remote,
        to: &DestinationRow,
        rec: &HourRecord,
        same: bool,
        now: i64,
    ) -> Result<bool, OpError> {
        let from_key = ObjPath::from(rec.key.clone());
        let key = remote::hour_key(&to.prefix, rec.hour);
        let to_key = ObjPath::from(key.clone());
        let copied = if same {
            dst.copy(&from_key, &to_key).await
        } else {
            match src.get(&from_key).await {
                Ok(g) => match g.bytes().await {
                    Ok(b) => dst.put(&to_key, b.into()).await.map(|_| ()),
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            }
        };
        match copied {
            Ok(()) => {}
            Err(object_store::Error::NotFound { .. }) => return Ok(false),
            Err(e) => return Err(classify(&e)),
        }
        let head = dst.head(&to_key).await.map_err(|e| classify(&e))?;
        if head.size != rec.bytes_stored {
            return Err(OpError::Transient(format!(
                "copied {key} is {} bytes, expected {}",
                head.size, rec.bytes_stored
            )));
        }
        let copy = HourRecord {
            destination_id: to.id,
            key,
            archived_at: now,
            ..rec.clone()
        };
        self.put_manifest(dst, to, &copy, now)
            .await
            .map_err(|e| OpError::Transient(format!("{e:#}")))?;
        self.catalog
            .add_hour(&copy)
            .map_err(|e| OpError::Transient(format!("{e:#}")))?;
        Ok(true)
    }

    async fn step_delete(
        &self,
        mut job: JobRow,
        now: i64,
        budget: &mut usize,
    ) -> anyhow::Result<u64> {
        let Some(d) = job
            .destination_id
            .and_then(|id| self.catalog.destination(id).ok().flatten())
        else {
            self.finish(job, JobState::Done, None, now)?;
            return Ok(0);
        };
        let todo = self.catalog.hours_of(d.id)?;
        if todo.is_empty() {
            if let Ok(r) = self.remote(&d) {
                let _ = r
                    .delete(&ObjPath::from(remote::instance_key(&d.prefix)))
                    .await;
            }
            self.catalog.remove(d.id)?;
            self.finish(job, JobState::Done, None, now)?;
            tracing::info!(destination = %d.name, "history: deleted a destination's history and forgot it");
            return Ok(0);
        }
        let c = self.cleanup(&d, &todo, now, budget).await?;
        job.done += c.deleted;
        job.bytes += c.bytes;
        job.updated_at = now;
        match (&c.stopped, c.waiting) {
            (Some(OpError::Refused(m)), _) => {
                job.state = JobState::Blocked;
                job.error = Some(m.clone());
                job.next_retry = self
                    .catalog
                    .destination(d.id)?
                    .and_then(|x| x.cleanup_retry_at);
            }
            (Some(OpError::Transient(m)), _) => {
                job.error = Some(m.clone());
                job.next_retry = self
                    .catalog
                    .destination(d.id)?
                    .and_then(|x| x.cleanup_retry_at);
            }
            (None, true) => {
                job.next_retry = d.cleanup_retry_at;
            }
            (None, false) => {
                job.state = JobState::Running;
                job.error = None;
                job.next_retry = None;
            }
        }
        self.catalog.save_job(&job)?;
        Ok(c.deleted)
    }
}

/// The background worker: a step every few seconds, at once when woken,
/// and straight on while there is work.
pub async fn run(
    history: Arc<History>,
    store: Arc<dyn Store>,
    settings: Arc<crate::settings::Settings>,
    system: Arc<SystemState>,
    shutdown: CancellationToken,
) {
    loop {
        let now = chrono::Utc::now().timestamp_millis();
        let busy = match history
            .work(store.as_ref(), &settings.history_excluded(), now, &system)
            .await
        {
            Ok(w) => w.busy(),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "history: background step failed");
                false
            }
        };
        if busy {
            tokio::task::yield_now().await;
            if shutdown.is_cancelled() {
                return;
            }
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = history.wake.notified() => {}
            _ = shutdown.cancelled() => return,
        }
    }
}
