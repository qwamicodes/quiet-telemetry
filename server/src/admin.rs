//! `quiet admin …`: account recovery from the host's shell.
//!
//! `quiet admin reset-password <email>` prints a one-time reset link (1 hour)
//! for a user. It writes to the same `quiet.db` the server uses (SQLite WAL,
//! safe while the server runs), so the link works immediately. In Docker:
//! `docker exec <container> /quiet admin reset-password you@example.com`.

use crate::accounts::{normalize_email, Accounts, RESET_TTL_CLI_MS};
use crate::cli::{AdminArgs, AdminCommand};
use std::path::Path;

pub fn run(args: AdminArgs) -> i32 {
    match args.command {
        AdminCommand::ResetPassword {
            email,
            data_dir,
            url,
        } => match reset_password(&email, &data_dir, url.as_deref()) {
            Ok(msg) => {
                println!("{msg}");
                0
            }
            Err(msg) => {
                eprintln!("{msg}");
                1
            }
        },
    }
}

fn reset_password(email: &str, data_dir: &Path, url: Option<&str>) -> Result<String, String> {
    let db = data_dir.join("quiet.db");
    if !db.exists() {
        return Err(format!(
            "no quiet.db in {}. Pass the server's --data-dir (or QUIET_DATA_DIR).",
            data_dir.display()
        ));
    }
    let email = normalize_email(email).map_err(|e| e.message())?;
    let accounts =
        Accounts::open(Some(&db)).map_err(|e| format!("can't open {}: {e}", db.display()))?;
    let user = accounts
        .user_by_email(&email)
        .map_err(|e| e.message())?
        .ok_or_else(|| format!("no account with the email {email}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    let (token, expires) = accounts
        .create_reset(user.id, "quiet admin (cli)", RESET_TTL_CLI_MS, now)
        .map_err(|e| e.message())?;
    let path = format!("/reset/{token}");
    let link = match url {
        Some(u) => format!("{}{path}", u.trim_end_matches('/')),
        None => format!("<your quiet address>{path}"),
    };
    let until = chrono::DateTime::from_timestamp_millis(expires)
        .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    Ok(format!(
        "Password reset for {} ({}).\nOpen this link once, before {until}, to choose a new password:\n\n  {link}\n\nUsing it signs {} out everywhere.",
        user.name,
        user.role.as_str(),
        user.email
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_a_link_that_works() {
        let dir = std::env::temp_dir().join(format!("quiet-admin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(reset_password("k@x.co", &dir, None)
            .unwrap_err()
            .contains("no quiet.db"));
        let a = Accounts::open(Some(&dir.join("quiet.db"))).unwrap();
        a.setup_owner(
            "k@x.co",
            "K",
            &crate::accounts::hash_password("x").unwrap(),
            0,
        )
        .unwrap();
        assert!(reset_password("nobody@x.co", &dir, None)
            .unwrap_err()
            .contains("no account"));
        let out = reset_password(" K@X.co ", &dir, Some("https://q.example.com/")).unwrap();
        let link = out
            .split_whitespace()
            .find(|w| w.starts_with("https://q.example.com/reset/rst_"))
            .unwrap();
        let token = link.rsplit('/').next().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        assert_eq!(a.reset_user(token, now).unwrap().0.email, "k@x.co");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
