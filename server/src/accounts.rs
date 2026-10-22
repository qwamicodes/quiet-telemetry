//! Accounts: local email + password users, server-side sessions, copy-link
//! invites and password-reset links. Framework-free (no axum here); the HTTP
//! side is `auth.rs` (gate, cookies, CSRF, login backoff) and `auth_api.rs`.
//!
//! - Tables live in `quiet.db` next to the lines (`users`, `sessions`,
//!   `invites`, `password_resets`), always on disk under `--data-dir`, even
//!   with `--store memory`: losing accounts on restart would hand the next
//!   visitor the first-run owner setup.
//! - Passwords: argon2id (the crate's defaults: m=19 MiB, t=2, p=1), PHC
//!   strings. Hashing is slow on purpose; callers run it off the async runtime.
//! - Session ids, invite and reset tokens are 32 random bytes; only their
//!   SHA-256 is stored. Invites are single use and expire after 7 days, reset
//!   links after 24 hours (1 hour from the CLI).
//! - Roles: `owner` and `member`. There is always at least one owner: the
//!   last owner can't be demoted or removed.

// An invite lookup error carries the invite (for the expired page).
#![allow(clippy::result_large_err)]

use crate::export::hash_token;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use ts_rs::TS;

pub const DAY_MS: i64 = 86_400_000;
/// "Keep me signed in": 30 days. Otherwise the cookie lives for the browser
/// session and the server forgets it after 12 hours.
pub const SESSION_LONG_MS: i64 = 30 * DAY_MS;
pub const SESSION_SHORT_MS: i64 = 12 * 3_600_000;
pub const INVITE_TTL_MS: i64 = 7 * DAY_MS;
pub const RESET_TTL_MS: i64 = DAY_MS;
pub const RESET_TTL_CLI_MS: i64 = 3_600_000;
/// `last_seen` reaches the disk at most this often per session.
const TOUCH_EVERY_MS: i64 = 60_000;
pub const MIN_PASSWORD: usize = 12;
pub const MAX_PASSWORD: usize = 256;
pub const INVITE_PREFIX: &str = "inv_";
pub const RESET_PREFIX: &str = "rst_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Everything a member can do, plus members, invites, ingest tokens and
    /// exports with PII unmasked.
    Owner,
    /// Reads every source, flow and search; exports are PII-masked; manages
    /// only their own account.
    Member,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Member => "member",
        }
    }
    fn parse(s: &str) -> Role {
        if s == "owner" {
            Role::Owner
        } else {
            Role::Member
        }
    }
}

/// A user as the UI sees them. Never carries the password hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub role: Role,
    /// Unix ms.
    pub created: i64,
    pub password_changed: i64,
}

/// A user in the members list, with when they were last seen.
#[derive(Debug, Clone, Serialize, TS)]
pub struct Member {
    #[serde(flatten)]
    #[ts(flatten)]
    pub user: User,
    /// Newest session activity, unix ms; `null` = never signed in since.
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Invite {
    pub id: i64,
    /// `inv_••••91c4`.
    pub preview: String,
    /// The address the invite is for (locked on the invite page), if any.
    pub email: Option<String>,
    pub role: Role,
    pub created_by: String,
    pub created: i64,
    pub expires: i64,
    pub used: Option<i64>,
    pub revoked: Option<i64>,
}

/// One signed-in browser.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SessionInfo {
    pub id: i64,
    pub created: i64,
    pub last_seen: i64,
    pub expires: i64,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    /// The session making this request.
    pub current: bool,
}

/// What a session lookup resolves to.
#[derive(Debug, Clone)]
pub struct SessionUser {
    pub session_id: i64,
    pub user: User,
    pub csrf: String,
}

