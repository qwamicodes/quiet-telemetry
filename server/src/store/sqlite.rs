//! The searchable window on disk: SQLite (bundled, WAL) with hourly partitions.
//!
//! Layout, one set of tables per hour `h` (unix ms / 3 600 000):
//!
//! - `"l_h"`: the lines (id, ts, received, source, level, raw). Only the raw
//!   line is kept; fields, ids and the summary are re-derived with
//!   [`normalize`] when a line is read, so each line is on disk once.
//! - `"f_h"`: contentless FTS5 over `raw` (unicode61, so `dealers/88` is
//!   `dealers` + `88`).
//! - `"i_h"`: every correlation id a line carries (`value → line_id`), so an
//!   id lookup never scans.
//!
//! Expiry and the disk cap drop whole hours (`DROP TABLE`, then an incremental
//! vacuum hands the pages back to the OS). Catalog tables `partitions`,
//! `sources` and `meta` say what exists.
//!
//! Writes go through one writer thread fed by a channel: it coalesces whatever
//! is queued into one transaction, so bursts cost one commit. A memory ring in
//! front answers the live tail (the stream backlog) immediately; search sees
//! a line once the writer has committed it (milliseconds, or on [`Store::flush`]).
//! Reads use a small pool of read-only connections inside `spawn_blocking`,
//! each search in one read transaction so a concurrent drop can't tear it.

use super::{
    rank_similar, similar_prefix, HistSpec, HourUsage, LevelCounts, MemoryStore, Query, Restored,
    SourceUsage, StorageUsage, Store, StoreHealth, StoredSource, Usage,
};
use crate::hub::{Line, SourceKind};
use crate::normalize::{normalize, CorrId, IdKey, Level};
use crate::search::{
    add_to_histogram, bucket_width, empty_histogram, Cursor, Order, SearchPage, SearchQuery,
};
use anyhow::Context;
use async_trait::async_trait;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

const HOUR: i64 = 3_600_000;
/// A line whose event time is further than this from its arrival is filed
/// under its arrival hour, so a bad clock can't create a table for 1970.
const MAX_SKEW: i64 = 8 * 24 * HOUR;
/// Lines coalesced into one write transaction at most.
const WRITE_BATCH: usize = 20_000;
const READERS: usize = 4;

#[derive(Debug, Clone)]
pub struct SqliteOptions {
    /// The database file (`<data-dir>/quiet.db`).
    pub path: PathBuf,
    /// Live lines kept in memory per source (the stream backlog).
    pub ring: usize,
    /// Memory budget for every ring together (estimated bytes).
    pub ring_memory: usize,
}

enum Msg {
    Lines(SourceKind, Vec<Line>),
    Flush(oneshot::Sender<()>),
    Expire(i64, oneshot::Sender<anyhow::Result<u64>>),
    Cap(u64, oneshot::Sender<anyhow::Result<u64>>),
    /// Lines of one source older than the cutoff (`i64::MAX` = all of them).
    ExpireSource(String, i64, oneshot::Sender<anyhow::Result<u64>>),
    /// Every hour, newest included.
    PurgeAll(oneshot::Sender<anyhow::Result<u64>>),
}

pub struct SqliteStore {
    ring: MemoryStore,
    tx: mpsc::Sender<Msg>,
    readers: Arc<Readers>,
    health: Arc<Mutex<StoreHealth>>,
}

struct Readers {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl Readers {
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let conn = self.idle.lock().unwrap().pop();
        let mut conn = match conn {
            Some(c) => c,
            None => open_reader(&self.path)?,
        };
        let out = f(&mut conn);
        // A failed read may leave a transaction open; don't pool that connection.
        if conn.is_autocommit() {
            let mut idle = self.idle.lock().unwrap();
            if idle.len() < READERS {
                idle.push(conn);
            }
        }
        out
    }
}

fn open_reader(path: &PathBuf) -> anyhow::Result<Connection> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(c)
}

fn open_writer(path: &PathBuf) -> anyhow::Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating data dir {}", dir.display()))?;
    }
    let c = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    // auto_vacuum only takes effect before the first table exists.
    c.execute_batch(
        "PRAGMA auto_vacuum = INCREMENTAL;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS partitions (
             hour INTEGER PRIMARY KEY, lines INTEGER NOT NULL DEFAULT 0,
             bytes INTEGER NOT NULL DEFAULT 0, min_ts INTEGER, max_ts INTEGER);
         CREATE TABLE IF NOT EXISTS sources (
             name TEXT PRIMARY KEY, kind TEXT NOT NULL,
             lines INTEGER NOT NULL DEFAULT 0, last_ts INTEGER);
         CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS source_hours (
             hour INTEGER NOT NULL, source TEXT NOT NULL,
             lines INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (hour, source));",
    )?;
    Ok(c)
}

impl SqliteStore {
    /// Open (or create) the database, warm the live ring from it and start
    /// the writer thread. Blocking: call it from `spawn_blocking` or at startup.
    pub fn open(opts: SqliteOptions) -> anyhow::Result<Self> {
        let writer = open_writer(&opts.path)?;
        let readers = Arc::new(Readers {
            path: opts.path.clone(),
            idle: Mutex::new(Vec::new()),
        });

        // Warm the ring so the stream has a backlog right after a restart.
        let ring = MemoryStore::with_budget(opts.ring, opts.ring_memory);
        let sources: Vec<String> = readers.with(|c| {
            let mut st = c.prepare("SELECT name FROM sources ORDER BY name")?;
            let names = st
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(names)
        })?;
        for name in sources {
            let q = SearchQuery {
                sources: vec![name],
                limit: opts.ring,
                ..Default::default()
            };
            let mut page = readers.with(|c| search_sync(c, &q))?;
            page.lines.reverse();
            ring.push_many(&page.lines);
        }

        let health = Arc::new(Mutex::new(StoreHealth::default()));
        let mut w = Writer::new(writer, health.clone());
        w.backfill_source_hours()?;
        let (tx, rx) = mpsc::channel(1024);
        std::thread::Builder::new()
            .name("quiet-sqlite-writer".into())
            .spawn(move || w.run(rx))?;
        Ok(SqliteStore {
            ring,
            tx,
            readers,
            health,
        })
    }

    async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let r = self.readers.clone();
        tokio::task::spawn_blocking(move || r.with(f)).await?
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> anyhow::Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(msg(tx))
            .await
            .map_err(|_| anyhow::anyhow!("sqlite writer stopped"))?;
        Ok(rx.await?)
    }
}

