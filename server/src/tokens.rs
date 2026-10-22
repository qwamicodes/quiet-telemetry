//! Ingest tokens: `qi_…`, send-only.
//!
//! - Created and revoked from the UI (`/api/ingest-tokens`, see `tokens_api.rs`).
//! - Only the SHA-256 of a token is stored (SQLite table `ingest_tokens` in
//!   `quiet.db`, or an in-memory database with `--store memory`). The secret
//!   is shown once, when it is created.
//! - Each token is bound to one source name (every line it sends lands
//!   there) or to any source (the shipper names it).
//! - A token can only send lines: it is accepted by the ingest endpoints and
//!   nothing else. Read-only `qx_` export tokens are a separate thing (`export.rs`).
//! - Lookups are served from memory; `last_used` is kept in memory and
//!   written to disk at most once a minute per token (and on shutdown).
//! - Each token has its own line budget (a token bucket, see [`RateLimit`]).

use crate::export::hash_token;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use ts_rs::TS;

pub const PREFIX: &str = "qi_";
/// How often `last_used` reaches the disk, per token.
const PERSIST_EVERY_MS: i64 = 60_000;

/// One ingest token as the UI lists it. Never carries the secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct IngestToken {
    pub id: i64,
    pub name: String,
    /// `qi_••••3f2a`: enough to tell tokens apart.
    pub preview: String,
    /// The source every line goes to; `null` = any source (the shipper names it).
    pub source: Option<String>,
    /// Unix ms.
    pub created: i64,
    pub last_used: Option<i64>,
    pub revoked: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct IngestTokensResponse {
    pub tokens: Vec<IngestToken>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CreateIngestToken {
    pub name: String,
    /// Bind to this source; omit or `null` for any source.
    #[ts(optional)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct CreatedIngestToken {
    pub token: IngestToken,
    /// The full `qi_…` token. Shown once; only its hash is kept.
    pub secret: String,
}

/// A token bucket: `rate` lines a second, bursts up to `burst`.
#[derive(Debug)]
pub struct RateLimit {
    rate: f64,
    burst: f64,
    state: Mutex<(f64, Instant)>,
}

impl RateLimit {
    /// `rate` lines/s, bursts of `burst_secs` seconds' worth. `rate = 0` = unlimited.
    pub fn new(rate: u32, burst_secs: u32) -> Self {
        let burst = rate as f64 * burst_secs.max(1) as f64;
        RateLimit {
            rate: rate as f64,
            burst,
            state: Mutex::new((burst, Instant::now())),
        }
    }

    /// Take `n` lines from the budget, all or nothing. A batch bigger than
    /// the whole burst passes when the bucket is full, so it is never stuck.
    /// `Err(seconds)` says when to retry.
    pub fn take(&self, n: usize) -> Result<(), u64> {
        self.take_at(n, Instant::now())
    }

    fn take_at(&self, n: usize, now: Instant) -> Result<(), u64> {
        if self.rate <= 0.0 {
            return Ok(());
        }
        let mut st = self.state.lock().unwrap();
        let elapsed = now.saturating_duration_since(st.1).as_secs_f64();
        st.0 = (st.0 + elapsed * self.rate).min(self.burst);
        st.1 = now;
        let need = (n as f64).min(self.burst);
        if st.0 >= need {
            st.0 -= n as f64;
            Ok(())
        } else {
            Err(((need - st.0) / self.rate).ceil().max(1.0) as u64)
        }
    }
}

/// What the ingest endpoints know about a valid token.
#[derive(Debug)]
pub struct TokenEntry {
    pub id: i64,
    pub source: Option<String>,
    revoked: AtomicI64,
    last_used: AtomicI64,
    persisted: AtomicI64,
    pub limit: RateLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// No `Authorization: Bearer qi_…`.
    Missing,
    /// Not a token this server issued (or not a `qi_` token at all).
    Unknown,
    Revoked,
}

impl AuthError {
    pub fn message(self) -> &'static str {
        match self {
            AuthError::Missing => "missing ingest token: send `Authorization: Bearer qi_…`",
            AuthError::Unknown => "unknown ingest token",
            AuthError::Revoked => "ingest token revoked",
        }
    }
}