/// A freshly created session: the cookie value is shown only here.
#[derive(Debug, Clone)]
pub struct NewSession {
    pub secret: String,
    pub csrf: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountError {
    /// Setup already done (or setup needed before anything else).
    AlreadySetUp,
    EmailTaken,
    Invalid(String),
    NotFound,
    WrongPassword,
    LastOwner,
    /// Invite/reset token states.
    TokenUnknown,
    TokenExpired,
    TokenUsed,
    TokenRevoked,
    Store(String),
}

impl AccountError {
    pub fn message(&self) -> String {
        match self {
            AccountError::AlreadySetUp => "quiet already has an owner; sign in instead".into(),
            AccountError::EmailTaken => "an account with that email already exists".into(),
            AccountError::Invalid(m) => m.clone(),
            AccountError::NotFound => "no such user".into(),
            AccountError::WrongPassword => "current password is wrong".into(),
            AccountError::LastOwner => "quiet needs at least one owner".into(),
            AccountError::TokenUnknown => "this link isn't valid".into(),
            AccountError::TokenExpired => "this link has expired".into(),
            AccountError::TokenUsed => "this link was already used".into(),
            AccountError::TokenRevoked => "this link was revoked".into(),
            AccountError::Store(_) => "account store unavailable".into(),
        }
    }
}

impl From<rusqlite::Error> for AccountError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::ConstraintViolation {
                return AccountError::EmailTaken;
            }
        }
        AccountError::Store(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AccountError>;

// ---- validation -------------------------------------------------------------

pub fn normalize_email(raw: &str) -> Result<String> {
    let e = raw.trim().to_lowercase();
    let ok = e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control())
        && e.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && !domain.contains('@')
        });
    if ok {
        Ok(e)
    } else {
        Err(AccountError::Invalid("enter a valid email address".into()))
    }
}

pub fn clean_name(raw: &str) -> Result<String> {
    let n = raw.trim();
    if n.is_empty() || n.chars().count() > 80 || n.chars().any(char::is_control) {
        return Err(AccountError::Invalid("name: 1–80 characters".into()));
    }
    Ok(n.to_string())
}

pub fn check_password(p: &str) -> Result<()> {
    let n = p.chars().count();
    if n < MIN_PASSWORD {
        return Err(AccountError::Invalid(format!(
            "password: at least {MIN_PASSWORD} characters"
        )));
    }
    if n > MAX_PASSWORD {
        return Err(AccountError::Invalid(format!(
            "password: at most {MAX_PASSWORD} characters"
        )));
    }
    Ok(())
}

// ---- hashing ------------------------------------------------------------------

/// argon2id PHC string. Slow (tens of ms): call from a blocking thread.
pub fn hash_password(password: &str) -> Result<String> {
    let salt_bytes: [u8; 16] = rand::random();
    let salt =
        SaltString::encode_b64(&salt_bytes).map_err(|e| AccountError::Store(e.to_string()))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AccountError::Store(e.to_string()))
}

pub fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc).is_ok_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}

/// A real hash to verify against when the email is unknown, so a wrong email
/// costs the same time as a wrong password.
fn dummy_hash() -> &'static str {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| hash_password("quiet-dummy-password").expect("argon2 works"))
}

fn random_secret(prefix: &str) -> String {
    let bytes: [u8; 32] = rand::random();
    format!(
        "{prefix}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn preview(prefix: &str, last4: &str) -> String {
    format!("{prefix}••••{last4}")
}

// ---- store ----------------------------------------------------------------------

pub struct Accounts {
    db: Mutex<Connection>,
}

const USER_COLS: &str = "id, email, name, role, created, password_changed";

fn row_to_user(r: &Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        role: Role::parse(&r.get::<_, String>(3)?),
        created: r.get(4)?,
        password_changed: r.get(5)?,
    })
}

const INVITE_COLS: &str =
    "id, last4, email, role, created_by_name, created, expires, used, revoked";

fn row_to_invite(r: &Row) -> rusqlite::Result<Invite> {
    Ok(Invite {
        id: r.get(0)?,
        preview: preview(INVITE_PREFIX, &r.get::<_, String>(1)?),
        email: r.get(2)?,
        role: Role::parse(&r.get::<_, String>(3)?),
        created_by: r.get(4)?,
        created: r.get(5)?,
        expires: r.get(6)?,
        used: r.get(7)?,
        revoked: r.get(8)?,
    })
}

