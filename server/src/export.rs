//! Export: lines → NDJSON / JSON array / CSV, optional gzip and PII masking,
//! plus the short-lived read-only `qx_` tokens behind "Copy curl".

use crate::normalize::LogLine;
use crate::search::{field_at, scalar_text};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// The raw lines, one per line (default).
    #[default]
    Ndjson,
    /// One JSON array of parsed lines with their fields.
    Json,
    /// Chosen columns; opens in any spreadsheet.
    Csv,
}

impl ExportFormat {
    pub fn ext(self) -> &'static str {
        match self {
            ExportFormat::Ndjson => "ndjson",
            ExportFormat::Json => "json",
            ExportFormat::Csv => "csv",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            ExportFormat::Ndjson => "application/x-ndjson",
            ExportFormat::Json => "application/json",
            ExportFormat::Csv => "text/csv; charset=utf-8",
        }
    }
}

/// CSV columns when none are chosen (the design's defaults).
pub const DEFAULT_COLUMNS: &[&str] = &[
    "timestamp",
    "level",
    "source",
    "request_id",
    "msg",
    "status",
    "duration_ms",
];

#[derive(Debug, Clone, Default)]
pub struct Formatter {
    pub format: ExportFormat,
    pub mask: bool,
    /// Add the raw line (JSON: a `raw` key; CSV: a `raw` column).
    pub raw: bool,
    pub columns: Vec<String>,
}

impl Formatter {
    pub fn columns(&self) -> Vec<String> {
        let mut cols = if self.columns.is_empty() {
            DEFAULT_COLUMNS.iter().map(|s| s.to_string()).collect()
        } else {
            self.columns.clone()
        };
        if self.raw && self.format == ExportFormat::Csv && !cols.iter().any(|c| c == "raw") {
            cols.push("raw".into());
        }
        cols
    }

    pub fn header(&self) -> String {
        match self.format {
            ExportFormat::Ndjson => String::new(),
            ExportFormat::Json => "[".into(),
            ExportFormat::Csv => {
                let mut s = self
                    .columns()
                    .iter()
                    .map(|c| csv_cell(c))
                    .collect::<Vec<_>>()
                    .join(",");
                s.push_str("\r\n");
                s
            }
        }
    }

    pub fn footer(&self, wrote_any: bool) -> String {
        match self.format {
            ExportFormat::Json if wrote_any => "\n]\n".into(),
            ExportFormat::Json => "]\n".into(),
            _ => String::new(),
        }
    }

    /// One line in this format. `first` matters for the JSON array's commas.
    pub fn line(&self, l: &LogLine, first: bool) -> String {
        let fields = l.fields.as_ref().map(|f| {
            if self.mask {
                mask_value(None, f)
            } else {
                f.clone()
            }
        });
        let raw = || {
            if !self.mask {
                l.raw.clone()
            } else if let Some(f) = &fields {
                // Masked JSON lines are re-serialized from the masked fields.
                f.to_string()
            } else {
                mask_text(&l.raw)
            }
        };
        match self.format {
            ExportFormat::Ndjson => {
                let mut s = match &fields {
                    // JSON lines go out exactly as received (unless masked).
                    Some(_) => raw(),
                    // Plain text is wrapped so every row is valid JSON.
                    None => json!({
                        "time": iso(l.ts),
                        "source": l.source,
                        "level": l.level,
                        "message": raw(),
                    })
                    .to_string(),
                };
                s.push('\n');
                s
            }
            ExportFormat::Json => {
                let mut o = Map::new();
                o.insert("id".into(), json!(l.id));
                o.insert("time".into(), json!(iso(l.ts)));
                o.insert("source".into(), json!(l.source));
                o.insert("level".into(), json!(l.level));
                for id in &l.ids {
                    o.insert(
                        serde_json::to_value(id.key)
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .into(),
                        json!(id.value),
                    );
                }
                let msg = if self.mask {
                    mask_text(&l.msg)
                } else {
                    l.msg.clone()
                };
                o.insert("msg".into(), json!(msg));
                if let Some(f) = fields.clone() {
                    o.insert("fields".into(), f);
                }
                if self.raw {
                    o.insert("raw".into(), json!(raw()));
                }
                format!("{}\n  {}", if first { "" } else { "," }, Value::Object(o))
            }
            ExportFormat::Csv => {
                let mut cells = Vec::new();
                for col in self.columns() {
                    let v = match col.as_str() {
                        "timestamp" | "time" => iso(l.ts),
                        "ts" => l.ts.to_string(),
                        "level" => l
                            .level
                            .map(|v| json!(v).as_str().unwrap().to_string())
                            .unwrap_or_default(),
                        "source" => l.source.clone(),
                        "msg" | "message"
                            if fields.as_ref().and_then(|f| field_at(f, &col)).is_none() =>
                        {
                            if self.mask {
                                mask_text(&l.msg)
                            } else {
                                l.msg.clone()
                            }
                        }
                        "raw" => raw(),
                        "request_id" | "job_id" | "trace_id" | "correlation_id"
                            if fields.as_ref().and_then(|f| field_at(f, &col)).is_none() =>
                        {
                            l.ids
                                .iter()
                                .find(|i| json!(i.key).as_str() == Some(col.as_str()))
                                .map(|i| i.value.clone())
                                .unwrap_or_default()
                        }
                        _ => fields
                            .as_ref()
                            .and_then(|f| field_at(f, &col))
                            .map(scalar_text)
                            .unwrap_or_default(),
                    };
                    cells.push(csv_cell(&v));
                }
                let mut s = cells.join(",");
                s.push_str("\r\n");
                s
            }
        }
    }
}