pub struct IngestTokens {
    db: Mutex<Connection>,
    by_hash: RwLock<HashMap<String, Arc<TokenEntry>>>,
    /// Lines per second per token (0 = unlimited).
    rate: u32,
}

impl IngestTokens {
    /// Open the token table in `path` (the main `quiet.db`), or in memory.
    pub fn open(path: Option<&Path>, rate: u32) -> anyhow::Result<Self> {
        let db = match path {
            Some(p) => {
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                Connection::open(p)?
            }
            None => Connection::open_in_memory()?,
        };
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS ingest_tokens (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 hash TEXT NOT NULL UNIQUE,
                 last4 TEXT NOT NULL,
                 source TEXT,
                 created INTEGER NOT NULL,
                 last_used INTEGER,
                 revoked INTEGER);",
        )?;
        let me = IngestTokens {
            db: Mutex::new(db),
            by_hash: RwLock::new(HashMap::new()),
            rate,
        };
        me.load()?;
        Ok(me)
    }

    /// In memory, unlimited: for tests.
    pub fn memory() -> Self {
        IngestTokens::open(None, 0).expect("in-memory sqlite")
    }

    fn entry(&self, id: i64, source: Option<String>, last_used: Option<i64>) -> TokenEntry {
        TokenEntry {
            id,
            source,
            revoked: AtomicI64::new(0),
            last_used: AtomicI64::new(last_used.unwrap_or(0)),
            persisted: AtomicI64::new(last_used.unwrap_or(0)),
            limit: RateLimit::new(self.rate, 5),
        }
    }

    fn load(&self) -> anyhow::Result<()> {
        let db = self.db.lock().unwrap();
        let mut st =
            db.prepare("SELECT id, hash, source, last_used, revoked FROM ingest_tokens")?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut map = self.by_hash.write().unwrap();
        for (id, hash, source, last_used, revoked) in rows {
            let e = self.entry(id, source, last_used);
            e.revoked.store(revoked.unwrap_or(0), Ordering::Relaxed);
            map.insert(hash, Arc::new(e));
        }
        Ok(())
    }

    /// Mint a token. The secret is returned once and never stored.
    pub fn create(
        &self,
        name: &str,
        source: Option<&str>,
        now: i64,
    ) -> anyhow::Result<CreatedIngestToken> {
        let bytes: [u8; 24] = rand::random();
        let secret = format!(
            "{PREFIX}{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let hash = hash_token(&secret);
        let last4 = secret[secret.len() - 4..].to_string();
        let id = {
            let db = self.db.lock().unwrap();
            db.execute(
                "INSERT INTO ingest_tokens (name, hash, last4, source, created) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![name, hash, last4, source, now],
            )?;
            db.last_insert_rowid()
        };
        self.by_hash.write().unwrap().insert(
            hash,
            Arc::new(self.entry(id, source.map(str::to_string), None)),
        );
        let token = self.get(id)?.expect("just inserted");
        Ok(CreatedIngestToken { token, secret })
    }

    /// Every token, newest first, with live `last_used`.
    pub fn list(&self) -> anyhow::Result<Vec<IngestToken>> {
        let live: HashMap<i64, i64> = self
            .by_hash
            .read()
            .unwrap()
            .values()
            .map(|e| (e.id, e.last_used.load(Ordering::Relaxed)))
            .collect();
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT id, name, last4, source, created, last_used, revoked
             FROM ingest_tokens ORDER BY created DESC, id DESC",
        )?;
        let rows = st
            .query_map([], row_to_token)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|mut t| {
                if let Some(&lu) = live.get(&t.id) {
                    if lu > 0 && t.last_used.is_none_or(|d| lu > d) {
                        t.last_used = Some(lu);
                    }
                }
                t
            })
            .collect())
    }

    fn get(&self, id: i64) -> anyhow::Result<Option<IngestToken>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row(
                "SELECT id, name, last4, source, created, last_used, revoked
                 FROM ingest_tokens WHERE id = ?1",
                [id],
                row_to_token,
            )
            .optional()?)
    }

    /// Revoke a token. Takes effect on the next request. `None` = no such token.
    pub fn revoke(&self, id: i64, now: i64) -> anyhow::Result<Option<IngestToken>> {
        let changed = self.db.lock().unwrap().execute(
            "UPDATE ingest_tokens SET revoked = COALESCE(revoked, ?2) WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        for e in self.by_hash.read().unwrap().values() {
            if e.id == id {
                let _ = e
                    .revoked
                    .compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed);
            }
        }
        let mut t = self.get(id)?;
        if let (Some(t), Some(e)) = (
            t.as_mut(),
            self.by_hash
                .read()
                .unwrap()
                .values()
                .find(|e| e.id == id)
                .cloned(),
        ) {
            let lu = e.last_used.load(Ordering::Relaxed);
            if lu > 0 {
                t.last_used = Some(lu);
            }
        }
        Ok(t)
    }

    /// Check an `Authorization` header value (`Bearer qi_…`) and mark the
    /// token used.
    pub fn check(
        &self,
        authorization: Option<&str>,
        now: i64,
    ) -> Result<Arc<TokenEntry>, AuthError> {
        let secret = bearer(authorization).ok_or(AuthError::Missing)?;
        if !secret.starts_with(PREFIX) {
            return Err(AuthError::Unknown);
        }
        let e = self
            .by_hash
            .read()
            .unwrap()
            .get(&hash_token(secret))
            .cloned()
            .ok_or(AuthError::Unknown)?;
        if e.revoked.load(Ordering::Relaxed) != 0 {
            return Err(AuthError::Revoked);
        }
        e.last_used.fetch_max(now, Ordering::Relaxed);
        if now - e.persisted.load(Ordering::Relaxed) >= PERSIST_EVERY_MS {
            e.persisted.store(now, Ordering::Relaxed);
            if let Ok(db) = self.db.try_lock() {
                let _ = db.execute(
                    "UPDATE ingest_tokens SET last_used = MAX(COALESCE(last_used, 0), ?2) WHERE id = ?1",
                    params![e.id, now],
                );
            }
        }
        Ok(e)
    }

    /// Write every in-memory `last_used` to disk (on shutdown).
    pub fn flush(&self) -> anyhow::Result<()> {
        let db = self.db.lock().unwrap();
        for e in self.by_hash.read().unwrap().values() {
            let lu = e.last_used.load(Ordering::Relaxed);
            if lu > 0 {
                db.execute(
                    "UPDATE ingest_tokens SET last_used = MAX(COALESCE(last_used, 0), ?2) WHERE id = ?1",
                    params![e.id, lu],
                )?;
            }
        }
        Ok(())
    }

    /// Tokens that still work.
    pub fn active(&self) -> usize {
        self.by_hash
            .read()
            .unwrap()
            .values()
            .filter(|e| e.revoked.load(Ordering::Relaxed) == 0)
            .count()
    }
}

