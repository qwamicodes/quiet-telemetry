//! What retained history knows, in `quiet.db` (never in a partition): the
//! instance id, destinations, archived hours and gaps. Search plans from
//! here, so it never lists a bucket.

use super::{DestinationKind, GapReason, HourRecord, VerifyResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

pub struct Catalog {
    db: Mutex<Connection>,
}

/// One saved destination as stored (the secret sealed).
#[derive(Debug, Clone)]
pub struct DestinationRow {
    pub id: i64,
    pub name: String,
    pub kind: DestinationKind,
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub path_style: bool,
    pub access_key_id: String,
    pub secret_enc: Vec<u8>,
    pub active: bool,
    pub verified_at: Option<i64>,
    pub last_verify: Option<VerifyResult>,
    pub created_at: i64,
}

/// Hours and bytes one destination holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Held {
    pub hours: u64,
    pub lines: u64,
    pub bytes_stored: u64,
    pub first_hour: Option<i64>,
    pub last_hour: Option<i64>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS instance (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS destinations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    endpoint TEXT, region TEXT NOT NULL DEFAULT '', bucket TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '', path_style INTEGER NOT NULL DEFAULT 0,
    access_key_id TEXT NOT NULL, secret_enc BLOB NOT NULL,
    active INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, last_verify TEXT,
    created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history_hours (
    hour INTEGER NOT NULL, destination_id INTEGER NOT NULL, key TEXT NOT NULL,
    lines INTEGER NOT NULL, bytes_raw INTEGER NOT NULL, bytes_stored INTEGER NOT NULL,
    sources TEXT NOT NULL, min_ts INTEGER, max_ts INTEGER, sha256 TEXT NOT NULL,
    archived_at INTEGER NOT NULL, PRIMARY KEY (hour, destination_id));
CREATE TABLE IF NOT EXISTS history_gaps (
    hour INTEGER PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
";

fn row(r: &rusqlite::Row) -> rusqlite::Result<DestinationRow> {
    let kind: String = r.get(2)?;
    let verify: Option<String> = r.get(12)?;
    Ok(DestinationRow {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: DestinationKind::parse(&kind).unwrap_or(DestinationKind::S3Compatible),
        endpoint: r.get(3)?,
        region: r.get(4)?,
        bucket: r.get(5)?,
        prefix: r.get(6)?,
        path_style: r.get(7)?,
        access_key_id: r.get(8)?,
        secret_enc: r.get(9)?,
        active: r.get(10)?,
        verified_at: r.get(11)?,
        last_verify: verify.and_then(|v| serde_json::from_str(&v).ok()),
        created_at: r.get(13)?,
    })
}

const COLS: &str = "id, name, kind, endpoint, region, bucket, prefix, path_style, \
                    access_key_id, secret_enc, active, verified_at, last_verify, created_at";

impl Catalog {
    pub fn open(path: Option<&Path>) -> anyhow::Result<Self> {
        let c = match path {
            Some(p) => {
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                Connection::open(p)?
            }
            None => Connection::open_in_memory()?,
        };
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        c.execute_batch(SCHEMA)?;
        Ok(Catalog { db: Mutex::new(c) })
    }

    pub fn memory() -> Self {
        Self::open(None).expect("in-memory catalog")
    }

    fn kv(&self, k: &str) -> anyhow::Result<Option<String>> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT v FROM instance WHERE k = ?", [k], |r| r.get(0))
            .optional()?)
    }

    fn set_kv(&self, k: &str, v: &str) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO instance (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = ?2",
            params![k, v],
        )?;
        Ok(())
    }

    /// A random id made on first start; object keys live under it so two
    /// servers can share a bucket.
    pub fn instance_id(&self) -> anyhow::Result<String> {
        if let Some(id) = self.kv("instance_id")? {
            return Ok(id);
        }
        let id = format!("{:016x}", rand::random::<u64>());
        // Insert-or-keep: a racing caller's id wins and both read it back.
        self.db.lock().unwrap().execute(
            "INSERT OR IGNORE INTO instance (k, v) VALUES ('instance_id', ?1)",
            [&id],
        )?;
        Ok(self.kv("instance_id")?.unwrap_or(id))
    }

    /// When a destination was first made active (history is opt-in).
    pub fn enabled_at(&self) -> anyhow::Result<Option<i64>> {
        Ok(self.kv("history_enabled_at")?.and_then(|v| v.parse().ok()))
    }

    pub fn mark_enabled(&self, now: i64) -> anyhow::Result<()> {
        if self.enabled_at()?.is_none() {
            self.set_kv("history_enabled_at", &now.to_string())?;
        }
        Ok(())
    }

    pub fn destinations(&self) -> anyhow::Result<Vec<DestinationRow>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(&format!("SELECT {COLS} FROM destinations ORDER BY id"))?;
        let v = st.query_map([], row)?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn destination(&self, id: i64) -> anyhow::Result<Option<DestinationRow>> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .query_row(
                &format!("SELECT {COLS} FROM destinations WHERE id = ?"),
                [id],
                row,
            )
            .optional()?)
    }

    pub fn active(&self) -> anyhow::Result<Option<DestinationRow>> {
        Ok(self.destinations()?.into_iter().find(|d| d.active))
    }

    pub fn insert(&self, d: &DestinationRow) -> anyhow::Result<i64> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO destinations (name, kind, endpoint, region, bucket, prefix, path_style,
                 access_key_id, secret_enc, active, verified_at, last_verify, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, NULL, ?10)",
            params![
                d.name,
                d.kind.as_str(),
                d.endpoint,
                d.region,
                d.bucket,
                d.prefix,
                d.path_style,
                d.access_key_id,
                d.secret_enc,
                d.created_at
            ],
        )?;
        Ok(db.last_insert_rowid())
    }

    pub fn update(&self, d: &DestinationRow) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute(
            "UPDATE destinations SET name = ?2, endpoint = ?3, region = ?4, bucket = ?5,
                 prefix = ?6, path_style = ?7, access_key_id = ?8, secret_enc = ?9
             WHERE id = ?1",
            params![
                d.id,
                d.name,
                d.endpoint,
                d.region,
                d.bucket,
                d.prefix,
                d.path_style,
                d.access_key_id,
                d.secret_enc
            ],
        )?;
        Ok(())
    }

    pub fn set_verify(&self, id: i64, v: &VerifyResult) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute(
            "UPDATE destinations SET last_verify = ?2,
                 verified_at = CASE WHEN ?3 THEN ?4 ELSE verified_at END
             WHERE id = ?1",
            params![id, serde_json::to_string(v)?, v.ok, v.at],
        )?;
        Ok(())
    }

    /// Make `id` the only active destination.
    pub fn set_active(&self, id: i64) -> anyhow::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("UPDATE destinations SET active = 0", [])?;
        tx.execute("UPDATE destinations SET active = 1 WHERE id = ?", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Forget a destination and what it holds (the objects stay in the bucket).
    pub fn remove(&self, id: i64) -> anyhow::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM history_hours WHERE destination_id = ?", [id])?;
        tx.execute("DELETE FROM destinations WHERE id = ?", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn add_hour(&self, h: &HourRecord) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT OR REPLACE INTO history_hours (hour, destination_id, key, lines, bytes_raw,
                 bytes_stored, sources, min_ts, max_ts, sha256, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                h.hour,
                h.destination_id,
                h.key,
                h.lines as i64,
                h.bytes_raw as i64,
                h.bytes_stored as i64,
                serde_json::to_string(&h.sources)?,
                h.min_ts,
                h.max_ts,
                h.sha256,
                h.archived_at
            ],
        )?;
        Ok(())
    }

    pub fn is_archived(&self, hour: i64) -> anyhow::Result<bool> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT EXISTS (SELECT 1 FROM history_hours WHERE hour = ?)",
            [hour],
            |r| r.get(0),
        )?)
    }

    pub fn held(&self, destination_id: i64) -> anyhow::Result<Held> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT COUNT(*), COALESCE(SUM(lines), 0), COALESCE(SUM(bytes_stored), 0),
                    MIN(hour), MAX(hour)
             FROM history_hours WHERE destination_id = ?",
            [destination_id],
            |r| {
                Ok(Held {
                    hours: r.get::<_, i64>(0)? as u64,
                    lines: r.get::<_, i64>(1)? as u64,
                    bytes_stored: r.get::<_, i64>(2)? as u64,
                    first_hour: r.get(3)?,
                    last_hour: r.get(4)?,
                })
            },
        )?)
    }

    #[cfg(test)]
    pub fn hours_of(&self, destination_id: i64) -> anyhow::Result<Vec<HourRecord>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT hour, destination_id, key, lines, bytes_raw, bytes_stored, sources, min_ts,
                    max_ts, sha256, archived_at
             FROM history_hours WHERE destination_id = ? ORDER BY hour",
        )?;
        let v = st
            .query_map([destination_id], |r| {
                let sources: String = r.get(6)?;
                Ok(HourRecord {
                    hour: r.get(0)?,
                    destination_id: r.get(1)?,
                    key: r.get(2)?,
                    lines: r.get::<_, i64>(3)? as u64,
                    bytes_raw: r.get::<_, i64>(4)? as u64,
                    bytes_stored: r.get::<_, i64>(5)? as u64,
                    sources: serde_json::from_str(&sources).unwrap_or_default(),
                    min_ts: r.get(7)?,
                    max_ts: r.get(8)?,
                    sha256: r.get(9)?,
                    archived_at: r.get(10)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn add_gap(&self, hour: i64, reason: GapReason, at: i64) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT OR IGNORE INTO history_gaps (hour, reason, at) VALUES (?1, ?2, ?3)",
            params![hour, reason.as_str(), at],
        )?;
        Ok(())
    }

    /// Newest first.
    pub fn gaps(&self, limit: usize) -> anyhow::Result<Vec<(i64, GapReason, i64)>> {
        let db = self.db.lock().unwrap();
        let mut st =
            db.prepare("SELECT hour, reason, at FROM history_gaps ORDER BY hour DESC LIMIT ?")?;
        let v = st
            .query_map([limit as i64], |r| {
                let reason: String = r.get(1)?;
                Ok((
                    r.get(0)?,
                    GapReason::parse(&reason).unwrap_or(GapReason::DiskCap),
                    r.get(2)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn gap_count(&self) -> anyhow::Result<u64> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM history_gaps", [], |r| {
                r.get::<_, i64>(0)
            })? as u64)
    }
}