fn iso(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// RFC 4180: quote when needed, double the quotes. A leading `=+-@` is
/// prefixed with `'` so a spreadsheet never runs a log line as a formula.
fn csv_cell(v: &str) -> String {
    let v = if v.starts_with(['=', '+', '-', '@']) && v.parse::<f64>().is_err() {
        format!("'{v}")
    } else {
        v.to_string()
    };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

// ── PII masking ─────────────────────────────────────────────────────────────

pub const MASK: &str = "[masked]";

/// Keys whose values are masked whole (compared lowercase, `-` as `_`).
const PII_KEYS: &[&str] = &[
    "email",
    "email_address",
    "e_mail",
    "phone",
    "phone_number",
    "phonenumber",
    "mobile",
    "msisdn",
    "ip",
    "ip_address",
    "ipaddress",
    "client_ip",
    "remote_ip",
    "remote_addr",
    "x_forwarded_for",
    "x_real_ip",
    "cf_connecting_ip",
    "user_agent",
    "useragent",
    "first_name",
    "last_name",
    "full_name",
    "customer_name",
];

fn is_pii_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase().replace('-', "_");
    PII_KEYS.contains(&k.as_str()) || ["_email", "_phone", "_ip"].iter().any(|s| k.ends_with(s))
}

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap());
static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b").unwrap()
});

/// Email addresses and IPv4 addresses inside free text.
pub fn mask_text(s: &str) -> String {
    let s = EMAIL.replace_all(s, MASK);
    IPV4.replace_all(&s, MASK).into_owned()
}

/// Mask PII keys whole and email/IP-looking text anywhere else.
pub fn mask_value(key: Option<&str>, v: &Value) -> Value {
    if key.is_some_and(is_pii_key) && !v.is_null() {
        return json!(MASK);
    }
    match v {
        Value::String(s) => Value::String(mask_text(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| mask_value(None, x)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), mask_value(Some(k), x)))
                .collect(),
        ),
        other => other.clone(),
    }
}

// ── qx_ export tokens ───────────────────────────────────────────────────────

/// How long a Copy-curl token works.
pub const TOKEN_TTL_MS: i64 = 15 * 60_000;

struct Entry {
    /// The exact export query string the token was issued for.
    query: String,
    expires: i64,
    used: bool,
}