fn row_to_token(r: &rusqlite::Row) -> rusqlite::Result<IngestToken> {
    let last4: String = r.get(2)?;
    Ok(IngestToken {
        id: r.get(0)?,
        name: r.get(1)?,
        preview: format!("{PREFIX}••••{last4}"),
        source: r.get(3)?,
        created: r.get(4)?,
        last_used: r.get(5)?,
        revoked: r.get(6)?,
    })
}

/// The token in `Bearer <token>` (case-insensitive scheme), or a bare token.
pub fn bearer(v: Option<&str>) -> Option<&str> {
    let v = v?.trim();
    let t = match v.split_once(' ') {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("bearer") => rest.trim(),
        Some(_) => return None,
        None if v.eq_ignore_ascii_case("bearer") => return None,
        None => v,
    };
    (!t.is_empty()).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn create_check_revoke_and_only_the_hash_is_kept() {
        let path = std::env::temp_dir().join(format!("quiet-tokens-{}.db", rand::random::<u64>()));
        let t = IngestTokens::open(Some(&path), 0).unwrap();
        let c = t.create("vector · edge", None, 1_000).unwrap();
        assert!(c.secret.starts_with("qi_") && c.secret.len() == 3 + 48);
        assert_eq!(
            c.token.preview,
            format!("qi_••••{}", &c.secret[c.secret.len() - 4..])
        );
        assert_eq!(c.token.last_used, None);

        // Nothing on disk contains the secret.
        let db = Connection::open(&path).unwrap();
        let stored: String = db
            .query_row("SELECT hash FROM ingest_tokens", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, hash_token(&c.secret));
        assert!(!stored.contains(&c.secret[3..]));

        let bound = t.create("laptop", Some("cron"), 2_000).unwrap();
        let header = format!("Bearer {}", bound.secret);
        let e = t.check(Some(&header), 90_000).unwrap();
        assert_eq!(e.source.as_deref(), Some("cron"));
        assert_eq!(t.check(None, 0).unwrap_err(), AuthError::Missing);
        assert_eq!(
            t.check(Some("Bearer qi_nope"), 0).unwrap_err(),
            AuthError::Unknown
        );
        assert_eq!(
            t.check(Some("Bearer qx_abc"), 0).unwrap_err(),
            AuthError::Unknown
        );
        assert_eq!(
            t.check(Some("Basic abc"), 0).unwrap_err(),
            AuthError::Missing
        );

        let list = t.list().unwrap();
        assert_eq!(
            list.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["laptop", "vector · edge"]
        );
        assert_eq!(list[0].last_used, Some(90_000));

        let r = t.revoke(bound.token.id, 95_000).unwrap().unwrap();
        assert_eq!(r.revoked, Some(95_000));
        assert_eq!(
            t.check(Some(&header), 96_000).unwrap_err(),
            AuthError::Revoked
        );
        assert!(t.revoke(999, 1).unwrap().is_none());
        assert_eq!(t.active(), 1);

        // Survives a restart: revoked stays revoked, last_used was persisted.
        t.flush().unwrap();
        drop(t);
        let t = IngestTokens::open(Some(&path), 0).unwrap();
        assert_eq!(t.check(Some(&header), 1).unwrap_err(), AuthError::Revoked);
        let auth = format!("bearer {}", c.secret);
        assert!(t.check(Some(&auth), 100_000).is_ok());
        assert_eq!(t.list().unwrap()[0].last_used, Some(90_000));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rate_limit_is_a_token_bucket() {
        let l = RateLimit::new(10, 2); // 10/s, bursts of 20
        let t0 = Instant::now();
        assert!(l.take_at(15, t0).is_ok());
        assert_eq!(l.take_at(10, t0), Err(1));
        assert!(l.take_at(5, t0).is_ok());
        assert!(l.take_at(10, t0 + Duration::from_secs(1)).is_ok());
        // A batch bigger than the burst passes once the bucket is full again.
        assert!(l.take_at(500, t0 + Duration::from_secs(10)).is_ok());
        assert!(l.take_at(1, t0 + Duration::from_secs(10)).is_err());
        assert!(RateLimit::new(0, 5).take(1_000_000).is_ok());
    }

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer(Some("Bearer qi_x")), Some("qi_x"));
        assert_eq!(bearer(Some("  BEARER   qi_x ")), Some("qi_x"));
        assert_eq!(bearer(Some("qi_x")), Some("qi_x"));
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(None), None);
    }
}