impl Invite {
    fn state(&self, now: i64) -> Result<()> {
        if self.revoked.is_some() {
            Err(AccountError::TokenRevoked)
        } else if self.used.is_some() {
            Err(AccountError::TokenUsed)
        } else if now >= self.expires {
            Err(AccountError::TokenExpired)
        } else {
            Ok(())
        }
    }
}

impl Accounts {
    /// Open the account tables in `path` (the main `quiet.db`), or in memory (tests).
    pub fn open(path: Option<&Path>) -> anyhow::Result<Self> {
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
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS users (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 email TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL,
                 password TEXT NOT NULL,
                 role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
                 created INTEGER NOT NULL,
                 password_changed INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 hash TEXT NOT NULL UNIQUE,
                 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 csrf TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 last_seen INTEGER NOT NULL,
                 expires INTEGER NOT NULL,
                 persistent INTEGER NOT NULL,
                 user_agent TEXT,
                 ip TEXT);
             CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
             CREATE TABLE IF NOT EXISTS invites (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 hash TEXT NOT NULL UNIQUE,
                 last4 TEXT NOT NULL,
                 email TEXT,
                 role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
                 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                 created_by_name TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 expires INTEGER NOT NULL,
                 used INTEGER,
                 used_by INTEGER,
                 revoked INTEGER);
             CREATE TABLE IF NOT EXISTS password_resets (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 hash TEXT NOT NULL UNIQUE,
                 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 created_by TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 expires INTEGER NOT NULL,
                 used INTEGER);",
        )?;
        Ok(Accounts { db: Mutex::new(db) })
    }

    pub fn memory() -> Self {
        Accounts::open(None).expect("in-memory sqlite")
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn setup_required(&self) -> Result<bool> {
        let n: i64 = self
            .db()
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        Ok(n == 0)
    }

    /// First run: create the owner. Works exactly once (atomic: the insert
    /// only happens while the table is empty).
    pub fn setup_owner(&self, email: &str, name: &str, phc: &str, now: i64) -> Result<User> {
        let db = self.db();
        let changed = db.execute(
            "INSERT INTO users (email, name, password, role, created, password_changed)
             SELECT ?1, ?2, ?3, 'owner', ?4, ?4 WHERE NOT EXISTS (SELECT 1 FROM users)",
            params![email, name, phc, now],
        )?;
        if changed == 0 {
            return Err(AccountError::AlreadySetUp);
        }
        let id = db.last_insert_rowid();
        drop(db);
        self.user(id)?.ok_or(AccountError::NotFound)
    }

    pub fn user(&self, id: i64) -> Result<Option<User>> {
        Ok(self
            .db()
            .query_row(
                &format!("SELECT {USER_COLS} FROM users WHERE id = ?1"),
                [id],
                row_to_user,
            )
            .optional()?)
    }

    pub fn user_by_email(&self, email: &str) -> Result<Option<User>> {
        Ok(self
            .db()
            .query_row(
                &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
                [email],
                row_to_user,
            )
            .optional()?)
    }

    /// Check an email + password. `Ok(None)` = wrong email or password (the
    /// two are not told apart, and cost the same).
    pub fn authenticate(&self, email: &str, password: &str) -> Result<Option<User>> {
        let row: Option<(i64, String)> = self
            .db()
            .query_row(
                "SELECT id, password FROM users WHERE email = ?1",
                [email],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((id, phc)) if verify_password(password, &phc) => self.user(id),
            Some(_) => Ok(None),
            None => {
                let _ = verify_password(password, dummy_hash());
                Ok(None)
            }
        }
    }

    // ---- sessions ----

    pub fn create_session(
        &self,
        user_id: i64,
        persistent: bool,
        user_agent: Option<&str>,
        ip: Option<&str>,
        now: i64,
    ) -> Result<NewSession> {
        let secret = random_secret("");
        let csrf = random_secret("");
        let expires = now
            + if persistent {
                SESSION_LONG_MS
            } else {
                SESSION_SHORT_MS
            };
        let ua = user_agent.map(|u| u.chars().take(256).collect::<String>());
        let db = self.db();
        db.execute(
            "INSERT INTO sessions (hash, user_id, csrf, created, last_seen, expires, persistent, user_agent, ip)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
            params![hash_token(&secret), user_id, csrf, now, expires, persistent, ua, ip],
        )?;
        // Expired rows go when anyone signs in.
        db.execute("DELETE FROM sessions WHERE expires <= ?1", [now])?;
        Ok(NewSession { secret, csrf })
    }

    /// Resolve a cookie value. Expired or unknown = `None`.
    pub fn session(&self, secret: &str, now: i64) -> Result<Option<SessionUser>> {
        if secret.is_empty() || secret.len() > 128 {
            return Ok(None);
        }
        let db = self.db();
        let row = db
            .query_row(
                &format!(
                    "SELECT s.id, s.csrf, s.last_seen, s.expires, {} FROM sessions s
                     JOIN users u ON u.id = s.user_id WHERE s.hash = ?1",
                    USER_COLS
                        .split(", ")
                        .map(|c| format!("u.{c}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                [hash_token(secret)],
                |r| {
                    let user = User {
                        id: r.get(4)?,
                        email: r.get(5)?,
                        name: r.get(6)?,
                        role: Role::parse(&r.get::<_, String>(7)?),
                        created: r.get(8)?,
                        password_changed: r.get(9)?,
                    };
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        user,
                    ))
                },
            )
            .optional()?;
        let Some((id, csrf, last_seen, expires, user)) = row else {
            return Ok(None);
        };
        if now >= expires {
            db.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
            return Ok(None);
        }
        if now - last_seen >= TOUCH_EVERY_MS {
            db.execute(
                "UPDATE sessions SET last_seen = ?2 WHERE id = ?1",
                params![id, now],
            )?;
        }
        Ok(Some(SessionUser {
            session_id: id,
            user,
            csrf,
        }))
    }

    /// Is this session still signed in? (Open streams re-check it.)
    pub fn session_active(&self, id: i64, now: i64) -> bool {
        self.db()
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1 AND expires > ?2",
                params![id, now],
                |_| Ok(()),
            )
            .optional()
            .is_ok_and(|r| r.is_some())
    }

    pub fn sessions(&self, user_id: i64, current: i64, now: i64) -> Result<Vec<SessionInfo>> {
        let db = self.db();
        let mut st = db.prepare(
            "SELECT id, created, last_seen, expires, user_agent, ip FROM sessions
             WHERE user_id = ?1 AND expires > ?2 ORDER BY last_seen DESC, id DESC",
        )?;
        let rows = st
            .query_map(params![user_id, now], |r| {
                let id: i64 = r.get(0)?;
                Ok(SessionInfo {
                    id,
                    created: r.get(1)?,
                    last_seen: r.get(2)?,
                    expires: r.get(3)?,
                    user_agent: r.get(4)?,
                    ip: r.get(5)?,
                    current: id == current,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Sign out one session of this user. `false` = not theirs / gone.
    pub fn delete_session(&self, user_id: i64, id: i64) -> Result<bool> {
        Ok(self.db().execute(
            "DELETE FROM sessions WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )? > 0)
    }

    /// Sign out every session of a user except `keep`. Returns how many went.
    pub fn delete_sessions_except(&self, user_id: i64, keep: Option<i64>) -> Result<usize> {
        Ok(self.db().execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND id IS NOT ?2",
            params![user_id, keep],
        )?)
    }

    // ---- profile + password ----

    pub fn update_profile(&self, user_id: i64, name: &str, email: &str) -> Result<User> {
        let changed = self.db().execute(
            "UPDATE users SET name = ?2, email = ?3 WHERE id = ?1",
            params![user_id, name, email],
        )?;
        if changed == 0 {
            return Err(AccountError::NotFound);
        }
        self.user(user_id)?.ok_or(AccountError::NotFound)
    }

    pub fn password_hash(&self, user_id: i64) -> Result<String> {
        self.db()
            .query_row("SELECT password FROM users WHERE id = ?1", [user_id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(AccountError::NotFound)
    }

    pub fn set_password(&self, user_id: i64, phc: &str, now: i64) -> Result<()> {
        let changed = self.db().execute(
            "UPDATE users SET password = ?2, password_changed = ?3 WHERE id = ?1",
            params![user_id, phc, now],
        )?;
        if changed == 0 {
            return Err(AccountError::NotFound);
        }
        Ok(())
    }

    // ---- members ----

    pub fn members(&self) -> Result<Vec<Member>> {
        let db = self.db();
        let mut st = db.prepare(&format!(
            "SELECT {}, (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id)
             FROM users u ORDER BY (role = 'owner') DESC, created, id",
            USER_COLS
                .split(", ")
                .map(|c| format!("u.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        ))?;
        let rows = st
            .query_map([], |r| {
                Ok(Member {
                    user: row_to_user(r)?,
                    last_seen: r.get(6)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Change a role, keeping at least one owner.
    pub fn set_role(&self, user_id: i64, role: Role) -> Result<User> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let current: Option<String> = tx
            .query_row("SELECT role FROM users WHERE id = ?1", [user_id], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(current) = current else {
            return Err(AccountError::NotFound);
        };
        if current == "owner" && role == Role::Member {
            let owners: i64 =
                tx.query_row("SELECT COUNT(*) FROM users WHERE role = 'owner'", [], |r| {
                    r.get(0)
                })?;
            if owners <= 1 {
                return Err(AccountError::LastOwner);
            }
        }
        tx.execute(
            "UPDATE users SET role = ?2 WHERE id = ?1",
            params![user_id, role.as_str()],
        )?;
        tx.commit()?;
        drop(db);
        self.user(user_id)?.ok_or(AccountError::NotFound)
    }

    /// Remove a user and everything signed in as them, keeping at least one owner.
    pub fn remove_user(&self, user_id: i64) -> Result<User> {
        let user = self.user(user_id)?.ok_or(AccountError::NotFound)?;
        let mut db = self.db();
        let tx = db.transaction()?;
        if user.role == Role::Owner {
            let owners: i64 =
                tx.query_row("SELECT COUNT(*) FROM users WHERE role = 'owner'", [], |r| {
                    r.get(0)
                })?;
            if owners <= 1 {
                return Err(AccountError::LastOwner);
            }
        }
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", [user_id])?;
        tx.execute("DELETE FROM password_resets WHERE user_id = ?1", [user_id])?;
        tx.execute("DELETE FROM users WHERE id = ?1", [user_id])?;
        tx.commit()?;
        Ok(user)
    }

    // ---- invites ----

    pub fn create_invite(
        &self,
        email: Option<&str>,
        role: Role,
        by: &User,
        now: i64,
    ) -> Result<(Invite, String)> {
        if let Some(e) = email {
            if self.user_by_email(e)?.is_some() {
                return Err(AccountError::EmailTaken);
            }
        }
        let secret = random_secret(INVITE_PREFIX);
        let last4 = secret[secret.len() - 4..].to_string();
        let db = self.db();
        db.execute(
            "INSERT INTO invites (hash, last4, email, role, created_by, created_by_name, created, expires)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                hash_token(&secret),
                last4,
                email,
                role.as_str(),
                by.id,
                by.name,
                now,
                now + INVITE_TTL_MS
            ],
        )?;
        let id = db.last_insert_rowid();
        let invite = db.query_row(
            &format!("SELECT {INVITE_COLS} FROM invites WHERE id = ?1"),
            [id],
            row_to_invite,
        )?;
        Ok((invite, secret))
    }

    /// Pending, expired and used invites, newest first (revoked ones are hidden).
    pub fn invites(&self) -> Result<Vec<Invite>> {
        let db = self.db();
        let mut st = db.prepare(&format!(
            "SELECT {INVITE_COLS} FROM invites WHERE revoked IS NULL AND used IS NULL
             ORDER BY created DESC, id DESC LIMIT 200"
        ))?;
        let rows = st
            .query_map([], row_to_invite)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn revoke_invite(&self, id: i64, now: i64) -> Result<Invite> {
        let db = self.db();
        let changed = db.execute(
            "UPDATE invites SET revoked = COALESCE(revoked, ?2) WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Err(AccountError::NotFound);
        }
        Ok(db.query_row(
            &format!("SELECT {INVITE_COLS} FROM invites WHERE id = ?1"),
            [id],
            row_to_invite,
        )?)
    }

    /// Look an invite up by its secret. `Err(state)` carries the invite too,
    /// so the expired page can say who created it and when.
    pub fn invite_by_secret(
        &self,
        secret: &str,
        now: i64,
    ) -> std::result::Result<Invite, (AccountError, Option<Invite>)> {
        if !secret.starts_with(INVITE_PREFIX) || secret.len() > 128 {
            return Err((AccountError::TokenUnknown, None));
        }
        let found = self
            .db()
            .query_row(
                &format!("SELECT {INVITE_COLS} FROM invites WHERE hash = ?1"),
                [hash_token(secret)],
                row_to_invite,
            )
            .optional()
            .map_err(|e| (AccountError::from(e), None))?;
        let Some(inv) = found else {
            return Err((AccountError::TokenUnknown, None));
        };
        match inv.state(now) {
            Ok(()) => Ok(inv),
            Err(e) => Err((e, Some(inv))),
        }
    }

    /// Redeem an invite: creates the user, marks the invite used (atomically,
    /// so a link works exactly once).
    pub fn accept_invite(
        &self,
        secret: &str,
        email: &str,
        name: &str,
        phc: &str,
        now: i64,
    ) -> Result<User> {
        let inv = self.invite_by_secret(secret, now).map_err(|(e, _)| e)?;
        let email = inv.email.as_deref().unwrap_or(email);
        let mut db = self.db();
        let tx = db.transaction()?;
        let claimed = tx.execute(
            "UPDATE invites SET used = ?2 WHERE id = ?1 AND used IS NULL AND revoked IS NULL AND expires > ?2",
            params![inv.id, now],
        )?;
        if claimed == 0 {
            return Err(AccountError::TokenUsed);
        }
        tx.execute(
            "INSERT INTO users (email, name, password, role, created, password_changed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![email, name, phc, inv.role.as_str(), now],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE invites SET used_by = ?2 WHERE id = ?1",
            params![inv.id, id],
        )?;
        tx.commit()?;
        drop(db);
        self.user(id)?.ok_or(AccountError::NotFound)
    }

    // ---- password resets ----

    /// A one-time reset link for `user_id`, valid for `ttl_ms`. Older unused
    /// links for the same user stop working.
    pub fn create_reset(
        &self,
        user_id: i64,
        created_by: &str,
        ttl_ms: i64,
        now: i64,
    ) -> Result<(String, i64)> {
        if self.user(user_id)?.is_none() {
            return Err(AccountError::NotFound);
        }
        let secret = random_secret(RESET_PREFIX);
        let expires = now + ttl_ms;
        let db = self.db();
        db.execute(
            "UPDATE password_resets SET used = ?2 WHERE user_id = ?1 AND used IS NULL",
            params![user_id, now],
        )?;
        db.execute(
            "INSERT INTO password_resets (hash, user_id, created_by, created, expires)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash_token(&secret), user_id, created_by, now, expires],
        )?;
        Ok((secret, expires))
    }

    /// Who a reset link is for (without using it).
    pub fn reset_user(&self, secret: &str, now: i64) -> Result<(User, i64)> {
        if !secret.starts_with(RESET_PREFIX) || secret.len() > 128 {
            return Err(AccountError::TokenUnknown);
        }
        let row: Option<(i64, i64, Option<i64>)> = self
            .db()
            .query_row(
                "SELECT user_id, expires, used FROM password_resets WHERE hash = ?1",
                [hash_token(secret)],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((user_id, expires, used)) = row else {
            return Err(AccountError::TokenUnknown);
        };
        if used.is_some() {
            return Err(AccountError::TokenUsed);
        }
        if now >= expires {
            return Err(AccountError::TokenExpired);
        }
        let user = self.user(user_id)?.ok_or(AccountError::TokenUnknown)?;
        Ok((user, expires))
    }

    /// Use a reset link: new password, every session of that user signed out.
    pub fn complete_reset(&self, secret: &str, phc: &str, now: i64) -> Result<User> {
        let (user, _) = self.reset_user(secret, now)?;
        let mut db = self.db();
        let tx = db.transaction()?;
        let claimed = tx.execute(
            "UPDATE password_resets SET used = ?2 WHERE hash = ?1 AND used IS NULL",
            params![hash_token(secret), now],
        )?;
        if claimed == 0 {
            return Err(AccountError::TokenUsed);
        }
        tx.execute(
            "UPDATE users SET password = ?2, password_changed = ?3 WHERE id = ?1",
            params![user.id, phc, now],
        )?;
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", [user.id])?;
        tx.commit()?;
        drop(db);
        self.user(user.id)?.ok_or(AccountError::NotFound)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A cheap hash for tests that don't exercise argon2 itself.
    pub fn fast_hash(p: &str) -> String {
        hash_password(p).unwrap()
    }

    #[test]
    fn setup_happens_once_and_passwords_verify() {
        let a = Accounts::memory();
        assert!(a.setup_required().unwrap());
        let phc = fast_hash("correct horse battery");
        assert!(phc.starts_with("$argon2id$"));
        let owner = a.setup_owner("k@x.co", "K", &phc, 1).unwrap();
        assert_eq!(owner.role, Role::Owner);
        assert!(!a.setup_required().unwrap());
        assert_eq!(
            a.setup_owner("z@x.co", "Z", &phc, 2).unwrap_err(),
            AccountError::AlreadySetUp
        );
        assert_eq!(
            a.authenticate("k@x.co", "correct horse battery")
                .unwrap()
                .unwrap()
                .id,
            owner.id
        );
        assert!(a
            .authenticate("k@x.co", "wrong password!!")
            .unwrap()
            .is_none());
        assert!(a
            .authenticate("nobody@x.co", "whatever12345")
            .unwrap()
            .is_none());
    }

    #[test]
    fn validation() {
        assert_eq!(
            normalize_email("  Ama@Legivent.COM ").unwrap(),
            "ama@legivent.com"
        );
        assert!(normalize_email("nope").is_err());
        assert!(normalize_email("a@b@c").is_err());
        assert!(normalize_email("a b@c.co").is_err());
        assert!(check_password("short").is_err());
        assert!(check_password("twelve chars").is_ok());
        assert!(clean_name("  ").is_err());
    }

    #[test]
    fn sessions_expire_and_sign_out() {
        let a = Accounts::memory();
        let u = a.setup_owner("k@x.co", "K", &fast_hash("x"), 0).unwrap();
        let s1 = a.create_session(u.id, false, Some("ua"), None, 0).unwrap();
        let s2 = a.create_session(u.id, true, None, None, 0).unwrap();
        let su = a.session(&s1.secret, 1).unwrap().unwrap();
        assert_eq!(su.user.id, u.id);
        assert_eq!(su.csrf, s1.csrf);
        assert!(a.session("nope", 1).unwrap().is_none());
        // Short sessions end after 12h, long ones keep going.
        assert!(a.session(&s1.secret, SESSION_SHORT_MS).unwrap().is_none());
        let su2 = a.session(&s2.secret, SESSION_SHORT_MS).unwrap().unwrap();
        assert_eq!(
            a.sessions(u.id, su2.session_id, SESSION_SHORT_MS)
                .unwrap()
                .len(),
            1
        );
        let s3 = a.create_session(u.id, true, None, None, 5).unwrap();
        let id3 = a.session(&s3.secret, 6).unwrap().unwrap().session_id;
        assert_eq!(a.delete_sessions_except(u.id, Some(id3)).unwrap(), 1);
        assert!(a.session(&s2.secret, 7).unwrap().is_none());
        assert!(a.session_active(id3, 7));
    }

    #[test]
    fn invites_are_single_use_and_expire() {
        let a = Accounts::memory();
        let o = a
            .setup_owner("k@x.co", "Kwaame", &fast_hash("x"), 0)
            .unwrap();
        let (inv, secret) = a
            .create_invite(Some("yaw@x.co"), Role::Member, &o, 0)
            .unwrap();
        assert!(secret.starts_with("inv_"));
        assert!(inv.preview.starts_with("inv_••••"));
        assert_eq!(inv.expires, INVITE_TTL_MS);
        assert_eq!(a.invite_by_secret(&secret, 1).unwrap().created_by, "Kwaame");
        // The invite's email wins over what the form sends.
        let u = a
            .accept_invite(&secret, "other@x.co", "Yaw", &fast_hash("y"), 2)
            .unwrap();
        assert_eq!(u.email, "yaw@x.co");
        assert_eq!(u.role, Role::Member);
        assert_eq!(
            a.accept_invite(&secret, "z@x.co", "Z", &fast_hash("z"), 3)
                .unwrap_err(),
            AccountError::TokenUsed
        );
        let (_, s2) = a.create_invite(None, Role::Member, &o, 0).unwrap();
        let (e, inv) = a.invite_by_secret(&s2, INVITE_TTL_MS).unwrap_err();
        assert_eq!(e, AccountError::TokenExpired);
        assert!(inv.is_some());
        let (i3, s3) = a.create_invite(None, Role::Owner, &o, 0).unwrap();
        a.revoke_invite(i3.id, 1).unwrap();
        assert_eq!(
            a.invite_by_secret(&s3, 2).unwrap_err().0,
            AccountError::TokenRevoked
        );
        assert_eq!(
            a.invite_by_secret("inv_nope", 2).unwrap_err().0,
            AccountError::TokenUnknown
        );
        assert_eq!(
            a.create_invite(Some("yaw@x.co"), Role::Member, &o, 4)
                .unwrap_err(),
            AccountError::EmailTaken
        );
    }

    #[test]
    fn always_one_owner() {
        let a = Accounts::memory();
        let o = a.setup_owner("k@x.co", "K", &fast_hash("x"), 0).unwrap();
        assert_eq!(
            a.set_role(o.id, Role::Member).unwrap_err(),
            AccountError::LastOwner
        );
        assert_eq!(a.remove_user(o.id).unwrap_err(), AccountError::LastOwner);
        let (_, s) = a.create_invite(None, Role::Member, &o, 0).unwrap();
        let m = a
            .accept_invite(&s, "m@x.co", "M", &fast_hash("m"), 1)
            .unwrap();
        a.set_role(m.id, Role::Owner).unwrap();
        a.set_role(o.id, Role::Member).unwrap();
        assert_eq!(
            a.set_role(m.id, Role::Member).unwrap_err(),
            AccountError::LastOwner
        );
        a.create_session(o.id, true, None, None, 2).unwrap();
        a.remove_user(o.id).unwrap();
        assert_eq!(a.members().unwrap().len(), 1);
    }

    #[test]
    fn reset_links_work_once_and_sign_out_everywhere() {
        let a = Accounts::memory();
        let o = a
            .setup_owner("k@x.co", "K", &fast_hash("old password 1"), 0)
            .unwrap();
        let s = a.create_session(o.id, true, None, None, 0).unwrap();
        let (old, _) = a.create_reset(o.id, "cli", RESET_TTL_CLI_MS, 0).unwrap();
        let (link, exp) = a.create_reset(o.id, "cli", RESET_TTL_CLI_MS, 0).unwrap();
        assert_eq!(exp, RESET_TTL_CLI_MS);
        assert_eq!(a.reset_user(&old, 1).unwrap_err(), AccountError::TokenUsed);
        assert_eq!(a.reset_user(&link, 1).unwrap().0.id, o.id);
        a.complete_reset(&link, &fast_hash("new password 1"), 2)
            .unwrap();
        assert!(a.session(&s.secret, 3).unwrap().is_none());
        assert!(a
            .authenticate("k@x.co", "new password 1")
            .unwrap()
            .is_some());
        assert_eq!(
            a.complete_reset(&link, &fast_hash("again"), 3).unwrap_err(),
            AccountError::TokenUsed
        );
        let (late, _) = a.create_reset(o.id, "cli", 10, 0).unwrap();
        assert_eq!(
            a.reset_user(&late, 10).unwrap_err(),
            AccountError::TokenExpired
        );
    }
}