#[async_trait]
impl Store for SqliteStore {
    fn kind(&self) -> &'static str {
        "sqlite"
    }

    async fn append(&self, kind: SourceKind, lines: &[Line]) -> anyhow::Result<()> {
        self.ring.push_many(lines);
        self.tx
            .send(Msg::Lines(kind, lines.to_vec()))
            .await
            .map_err(|_| anyhow::anyhow!("sqlite writer stopped"))
    }

    async fn query(&self, q: &Query) -> anyhow::Result<Vec<Line>> {
        self.ring.query(q).await
    }

    async fn search(&self, q: &SearchQuery) -> anyhow::Result<SearchPage> {
        let q = q.clone();
        self.read(move |c| search_sync(c, &q)).await
    }

    async fn level_counts(
        &self,
        q: &SearchQuery,
        hist: Option<HistSpec>,
    ) -> anyhow::Result<LevelCounts> {
        let q = q.clone();
        self.read(move |c| level_counts_sync(c, &q, hist)).await
    }

    async fn with_ids(
        &self,
        ids: &[String],
        since: i64,
        until: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<Line>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = ids.to_vec();
        self.read(move |c| with_ids_sync(c, &ids, since, until, limit))
            .await
    }

    async fn line(&self, id: u64) -> anyhow::Result<Option<Line>> {
        // Not yet committed lines are still in the ring.
        if let Some(l) = self.ring.line(id).await? {
            return Ok(Some(l));
        }
        self.read(move |c| {
            let tx = c.transaction()?;
            let mut hours = partitions_for(&tx, &SearchQuery::default())?;
            hours.reverse(); // newest first: the line asked for is usually recent
            for (hour, _) in hours {
                let found = tx
                    .prepare_cached(&format!(
                        "SELECT id, ts, received, source, level, raw FROM {} WHERE id = ?",
                        t('l', hour)
                    ))?
                    .query_row([id as i64], row_to_line)
                    .optional()?;
                if found.is_some() {
                    return Ok(found);
                }
            }
            Ok(None)
        })
        .await
    }

    async fn similar_ids(
        &self,
        value: &str,
        since: i64,
        until: i64,
        limit: usize,
    ) -> anyhow::Result<Vec<(CorrId, u64)>> {
        let Some(prefix) = similar_prefix(value) else {
            return Ok(Vec::new());
        };
        let value = value.to_string();
        self.read(move |c| {
            let tx = c.transaction()?;
            let q = SearchQuery {
                since: Some(since),
                until: Some(until),
                ..Default::default()
            };
            // `value >= prefix AND value < prefix + U+10FFFF` is a range on the index.
            let hi = format!("{prefix}\u{10FFFF}");
            let mut found = Vec::new();
            for (hour, _) in partitions_for(&tx, &q)? {
                let mut st = tx.prepare_cached(&format!(
                    "SELECT value, key, MAX(line_id) FROM {} WHERE value >= ? AND value < ?
                     GROUP BY value, key LIMIT 50",
                    t('i', hour)
                ))?;
                let rows = st.query_map(params![prefix, hi], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?;
                for row in rows {
                    let (v, key, line_id) = row?;
                    if let Some(key) = id_key(key) {
                        found.push((CorrId { key, value: v }, line_id as u64));
                    }
                }
            }
            Ok(rank_similar(&value, found, limit))
        })
        .await
    }

    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64> {
        self.ring.expire(cutoff).await?;
        self.ask(|tx| Msg::Expire(cutoff, tx)).await?
    }

    async fn enforce_cap(&self, max_bytes: u64) -> anyhow::Result<u64> {
        self.ask(|tx| Msg::Cap(max_bytes, tx)).await?
    }

    async fn expire_source(&self, source: &str, cutoff: i64) -> anyhow::Result<u64> {
        self.ring.expire_source_sync(source, cutoff);
        let source = source.to_string();
        self.ask(|tx| Msg::ExpireSource(source, cutoff, tx)).await?
    }

    async fn purge(&self, source: Option<&str>) -> anyhow::Result<u64> {
        match source {
            Some(s) => {
                self.ring.remove_source(s);
                let s = s.to_string();
                self.ask(|tx| Msg::ExpireSource(s, i64::MAX, tx)).await?
            }
            None => {
                self.ring.clear();
                self.ask(Msg::PurgeAll).await?
            }
        }
    }

    fn health(&self) -> StoreHealth {
        self.health.lock().unwrap().clone()
    }

    async fn storage(&self) -> anyhow::Result<StorageUsage> {
        self.read(|c| {
            let mut st = c.prepare("SELECT hour, lines, bytes FROM partitions ORDER BY hour")?;
            let hours = st
                .query_map([], |r| {
                    Ok(HourUsage {
                        start: r.get::<_, i64>(0)? * HOUR,
                        lines: r.get::<_, i64>(1)?.max(0) as u64,
                        bytes: r.get::<_, i64>(2)?.max(0) as u64,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut st = c.prepare(
                "SELECT source, SUM(lines), SUM(bytes) FROM source_hours
                 GROUP BY source HAVING SUM(lines) > 0 ORDER BY SUM(bytes) DESC",
            )?;
            let sources = st
                .query_map([], |r| {
                    Ok(SourceUsage {
                        source: r.get(0)?,
                        lines: r.get::<_, i64>(1)?.max(0) as u64,
                        bytes: r.get::<_, i64>(2)?.max(0) as u64,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(StorageUsage { hours, sources })
        })
        .await
    }

    async fn flush(&self) -> anyhow::Result<()> {
        self.ask(Msg::Flush).await
    }

    async fn restore(&self) -> anyhow::Result<Restored> {
        self.read(|c| {
            let last_id: i64 = c
                .query_row("SELECT v FROM meta WHERE k = 'last_id'", [], |r| r.get(0))
                .optional()?
                .unwrap_or(0);
            let mut st = c.prepare("SELECT name, kind, lines, last_ts FROM sources")?;
            let sources = st
                .query_map([], |r| {
                    let kind: String = r.get(1)?;
                    Ok(StoredSource {
                        name: r.get(0)?,
                        kind: SourceKind::parse(&kind),
                        lines: r.get::<_, i64>(2)? as u64,
                        last_ts: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Restored {
                last_id: last_id as u64,
                sources,
            })
        })
        .await
    }

    async fn usage(&self) -> anyhow::Result<Usage> {
        self.read(|c| {
            let (lines, oldest): (i64, Option<i64>) = c.query_row(
                "SELECT COALESCE(SUM(lines), 0), MIN(min_ts) FROM partitions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(Usage {
                bytes: used_bytes(c)?,
                lines: lines as u64,
                oldest,
            })
        })
        .await
    }
}

/// Bytes the database really uses (pages minus the free list) plus the WAL.
fn used_bytes(c: &Connection) -> anyhow::Result<u64> {
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let free: i64 = c.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    let size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    let wal = c
        .path()
        .and_then(|p| std::fs::metadata(format!("{p}-wal")).ok())
        .map_or(0, |m| m.len());
    Ok(((pages - free).max(0) * size) as u64 + wal)
}

fn hour_of(line: &Line) -> i64 {
    let ts = if (line.ts - line.received).abs() <= MAX_SKEW {
        line.ts
    } else {
        line.received
    };
    ts.div_euclid(HOUR)
}

/// Table names are generated from an integer, never from input.
fn t(prefix: char, hour: i64) -> String {
    format!("\"{prefix}_{hour}\"")
}

struct Writer {
    conn: Connection,
    known: HashSet<i64>,
    health: Arc<Mutex<StoreHealth>>,
}

impl Writer {
    fn new(conn: Connection, health: Arc<Mutex<StoreHealth>>) -> Self {
        let known = conn
            .prepare("SELECT hour FROM partitions")
            .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect())
            .unwrap_or_default();
        Writer {
            conn,
            known,
            health,
        }
    }

    /// Databases from before slice 6 have no per-source volume table: count
    /// it once from the stored hours.
    fn backfill_source_hours(&mut self) -> anyhow::Result<()> {
        let have: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM source_hours", [], |r| r.get(0))?;
        if have > 0 || self.known.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        for h in &self.known {
            tx.execute(
                &format!(
                    "INSERT OR REPLACE INTO source_hours (hour, source, lines, bytes)
                     SELECT {h}, source, COUNT(*), SUM(length(CAST(raw AS BLOB))) FROM {}
                     GROUP BY source",
                    t('l', *h)
                ),
                [],
            )?;
        }
        tx.commit()?;
        tracing::info!(
            hours = self.known.len(),
            "counted per-source volume for existing hours"
        );
        Ok(())
    }

    fn failed(&self, e: &anyhow::Error) {
        let mut h = self.health.lock().unwrap();
        h.write_errors += 1;
        h.last_error = Some((chrono::Utc::now().timestamp_millis(), e.to_string()));
    }

    fn run(mut self, mut rx: mpsc::Receiver<Msg>) {
        while let Some(first) = rx.blocking_recv() {
            let mut batch: Vec<(SourceKind, Vec<Line>)> = Vec::new();
            let mut n = 0;
            let mut next = Some(first);
            // Coalesce every queued Lines message; stop at anything else so
            // it runs after the lines queued before it.
            while let Some(Msg::Lines(kind, lines)) = next {
                n += lines.len();
                batch.push((kind, lines));
                next = if n < WRITE_BATCH {
                    rx.try_recv().ok()
                } else {
                    None
                };
            }
            if !batch.is_empty() {
                if let Err(e) = self.write(&batch) {
                    tracing::error!(error = %e, lines = n, "sqlite write failed");
                    self.failed(&e);
                }
            }
            match next {
                Some(Msg::Flush(done)) => {
                    let _ = done.send(());
                }
                Some(Msg::Expire(cutoff, done)) => {
                    let _ = done.send(self.expire(cutoff));
                }
                Some(Msg::Cap(max, done)) => {
                    let _ = done.send(self.cap(max));
                }
                Some(Msg::ExpireSource(source, cutoff, done)) => {
                    let _ = done.send(self.expire_source(&source, cutoff));
                }
                Some(Msg::PurgeAll(done)) => {
                    let _ = done.send(self.purge_all());
                }
                Some(Msg::Lines(..)) | None => {}
            }
        }
        // Channel closed: everything sent has been written. Fold the WAL back.
        let _ = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    fn ensure_partition(&mut self, hour: i64) -> anyhow::Result<()> {
        if self.known.contains(&hour) {
            return Ok(());
        }
        let (l, f, i) = (t('l', hour), t('f', hour), t('i', hour));
        self.conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {l} (
                 id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, received INTEGER NOT NULL,
                 source TEXT NOT NULL, level INTEGER, raw TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS \"l_{hour}_ts\" ON {l} (ts);
             CREATE INDEX IF NOT EXISTS \"l_{hour}_src\" ON {l} (source, ts);
             CREATE VIRTUAL TABLE IF NOT EXISTS {f} USING fts5 (raw, content='');
             CREATE TABLE IF NOT EXISTS {i} (value TEXT NOT NULL, key INTEGER NOT NULL, line_id INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS \"i_{hour}_v\" ON {i} (value);
             INSERT OR IGNORE INTO partitions (hour) VALUES ({hour});"
        ))?;
        self.known.insert(hour);
        Ok(())
    }

    fn write(&mut self, batch: &[(SourceKind, Vec<Line>)]) -> anyhow::Result<()> {
        for hour in batch
            .iter()
            .flat_map(|(_, ls)| ls.iter().map(hour_of))
            .collect::<HashSet<_>>()
        {
            self.ensure_partition(hour)?;
        }
        let tx = self.conn.transaction()?;
        // (lines, bytes, min_ts, max_ts) per hour; (kind, lines, last_ts) per source.
        let mut parts: HashMap<i64, (i64, i64, i64, i64)> = HashMap::new();
        let mut srcs: HashMap<&str, (SourceKind, i64, i64)> = HashMap::new();
        let mut per: HashMap<(i64, &str), (i64, i64)> = HashMap::new();
        let mut last_id = 0u64;
        for (kind, lines) in batch {
            for line in lines {
                let h = hour_of(line);
                tx.prepare_cached(&format!(
                    "INSERT INTO {} (id, ts, received, source, level, raw) VALUES (?, ?, ?, ?, ?, ?)",
                    t('l', h)
                ))?
                .execute(params![
                    line.id as i64,
                    line.ts,
                    line.received,
                    line.source,
                    line.level.map(|l| l as u8 as i64),
                    line.raw
                ])?;
                tx.prepare_cached(&format!(
                    "INSERT INTO {} (rowid, raw) VALUES (?, ?)",
                    t('f', h)
                ))?
                .execute(params![line.id as i64, line.raw])?;
                if !line.ids.is_empty() {
                    let mut st = tx.prepare_cached(&format!(
                        "INSERT INTO {} (value, key, line_id) VALUES (?, ?, ?)",
                        t('i', h)
                    ))?;
                    for id in &line.ids {
                        st.execute(params![id.value, id.key as u8 as i64, line.id as i64])?;
                    }
                }
                let p = parts.entry(h).or_insert((0, 0, i64::MAX, i64::MIN));
                p.0 += 1;
                p.1 += line.raw.len() as i64;
                p.2 = p.2.min(line.ts);
                p.3 = p.3.max(line.ts);
                let ph = per.entry((h, &line.source)).or_insert((0, 0));
                ph.0 += 1;
                ph.1 += line.raw.len() as i64;
                let s = srcs.entry(&line.source).or_insert((*kind, 0, i64::MIN));
                s.1 += 1;
                s.2 = s.2.max(line.ts);
                last_id = last_id.max(line.id);
            }
        }
        for (h, (n, bytes, lo, hi)) in parts {
            tx.prepare_cached(
                "UPDATE partitions SET lines = lines + ?, bytes = bytes + ?,
                     min_ts = MIN(COALESCE(min_ts, ?3), ?3), max_ts = MAX(COALESCE(max_ts, ?4), ?4)
                 WHERE hour = ?5",
            )?
            .execute(params![n, bytes, lo, hi, h])?;
        }
        for ((h, name), (n, bytes)) in per {
            tx.prepare_cached(
                "INSERT INTO source_hours (hour, source, lines, bytes) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (hour, source) DO UPDATE SET lines = lines + ?3, bytes = bytes + ?4",
            )?
            .execute(params![h, name, n, bytes])?;
        }
        for (name, (kind, n, last)) in srcs {
            let kind = kind.as_str();
            tx.prepare_cached(
                "INSERT INTO sources (name, kind, lines, last_ts) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (name) DO UPDATE SET lines = lines + ?3,
                     last_ts = MAX(COALESCE(last_ts, ?4), ?4)",
            )?
            .execute(params![name, kind, n, last])?;
        }
        tx.prepare_cached(
            "INSERT INTO meta (k, v) VALUES ('last_id', ?1)
             ON CONFLICT (k) DO UPDATE SET v = MAX(v, ?1)",
        )?
        .execute(params![last_id as i64])?;
        tx.commit()?;
        Ok(())
    }

    fn drop_hour(&mut self, hour: i64) -> anyhow::Result<u64> {
        let tx = self.conn.transaction()?;
        // Source counts follow what is still stored.
        let per_source: Vec<(String, i64)> = {
            let mut st = tx.prepare(&format!(
                "SELECT source, COUNT(*) FROM {} GROUP BY source",
                t('l', hour)
            ))?;
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            v
        };
        for (name, n) in &per_source {
            tx.execute(
                "UPDATE sources SET lines = MAX(0, lines - ?) WHERE name = ?",
                params![n, name],
            )?;
        }
        tx.execute_batch(&format!(
            "DROP TABLE IF EXISTS {}; DROP TABLE IF EXISTS {}; DROP TABLE IF EXISTS {};
             DELETE FROM partitions WHERE hour = {hour};
             DELETE FROM source_hours WHERE hour = {hour};",
            t('f', hour),
            t('l', hour),
            t('i', hour)
        ))?;
        tx.commit()?;
        self.known.remove(&hour);
        Ok(per_source.iter().map(|(_, n)| *n as u64).sum())
    }

    fn hours(&self) -> anyhow::Result<Vec<i64>> {
        let mut st = self
            .conn
            .prepare("SELECT hour FROM partitions ORDER BY hour")?;
        let v = st
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<i64>, _>>()?;
        Ok(v)
    }

    fn reclaim(&self) {
        let _ = self
            .conn
            .execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
    }

    /// Drop every hour that ends at or before `cutoff`.
    fn expire(&mut self, cutoff: i64) -> anyhow::Result<u64> {
        let mut dropped = 0;
        for h in self.hours()? {
            if (h + 1) * HOUR <= cutoff {
                dropped += self.drop_hour(h)?;
            }
        }
        if dropped > 0 {
            self.reclaim();
        }
        Ok(dropped)
    }

    /// Delete one source's lines older than `cutoff` from every hour that can
    /// hold them (FTS rows need the original text to be deleted from a
    /// contentless index). An hour left empty is dropped whole.
    fn expire_source(&mut self, source: &str, cutoff: i64) -> anyhow::Result<u64> {
        let mut dropped = 0u64;
        for h in self.hours()? {
            if cutoff != i64::MAX && h * HOUR - MAX_SKEW > cutoff {
                break;
            }
            let (l, f, i) = (t('l', h), t('f', h), t('i', h));
            let tx = self.conn.transaction()?;
            let gone: Vec<(i64, String)> = {
                let mut st = tx.prepare(&format!(
                    "SELECT id, raw FROM {l} WHERE source = ? AND ts < ?"
                ))?;
                let v = st
                    .query_map(params![source, cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?;
                v
            };
            if gone.is_empty() {
                continue;
            }
            let fname = format!("f_{h}");
            for (id, raw) in &gone {
                tx.prepare_cached(&format!(
                    "INSERT INTO {f} (\"{fname}\", rowid, raw) VALUES ('delete', ?, ?)"
                ))?
                .execute(params![id, raw])?;
            }
            tx.execute(
                &format!(
                    "DELETE FROM {i} WHERE line_id IN (SELECT id FROM {l} WHERE source = ? AND ts < ?)"
                ),
                params![source, cutoff],
            )?;
            tx.execute(
                &format!("DELETE FROM {l} WHERE source = ? AND ts < ?"),
                params![source, cutoff],
            )?;
            let n = gone.len() as i64;
            let bytes: i64 = gone.iter().map(|(_, r)| r.len() as i64).sum();
            tx.execute(
                "UPDATE partitions SET lines = MAX(0, lines - ?), bytes = MAX(0, bytes - ?) WHERE hour = ?",
                params![n, bytes, h],
            )?;
            tx.execute(
                "UPDATE source_hours SET lines = MAX(0, lines - ?), bytes = MAX(0, bytes - ?)
                 WHERE hour = ? AND source = ?",
                params![n, bytes, h, source],
            )?;
            tx.execute(
                "UPDATE sources SET lines = MAX(0, lines - ?) WHERE name = ?",
                params![n, source],
            )?;
            let left: i64 =
                tx.query_row("SELECT lines FROM partitions WHERE hour = ?", [h], |r| {
                    r.get(0)
                })?;
            tx.commit()?;
            if left == 0 {
                self.drop_hour(h)?;
            }
            dropped += n as u64;
        }
        if dropped > 0 {
            self.reclaim();
        }
        Ok(dropped)
    }

    /// Purge: every hour goes, the newest too.
    fn purge_all(&mut self) -> anyhow::Result<u64> {
        let mut dropped = 0;
        for h in self.hours()? {
            dropped += self.drop_hour(h)?;
        }
        self.reclaim();
        Ok(dropped)
    }

    /// Drop the oldest hours until under `max` bytes; the newest hour stays.
    fn cap(&mut self, max: u64) -> anyhow::Result<u64> {
        let mut dropped = 0;
        let hours = self.hours()?;
        for h in hours.iter().take(hours.len().saturating_sub(1)) {
            if used_bytes(&self.conn)? <= max {
                break;
            }
            dropped += self.drop_hour(*h)?;
            self.reclaim();
        }
        Ok(dropped)
    }
}

/// Partitions overlapping the query's time range (and cursor), in walk order,
/// with their line counts.
fn partitions_for(c: &Connection, q: &SearchQuery) -> anyhow::Result<Vec<(i64, i64)>> {
    let mut st = c.prepare("SELECT hour, lines FROM partitions ORDER BY hour")?;
    let mut v: Vec<(i64, i64)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    // Lines filed by arrival (bad clocks) can sit outside their hour, so the
    // time bounds only prune by whole hours with a skew margin.
    v.retain(|(h, _)| {
        let (lo, hi) = (h * HOUR - MAX_SKEW, (h + 1) * HOUR + MAX_SKEW);
        q.since.is_none_or(|s| hi > s) && q.until.is_none_or(|u| lo <= u)
    });
    if q.order == Order::Newest {
        v.reverse();
    }
    Ok(v)
}

/// Per-level counts in SQL (`GROUP BY`), so a day of lines never leaves SQLite.
fn level_counts_sync(
    c: &mut Connection,
    q: &SearchQuery,
    hist: Option<HistSpec>,
) -> anyhow::Result<LevelCounts> {
    let tx = c.transaction()?;
    let mut out = LevelCounts::default();
    if let Some((since, w, n)) = hist {
        out.histogram = empty_histogram(since, w, n);
    }
    for (hour, _) in partitions_for(&tx, q)? {
        let mut sql = format!("SELECT level, count(*) FROM {} WHERE 1", t('l', hour));
        let mut args = Vec::new();
        filters(q, hour, &mut sql, &mut args);
        sql.push_str(" GROUP BY level");
        let mut st = tx.prepare(&sql)?;
        let mut rows = st.query(params_from_iter(args))?;
        while let Some(r) = rows.next()? {
            let level: Option<i64> = r.get(0)?;
            let n: i64 = r.get(1)?;
            out.by_rank[level.and_then(Level::from_rank).map_or(6, |l| l as usize)] += n as u64;
        }
        if let Some((since, w, n)) = hist {
            let (lo, hi) = (hour * HOUR - MAX_SKEW, (hour + 1) * HOUR + MAX_SKEW);
            let end = since + w * n as i64;
            if hi <= since || lo >= end {
                continue;
            }
            let mut sql = format!(
                "SELECT (ts - ?) / ?, level, count(*) FROM {} WHERE ts >= ? AND ts < ?",
                t('l', hour)
            );
            let mut args: Vec<SqlValue> = vec![since.into(), w.into(), since.into(), end.into()];
            filters(q, hour, &mut sql, &mut args);
            sql.push_str(" GROUP BY 1, 2");
            let mut st = tx.prepare(&sql)?;
            let mut rows = st.query(params_from_iter(args))?;
            while let Some(r) = rows.next()? {
                let i: i64 = r.get(0)?;
                let level: Option<i64> = r.get(1)?;
                let k: i64 = r.get(2)?;
                let Some(b) = out.histogram.get_mut(i.max(0) as usize) else {
                    continue;
                };
                b.count += k as u64;
                match level.and_then(Level::from_rank) {
                    Some(Level::Trace | Level::Debug) => b.debug += k as u64,
                    Some(Level::Info) => b.info += k as u64,
                    Some(Level::Warn) => b.warn += k as u64,
                    Some(Level::Error | Level::Fatal) => b.error += k as u64,
                    None => {}
                }
            }
        }
    }
    tx.commit()?;
    Ok(out)
}

/// The WHERE clause shared by the page and the histogram, minus the cursor.
fn filters(q: &SearchQuery, hour: i64, sql: &mut String, args: &mut Vec<SqlValue>) {
    if let Some(s) = q.since {
        sql.push_str(" AND ts >= ?");
        args.push(s.into());
    }
    if let Some(u) = q.until {
        sql.push_str(" AND ts <= ?");
        args.push(u.into());
    }
    if !q.sources.is_empty() {
        sql.push_str(&format!(
            " AND source IN ({})",
            vec!["?"; q.sources.len()].join(",")
        ));
        args.extend(q.sources.iter().map(|s| SqlValue::from(s.clone())));
    }
    if let Some(l) = q.min_level {
        sql.push_str(" AND level >= ?");
        args.push((l as u8 as i64).into());
    }
    if !q.levels.is_empty() {
        let ranks: Vec<i64> = q
            .levels
            .iter()
            .flat_map(|l| crate::search::chip_ranks(*l).iter().copied())
            .collect();
        sql.push_str(&format!(
            " AND level IN ({})",
            vec!["?"; ranks.len()].join(",")
        ));
        args.extend(ranks.into_iter().map(SqlValue::from));
    }
    if !q.ids.is_empty() {
        sql.push_str(&format!(
            " AND id IN (SELECT line_id FROM {} WHERE value IN ({}))",
            t('i', hour),
            vec!["?"; q.ids.len()].join(",")
        ));
        args.extend(q.ids.iter().map(|s| SqlValue::from(s.clone())));
    }
    let (fts, plain): (Vec<&String>, Vec<&String>) = q
        .text
        .iter()
        .partition(|w| w.chars().any(char::is_alphanumeric));
    if !fts.is_empty() {
        sql.push_str(&format!(
            " AND id IN (SELECT rowid FROM {f} WHERE {f} MATCH ?)",
            f = t('f', hour)
        ));
        args.push(fts_and(&fts).into());
    }
    for w in plain {
        sql.push_str(" AND instr(lower(raw), lower(?)) > 0");
        args.push(w.clone().into());
    }
    let (not_fts, not_plain): (Vec<&String>, Vec<&String>) = q
        .not_text
        .iter()
        .partition(|w| w.chars().any(char::is_alphanumeric));
    if !not_fts.is_empty() {
        sql.push_str(&format!(
            " AND id NOT IN (SELECT rowid FROM {f} WHERE {f} MATCH ?)",
            f = t('f', hour)
        ));
        args.push(
            not_fts
                .iter()
                .map(|w| fts_term(w))
                .collect::<Vec<_>>()
                .join(" OR ")
                .into(),
        );
    }
    for w in not_plain {
        sql.push_str(" AND instr(lower(raw), lower(?)) = 0");
        args.push(w.clone().into());
    }
    for f in &q.fields {
        // The whole key first (`log.level`), then as a path (`err.code`).
        let mut paths = vec![json_path(&[f.key.as_str()])];
        if f.key.contains('.') {
            paths.push(json_path(&f.key.split('.').collect::<Vec<_>>()));
        }
        let extract = paths
            .iter()
            .map(|_| "json_extract(raw, ?)")
            .collect::<Vec<_>>()
            .join(", ");
        let value = if paths.len() > 1 {
            format!("COALESCE({extract})")
        } else {
            extract
        };
        // CASE, not AND: json_extract raises on a plain-text line, and only
        // CASE is guaranteed not to evaluate it.
        use crate::search::Op;
        let (cast, cmp, arg): (&str, &str, SqlValue) = match f.op {
            Op::Eq => ("TEXT", "= ?", f.value.clone().into()),
            Op::Prefix => (
                "TEXT",
                "LIKE ? ESCAPE '\\'",
                format!(
                    "{}%",
                    f.value
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                )
                .into(),
            ),
            op => {
                let n: f64 = f.value.parse().unwrap_or(f64::NAN);
                let c = match op {
                    Op::Gt => "> ?",
                    Op::Ge => ">= ?",
                    Op::Lt => "< ?",
                    _ => "<= ?",
                };
                ("REAL", c, n.into())
            }
        };
        // Numbers only compare when the field holds one (a text "abc" is not 0).
        let numeric = if cast == "REAL" {
            format!(" AND typeof({value}) IN ('integer','real')")
        } else {
            String::new()
        };
        sql.push_str(&format!(
            " AND {}COALESCE(CASE WHEN json_valid(raw){numeric} THEN CAST({value} AS {cast}) {cmp} END, 0)",
            if f.negate { "NOT " } else { "" }
        ));
        args.extend(paths.iter().cloned().map(SqlValue::from));
        if cast == "REAL" {
            args.extend(paths.into_iter().map(SqlValue::from));
        }
        args.push(arg);
    }
}

fn json_path(segments: &[&str]) -> String {
    let mut p = String::from("$");
    for s in segments {
        p.push_str(&format!(".\"{}\"", s.replace('"', "\"\"")));
    }
    p
}

/// One FTS5 term: a quoted phrase, and a prefix when it's a single word.
fn fts_term(w: &str) -> String {
    let quoted = format!("\"{}\"", w.replace('"', "\"\""));
    if w.chars().any(char::is_whitespace) {
        quoted
    } else {
        format!("{quoted}*")
    }
}

fn fts_and(words: &[&String]) -> String {
    words
        .iter()
        .map(|w| fts_term(w))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn row_to_line(r: &rusqlite::Row) -> rusqlite::Result<Line> {
    let id: i64 = r.get(0)?;
    let ts: i64 = r.get(1)?;
    let received: i64 = r.get(2)?;
    let source: String = r.get(3)?;
    let level: Option<i64> = r.get(4)?;
    let raw: String = r.get(5)?;
    // Re-derive fields/ids/summary from the raw line; keep what was stored.
    let mut line = normalize(&raw, &source, Some(ts), received);
    line.id = id as u64;
    line.ts = ts;
    line.level = level.and_then(Level::from_rank);
    line.flags.retain(|f| f != "ts:collector");
    Ok(Arc::new(line))
}

fn id_key(n: i64) -> Option<IdKey> {
    Some(match n {
        0 => IdKey::RequestId,
        1 => IdKey::JobId,
        2 => IdKey::TraceId,
        3 => IdKey::CorrelationId,
        _ => return None,
    })
}

/// Lines carrying any of `ids`: an index lookup per hour (`i_h.value`), then
/// rowid fetches. No ORDER BY in SQL, so SQLite never walks the ts index;
/// the (small) result is sorted here.
fn with_ids_sync(
    c: &mut Connection,
    ids: &[String],
    since: i64,
    until: i64,
    limit: usize,
) -> anyhow::Result<Vec<Line>> {
    let tx = c.transaction()?;
    let q = SearchQuery {
        since: Some(since),
        until: Some(until),
        ..Default::default()
    };
    let marks = vec!["?"; ids.len()].join(",");
    let mut out: Vec<Line> = Vec::new();
    for (hour, _) in partitions_for(&tx, &q)? {
        let sql = format!(
            "SELECT id, ts, received, source, level, raw FROM {l}
             WHERE id IN (SELECT line_id FROM {i} WHERE value IN ({marks}))
               AND ts >= ? AND ts <= ? LIMIT ?",
            l = t('l', hour),
            i = t('i', hour),
        );
        let mut args: Vec<SqlValue> = ids.iter().map(|s| SqlValue::from(s.clone())).collect();
        args.push(since.into());
        args.push(until.into());
        args.push(((limit + 1).saturating_sub(out.len()) as i64).into());
        let mut st = tx.prepare_cached(&sql)?;
        let got = st
            .query_map(params_from_iter(args), row_to_line)?
            .collect::<Result<Vec<_>, _>>()?;
        out.extend(got);
        if out.len() > limit {
            break;
        }
    }
    out.sort_by_key(|l| (l.ts, l.id));
    out.truncate(limit);
    Ok(out)
}

fn search_sync(c: &mut Connection, q: &SearchQuery) -> anyhow::Result<SearchPage> {
    let tx = c.transaction()?; // one snapshot for the whole search
    let parts = partitions_for(&tx, q)?;
    let limit = q.limit.max(1);
    let mut page = SearchPage {
        searched: parts.iter().map(|(_, n)| *n as u64).sum(),
        ..Default::default()
    };
    let dir = if q.order == Order::Newest {
        "DESC"
    } else {
        "ASC"
    };

    let mut lines: Vec<Line> = Vec::new();
    for (hour, _) in &parts {
        if lines.len() > limit {
            break;
        }
        if let Some(c) = q.cursor {
            // Skip whole hours already behind the cursor (with skew margin).
            let (lo, hi) = (hour * HOUR - MAX_SKEW, (hour + 1) * HOUR + MAX_SKEW);
            let behind = match q.order {
                Order::Newest => lo > c.ts,
                Order::Oldest => hi < c.ts,
            };
            if behind {
                continue;
            }
        }
        let mut sql = format!(
            "SELECT id, ts, received, source, level, raw FROM {} WHERE 1",
            t('l', *hour)
        );
        let mut args: Vec<SqlValue> = Vec::new();
        filters(q, *hour, &mut sql, &mut args);
        if let Some(c) = q.cursor {
            sql.push_str(if q.order == Order::Newest {
                " AND (ts, id) < (?, ?)"
            } else {
                " AND (ts, id) > (?, ?)"
            });
            args.push(c.ts.into());
            args.push((c.id as i64).into());
        }
        sql.push_str(&format!(" ORDER BY ts {dir}, id {dir} LIMIT ?"));
        args.push(((limit + 1 - lines.len()) as i64).into());
        let mut st = tx.prepare(&sql)?;
        let got = st
            .query_map(params_from_iter(args), row_to_line)?
            .collect::<Result<Vec<_>, _>>()?;
        lines.extend(got);
    }
    // Hours are walked in order, but a skewed line can sit in a neighbour.
    lines.sort_by_key(|l| (l.ts, l.id));
    if q.order == Order::Newest {
        lines.reverse();
    }
    if lines.len() > limit {
        lines.truncate(limit);
        page.next_cursor = lines.last().map(Cursor::of);
    }
    page.lines = lines;

    if q.cursor.is_none() {
        if let (Some(n), Some(since), Some(until)) = (q.histogram, q.since, q.until) {
            let w = bucket_width(since, until, n);
            let mut h = empty_histogram(since, w, n);
            let (mut total, mut bytes) = (0u64, 0u64);
            for (hour, _) in &parts {
                let mut sql = format!(
                    "SELECT ts, level, length(raw) FROM {} WHERE 1",
                    t('l', *hour)
                );
                let mut args = Vec::new();
                filters(q, *hour, &mut sql, &mut args);
                let mut st = tx.prepare(&sql)?;
                let mut rows = st.query(params_from_iter(args))?;
                while let Some(r) = rows.next()? {
                    let ts: i64 = r.get(0)?;
                    let level: Option<i64> = r.get(1)?;
                    let len: i64 = r.get(2)?;
                    add_to_histogram(&mut h, since, w, ts, level.and_then(Level::from_rank));
                    total += 1;
                    bytes += len as u64;
                }
            }
            page.total = Some(total);
            page.bytes = Some(bytes);
            page.histogram = Some(h);
        }
    }
    tx.commit()?;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quiet-sqlite-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("quiet.db")
    }

    fn open(path: &std::path::Path) -> SqliteStore {
        SqliteStore::open(SqliteOptions {
            path: path.to_path_buf(),
            ring: 100,
            ring_memory: crate::store::DEFAULT_RING_MEMORY,
        })
        .unwrap()
    }

    fn line(id: u64, source: &str, raw: &str, ts: i64) -> Line {
        let mut l = normalize(raw, source, None, ts);
        l.id = id;
        Arc::new(l)
    }

    fn q(s: &str) -> SearchQuery {
        SearchQuery {
            limit: 100,
            ..Default::default()
        }
        .parse_q(s)
    }

    const T0: i64 = 1_792_000_000_000; // some hour in 2026

    async fn fixture(s: &SqliteStore) {
        s.append(
            SourceKind::Docker,
            &[
                line(
                    1,
                    "api",
                    r#"{"level":40,"msg":"GET /api/v1/dealers/88/payouts slow","request_id":"req_1","status":200,"duration_ms":1912}"#,
                    T0,
                ),
                line(
                    2,
                    "api",
                    r#"{"level":30,"msg":"GET /api/v1/health","request_id":"req_2","path":"/api/v1/health","status":200}"#,
                    T0 + 1_000,
                ),
                line(3, "api", "plain text ERROR boom", T0 + 2_000),
            ],
        )
        .await
        .unwrap();
        s.append(
            SourceKind::Http,
            &[
                line(
                    4,
                    "worker",
                    r#"{"level":50,"msg":"settle_dealer_payout failed","job_id":"payout:88:1300","data":{"request_id":"req_1"},"err":{"code":"TRANSFER_TIMEOUT"}}"#,
                    T0 + HOUR + 5,
                ),
                line(
                    5,
                    "worker",
                    r#"{"level":40,"msg":"settle_dealer_payout timeout","job_id":"payout:88:1300","attempt":0}"#,
                    T0 + HOUR + 10,
                ),
            ],
        )
        .await
        .unwrap();
        s.flush().await.unwrap();
    }

    fn ids(p: &SearchPage) -> Vec<u64> {
        p.lines.iter().map(|l| l.id).collect()
    }

    #[tokio::test]
    async fn full_text_fields_ids_and_levels() {
        let path = tmp();
        let s = open(&path);
        fixture(&s).await;

        assert_eq!(
            ids(&s.search(&q("dealer 88")).await.unwrap()),
            vec![5, 4, 1]
        );
        assert_eq!(
            ids(&s.search(&q("dealer level:error")).await.unwrap()),
            vec![4]
        );
        assert_eq!(
            ids(&s.search(&q("request_id:req_1")).await.unwrap()),
            vec![4, 1]
        );
        assert_eq!(
            ids(&s.search(&q("err.code:TRANSFER_TIMEOUT")).await.unwrap()),
            vec![4]
        );
        assert_eq!(
            ids(&s
                .search(&q("status:200 -path:/api/v1/health"))
                .await
                .unwrap()),
            vec![1]
        );
        assert_eq!(
            ids(&s.search(&q("source:api -slow -health")).await.unwrap()),
            vec![3]
        );
        assert_eq!(ids(&s.search(&q("boom")).await.unwrap()), vec![3]);
        assert_eq!(
            ids(&s
                .search(&q("\"settle_dealer_payout failed\""))
                .await
                .unwrap()),
            vec![4]
        );
        assert!(s.search(&q("nothing_here")).await.unwrap().lines.is_empty());
        // Lines come back whole: fields and ids are re-derived from raw.
        let l = &s
            .search(&q("id:payout:88:1300 attempt:0"))
            .await
            .unwrap()
            .lines[0];
        assert_eq!(l.id, 5);
        assert_eq!(l.display_id.as_ref().unwrap().value, "payout:88:1300");
        assert_eq!(l.fields.as_ref().unwrap()["attempt"], 0);

        // The same query on the memory store gives the same answer.
        let m = MemoryStore::new(100);
        for p in s.search(&q("")).await.unwrap().lines.iter().rev() {
            m.append(SourceKind::Http, std::slice::from_ref(p))
                .await
                .unwrap();
        }
        for query in [
            "dealer 88",
            "request_id:req_1",
            "status:200 -path:/api/v1/health",
            "level:warn",
        ] {
            assert_eq!(
                ids(&s.search(&q(query)).await.unwrap()),
                ids(&m.search(&q(query)).await.unwrap()),
                "{query}"
            );
        }
    }

    #[tokio::test]
    async fn cursor_pages_both_ways_and_histogram_counts() {
        let path = tmp();
        let s = open(&path);
        fixture(&s).await;
        let mut seen = Vec::new();
        let mut query = SearchQuery {
            limit: 2,
            ..Default::default()
        };
        loop {
            let p = s.search(&query).await.unwrap();
            seen.extend(ids(&p));
            match p.next_cursor {
                Some(c) => query.cursor = Some(c),
                None => break,
            }
        }
        assert_eq!(seen, vec![5, 4, 3, 2, 1]);

        let p = s
            .search(&SearchQuery {
                limit: 3,
                order: Order::Oldest,
                since: Some(T0 + 1),
                until: Some(T0 + HOUR + 10),
                histogram: Some(4),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(ids(&p), vec![2, 3, 4]);
        assert_eq!(p.total, Some(4));
        let h = p.histogram.unwrap();
        assert_eq!(h.iter().map(|b| b.count).sum::<u64>(), 4);
        assert_eq!(h.iter().map(|b| b.error).sum::<u64>(), 2); // text ERROR + level 50
        assert_eq!(p.searched, 5);
    }

    #[tokio::test]
    async fn survives_restart_with_ids_sources_and_backlog() {
        let path = tmp();
        {
            let s = open(&path);
            fixture(&s).await;
        }
        let s = open(&path);
        let r = s.restore().await.unwrap();
        assert_eq!(r.last_id, 5);
        let mut names: Vec<_> = r
            .sources
            .iter()
            .map(|s| (s.name.clone(), s.kind, s.lines))
            .collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            names,
            vec![
                ("api".into(), SourceKind::Docker, 3),
                ("worker".into(), SourceKind::Http, 2)
            ]
        );
        // The ring was warmed: the stream backlog works before new lines arrive.
        assert_eq!(
            s.tail("api", 10)
                .await
                .unwrap()
                .iter()
                .map(|l| l.id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[tokio::test]
    async fn retention_drops_whole_hours_and_cap_drops_oldest() {
        let path = tmp();
        let s = open(&path);
        fixture(&s).await;
        // Cutoff inside the second hour: only the first hour (3 lines) goes.
        let first_hour_end = (T0.div_euclid(HOUR) + 1) * HOUR;
        assert_eq!(s.expire(first_hour_end + 1).await.unwrap(), 3);
        assert_eq!(ids(&s.search(&q("")).await.unwrap()), vec![5, 4]);
        assert_eq!(s.expire(first_hour_end + 1).await.unwrap(), 0);

        // Cap: add a newer hour, then a tiny cap keeps only the newest hour.
        s.append(
            SourceKind::Http,
            &[line(6, "worker", "later", T0 + 3 * HOUR)],
        )
        .await
        .unwrap();
        s.flush().await.unwrap();
        let before = s.usage().await.unwrap();
        assert_eq!(before.lines, 3);
        assert_eq!(s.enforce_cap(1).await.unwrap(), 2);
        assert_eq!(ids(&s.search(&q("")).await.unwrap()), vec![6]);
        assert_eq!(s.enforce_cap(u64::MAX).await.unwrap(), 0);
        let after = s.usage().await.unwrap();
        assert_eq!(after.lines, 1);
        assert!(after.bytes > 0);
    }

    #[tokio::test]
    async fn per_source_expiry_purge_and_volume() {
        let path = tmp();
        let s = open(&path);
        fixture(&s).await;
        let u = s.storage().await.unwrap();
        assert_eq!(u.hours.len(), 2);
        assert_eq!(u.hours.iter().map(|h| h.lines).sum::<u64>(), 5);
        let api = u.sources.iter().find(|x| x.source == "api").unwrap();
        assert_eq!(api.lines, 3);
        assert!(api.bytes > 100);

        // Drop api's lines older than T0 + 1s: one line, everywhere (FTS,
        // id index, counters), the others untouched.
        assert_eq!(s.expire_source("api", T0 + 1).await.unwrap(), 1);
        assert_eq!(ids(&s.search(&q("slow")).await.unwrap()), Vec::<u64>::new());
        assert_eq!(ids(&s.search(&q("id:req_1")).await.unwrap()), vec![4]);
        assert_eq!(ids(&s.search(&q("")).await.unwrap()), vec![5, 4, 3, 2]);
        let u = s.storage().await.unwrap();
        assert_eq!(
            u.sources.iter().find(|x| x.source == "api").unwrap().lines,
            2
        );
        assert_eq!(s.usage().await.unwrap().lines, 4);

        // Purge one source: its hour empties and is dropped whole.
        assert_eq!(s.purge(Some("api")).await.unwrap(), 2);
        let u = s.storage().await.unwrap();
        assert_eq!(u.hours.len(), 1);
        assert!(u.sources.iter().all(|x| x.source != "api"));
        assert!(s.tail("api", 10).await.unwrap().is_empty());

        // Volume survives a restart and old databases get it backfilled.
        drop(s);
        {
            let c = Connection::open(&path).unwrap();
            c.execute("DELETE FROM source_hours", []).unwrap();
        }
        let s = open(&path);
        let u = s.storage().await.unwrap();
        assert_eq!(u.sources.len(), 1);
        assert_eq!(u.sources[0].lines, 2);

        // Purge everything, the newest hour included.
        assert_eq!(s.purge(None).await.unwrap(), 2);
        assert_eq!(s.usage().await.unwrap().lines, 0);
        assert!(s.search(&q("")).await.unwrap().lines.is_empty());
        assert_eq!(s.health().write_errors, 0);
    }

    #[test]
    fn skewed_clock_is_filed_by_arrival() {
        let mut l = normalize(r#"{"time":0,"msg":"1970"}"#, "a", None, T0);
        l.id = 1;
        assert_eq!(hour_of(&Arc::new(l)), T0.div_euclid(HOUR));
        assert_eq!(fts_term("dealer"), "\"dealer\"*");
        assert_eq!(fts_term("a \"b\""), "\"a \"\"b\"\"\"");
        assert_eq!(json_path(&["err", "code"]), "$.\"err\".\"code\"");
    }
}