/// Read-only export tokens. Only the SHA-256 of a token is kept; a token
/// works once, for one query, for 15 minutes. Kept in memory: a restart
/// simply invalidates outstanding tokens.
#[derive(Default)]
pub struct ExportTokens {
    by_hash: Mutex<HashMap<String, Entry>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    Unknown,
    Expired,
    Used,
    WrongQuery,
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Canonical form of a query string: `&`-separated pairs, sorted, empty
/// values dropped, so the UI and curl agree however the URL was assembled.
pub fn canonical_query(q: &str) -> String {
    let mut pairs: Vec<&str> = q
        .trim_start_matches('?')
        .split('&')
        .filter(|p| !p.is_empty() && !p.ends_with('='))
        .collect();
    pairs.sort_unstable();
    pairs.join("&")
}

impl ExportTokens {
    /// Mint a token for `query`; returns `(token, expires_at)`.
    pub fn issue(&self, query: &str, now: i64) -> (String, i64) {
        let bytes: [u8; 24] = rand::random();
        let token = format!(
            "qx_{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let expires = now + TOKEN_TTL_MS;
        let mut map = self.by_hash.lock().unwrap();
        map.retain(|_, e| e.expires > now && !e.used);
        map.insert(
            hash_token(&token),
            Entry {
                query: canonical_query(query),
                expires,
                used: false,
            },
        );
        (token, expires)
    }

    /// Check and consume a token for this query.
    pub fn redeem(&self, token: &str, query: &str, now: i64) -> Result<(), TokenError> {
        let mut map = self.by_hash.lock().unwrap();
        let e = map.get_mut(&hash_token(token)).ok_or(TokenError::Unknown)?;
        if e.used {
            return Err(TokenError::Used);
        }
        if e.expires <= now {
            return Err(TokenError::Expired);
        }
        if e.query != canonical_query(query) {
            return Err(TokenError::WrongQuery);
        }
        e.used = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    fn line(raw: &str) -> LogLine {
        let mut l = normalize(raw, "api", None, 1_792_000_000_000);
        l.id = 7;
        l
    }

    const J: &str = r#"{"level":30,"msg":"login ok for kofi@example.com","request_id":"req_1","status":200,"user":{"email":"kofi@example.com","ip":"10.0.0.8","plan":"pro"},"user_agent":"Mozilla/5.0","note":"a,b \"c\""}"#;

    #[test]
    fn ndjson_is_raw_and_text_is_wrapped() {
        let f = Formatter::default();
        assert_eq!(f.line(&line(J), true), format!("{J}\n"));
        let t = f.line(&line("plain ERROR from 10.1.2.3"), true);
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["message"], "plain ERROR from 10.1.2.3");
        assert_eq!(v["level"], "error");
    }

    #[test]
    fn masking_hides_pii_keys_and_inline_emails_and_ips() {
        let f = Formatter {
            mask: true,
            ..Default::default()
        };
        let out = f.line(&line(J), true);
        assert!(!out.contains("kofi@example.com"), "{out}");
        assert!(!out.contains("10.0.0.8"));
        assert!(!out.contains("Mozilla"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["user"]["plan"], "pro");
        assert_eq!(v["user"]["email"], MASK);
        assert_eq!(v["msg"], format!("login ok for {MASK}"));
        assert_eq!(v["request_id"], "req_1");
        assert!(f
            .line(&line("from 10.1.2.3 v1.2.3"), true)
            .contains("v1.2.3"));
        assert!(!f.line(&line("from 10.1.2.3"), true).contains("10.1.2.3"));
    }

    #[test]
    fn json_array_and_csv() {
        let f = Formatter {
            format: ExportFormat::Json,
            raw: true,
            ..Default::default()
        };
        let body = format!(
            "{}{}{}{}",
            f.header(),
            f.line(&line(J), true),
            f.line(&line("text"), false),
            f.footer(true)
        );
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
        assert_eq!(v[0]["request_id"], "req_1");
        assert_eq!(v[0]["fields"]["status"], 200);
        assert_eq!(v[1]["raw"], "text");
        let empty: Value =
            serde_json::from_str(&format!("{}{}", f.header(), f.footer(false))).unwrap();
        assert_eq!(empty, json!([]));

        let f = Formatter {
            format: ExportFormat::Csv,
            columns: vec![
                "timestamp".into(),
                "level".into(),
                "request_id".into(),
                "user.plan".into(),
                "note".into(),
                "msg".into(),
            ],
            raw: false,
            mask: true,
        };
        assert_eq!(
            f.header(),
            "timestamp,level,request_id,user.plan,note,msg\r\n"
        );
        assert_eq!(
            f.line(&line(J), true),
            format!(
                "{},info,req_1,pro,\"a,b \"\"c\"\"\",login ok for {MASK}\r\n",
                iso(1_792_000_000_000)
            )
        );
        assert_eq!(csv_cell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
        assert_eq!(csv_cell("-12"), "-12");
    }

    #[test]
    fn tokens_are_hashed_single_use_scoped_and_short_lived() {
        let t = ExportTokens::default();
        let (tok, exp) = t.issue("format=csv&q=dealer", 1_000);
        assert!(tok.starts_with("qx_") && tok.len() == 3 + 48);
        assert_eq!(exp, 1_000 + TOKEN_TTL_MS);
        // Only the hash is stored.
        assert!(!t.by_hash.lock().unwrap().contains_key(&tok));
        assert_eq!(
            t.redeem(&tok, "q=other", 2_000),
            Err(TokenError::WrongQuery)
        );
        assert_eq!(
            t.redeem("qx_nope", "q=dealer&format=csv", 2_000),
            Err(TokenError::Unknown)
        );
        // Order of params doesn't matter.
        assert_eq!(t.redeem(&tok, "q=dealer&format=csv", 2_000), Ok(()));
        assert_eq!(
            t.redeem(&tok, "q=dealer&format=csv", 2_001),
            Err(TokenError::Used)
        );
        let (tok2, _) = t.issue("q=x", 0);
        assert_eq!(
            t.redeem(&tok2, "q=x", TOKEN_TTL_MS),
            Err(TokenError::Expired)
        );
    }
}
