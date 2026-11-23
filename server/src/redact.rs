//! Redaction before storage (plan slice 2).
//!
//! Every line is sanitized in the pipeline after it is parsed and before it is
//! stored, indexed or broadcast, so raw retention, normalized fields, search,
//! the live stream, Copy, Raw and exports all see the same `[REDACTED]` data.
//! There is no reveal switch: what is redacted was never stored.
//!
//! Always redacted:
//! - values under credential keys (`password`, `authorization`, `cookie`,
//!   `api_key`, `*_token`, `*_secret` …), matched on the last key segment,
//!   lowercase, `-` read as `_`;
//! - values shaped like a credential whatever their key: `Bearer …` /
//!   `Basic …` headers, JWTs and PEM private keys, also inside free text.
//!
//! Per source (Sources → Settings → Redact sensitive data): extra keys, as a
//! last segment (`address`) or a dotted path (`customer.address`), and the
//! built-in personal-data groups it hides (email and phone stay visible
//! unless a source rule hides them).
//!
//! Lines already stored are not rewritten.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;

use crate::export::pii_kind;
use crate::normalize::LogLine;
use crate::settings::PiiKind;

pub const REDACTED: &str = "[REDACTED]";

/// Credential key names (last segment, normalised).
pub const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "x_api_key",
    "authorization",
    "proxy_authorization",
    "cookie",
    "set_cookie",
    "card_number",
    "cvv",
    "cvc",
    "private_key",
];

/// Suffixes that also make a key a credential (`csrf_token`, `db_password`).
const SECRET_SUFFIXES: &[&str] = &[
    "_password",
    "_passwd",
    "_secret",
    "_token",
    "_api_key",
    "_apikey",
    "_private_key",
];

fn norm(k: &str) -> String {
    k.to_ascii_lowercase().replace('-', "_")
}

/// Whether a key (any case, `-` or `_`) names a credential.
pub fn secret_key(k: &str) -> bool {
    let n = norm(k);
    SECRET_KEYS.contains(&n.as_str()) || SECRET_SUFFIXES.iter().any(|s| n.ends_with(s))
}

/// A value that is a credential whatever its key: an auth header, a JWT or a
/// PEM private key.
pub fn looks_like_secret(s: &str) -> bool {
    let t = s.trim();
    let auth = ["Bearer ", "Basic ", "bearer ", "basic "].iter().any(|p| {
        t.strip_prefix(p)
            .is_some_and(|rest| rest.trim().len() >= 12)
    });
    let jwt = t.starts_with("eyJ") && t.split('.').count() == 3 && t.len() > 40 && !t.contains(' ');
    auth || jwt || t.contains("-----BEGIN") && t.contains("PRIVATE KEY")
}

/// Already masked: `[REDACTED]`, `[masked]`, `***`, `••••`.
pub fn already_masked(s: &str) -> bool {
    let t = s.trim();
    t.eq_ignore_ascii_case(REDACTED)
        || t.eq_ignore_ascii_case("[masked]")
        || (!t.is_empty() && t.chars().all(|c| matches!(c, '*' | '•' | 'x' | 'X')))
}

/// One source's rules, on top of the built-in ones.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// Extra keys: last segments or dotted paths, normalised.
    pub extra: Vec<String>,
    /// Personal-data groups hidden before storage.
    pub pii: Vec<PiiKind>,
}

impl Redactor {
    pub fn new(extra: &[String], pii: &[PiiKind]) -> Self {
        Self {
            extra: extra
                .iter()
                .map(|e| norm(e.trim()))
                .filter(|e| !e.is_empty())
                .collect(),
            pii: pii.to_vec(),
        }
    }

    fn hides_key(&self, path: &str, key: &str) -> bool {
        if secret_key(key) {
            return true;
        }
        if pii_kind(key).is_some_and(|k| self.pii.contains(&k)) {
            return true;
        }
        if self.extra.is_empty() {
            return false;
        }
        let (k, p) = (norm(key), norm(path));
        self.extra.iter().any(|e| *e == k || *e == p)
    }

    /// Redact a parsed value in place. Returns how many values were replaced.
    pub fn value(&self, v: &mut Value) -> usize {
        self.walk(v, "", None, 0)
    }

    fn walk(&self, v: &mut Value, path: &str, key: Option<&str>, depth: usize) -> usize {
        if key.is_some_and(|k| self.hides_key(path, k)) {
            match v {
                // A credential key holding an object: redact what's inside,
                // keeping its shape readable (`authorization: {scheme, …}`).
                Value::Object(_) => {}
                Value::Null | Value::Bool(_) => return 0,
                Value::String(s) if s.trim().is_empty() || already_masked(s) => return 0,
                _ => {
                    *v = Value::String(REDACTED.into());
                    return 1;
                }
            }
            if let Value::Object(o) = v {
                let mut n = 0;
                for (_, x) in o.iter_mut() {
                    if !matches!(x, Value::Null | Value::Bool(_) | Value::Object(_)) {
                        *x = Value::String(REDACTED.into());
                        n += 1;
                    }
                }
                return n;
            }
        }
        match v {
            Value::String(s) => {
                if already_masked(s) {
                    return 0;
                }
                if looks_like_secret(s) {
                    *s = REDACTED.into();
                    return 1;
                }
                let (out, n) = self.text(s);
                if n > 0 {
                    *s = out;
                }
                n
            }
            Value::Array(a) if depth < 16 => a
                .iter_mut()
                .map(|x| self.walk(x, path, None, depth + 1))
                .sum(),
            Value::Object(o) if depth < 16 => o
                .iter_mut()
                .map(|(k, x)| {
                    let p = if path.is_empty() {
                        k.clone()
                    } else {
                        format!("{path}.{k}")
                    };
                    self.walk(x, &p, Some(k), depth + 1)
                })
                .sum(),
            _ => 0,
        }
    }

    /// Redact free text: credential shapes, `key=value` / `"key": "value"`
    /// pairs whose key is hidden, and emails when the source hides them.
    pub fn text(&self, s: &str) -> (String, usize) {
        let mut n = 0;
        let mut out = std::borrow::Cow::Borrowed(s);
        if s.contains("PRIVATE KEY") {
            out = replace(&PEM, &out, &mut n, |_| REDACTED.to_string());
        }
        if s.contains("eyJ") {
            out = replace(&JWT, &out, &mut n, |_| REDACTED.to_string());
        }
        out = replace(&AUTH, &out, &mut n, |c| format!("{} {REDACTED}", &c[1]));
        out = replace(&PAIR, &out, &mut n, |c| {
            let key = &c[2];
            let val = c[4].trim_matches('"');
            let scheme = ["bearer", "basic"].contains(&val.to_ascii_lowercase().as_str());
            if !self.hides_key(key, key) || already_masked(val) || scheme {
                return c[0].to_string();
            }
            if c[4].starts_with('"') {
                format!("{}{}{}\"{REDACTED}\"", &c[1], &c[2], &c[3])
            } else {
                format!("{}{}{}{REDACTED}", &c[1], &c[2], &c[3])
            }
        });
        if self.pii.contains(&PiiKind::Email) && s.contains('@') {
            out = replace(&EMAIL, &out, &mut n, |_| REDACTED.to_string());
        }
        (out.into_owned(), n)
    }

    /// Sanitize a normalized line in place: fields, raw text and the row
    /// summary. Adds a `redacted:N` flag when anything was replaced.
    pub fn line(&self, l: &mut LogLine) -> usize {
        let mut n = 0;
        if let Some(f) = l.fields.as_mut() {
            n += self.value(f);
        }
        // Raw: re-serialize when it is a JSON object (key order is kept),
        // otherwise redact it as text. A cut JSON line is text.
        let raw_n = match serde_json::from_str::<Value>(&l.raw) {
            Ok(mut v @ Value::Object(_)) => {
                let k = self.value(&mut v);
                if k > 0 {
                    l.raw = v.to_string();
                }
                k
            }
            _ => {
                let (out, k) = self.text(&l.raw);
                if k > 0 {
                    l.raw = out;
                }
                k
            }
        };
        let (msg, msg_n) = self.text(&l.msg);
        if msg_n > 0 {
            l.msg = msg;
        }
        // Fields and raw hold the same values for JSON lines; count once.
        let total = n.max(raw_n).max(msg_n);
        if total > 0 {
            l.flags.push(format!("redacted:{total}"));
        }
        total
    }
}

fn replace<'a>(
    re: &Regex,
    s: &std::borrow::Cow<'a, str>,
    n: &mut usize,
    f: impl Fn(&Captures) -> String,
) -> std::borrow::Cow<'a, str> {
    let mut hits = 0;
    let out = re.replace_all(s, |c: &Captures| {
        let r = f(c);
        if r != c[0] {
            hits += 1;
        }
        r
    });
    *n += hits;
    match out {
        std::borrow::Cow::Borrowed(_) => s.clone(),
        std::borrow::Cow::Owned(o) => std::borrow::Cow::Owned(o),
    }
}

static PEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")
        .unwrap()
});
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}").unwrap()
});
static AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(Bearer|Basic|bearer|basic) +[A-Za-z0-9._~+/=-]{12,}").unwrap()
});
/// `key=value`, `key: value`, `"key":"value"` (logfmt, headers, JSON text).
static PAIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\b|")([A-Za-z][\w.-]{1,63})("?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,;&"}\]]+)"#)
        .unwrap()
});
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use serde_json::json;

    fn r() -> Redactor {
        Redactor::default()
    }

    #[test]
    fn credential_keys_and_shapes_are_redacted_email_stays() {
        let mut v = json!({
            "flow": "login",
            "user": {"email": "kofi@example.com", "password": "hunter2"},
            "request": {"headers": {"Authorization": "Bearer abcdefghijklmnop", "X-Api-Key": "k_123", "accept": "*/*"}},
            "csrf_token": "t1",
            "token_count": 4,
            "note": "sent eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U to client",
            "pin": null,
            "already": "[REDACTED]"
        });
        let n = r().value(&mut v);
        assert_eq!(n, 5);
        assert_eq!(v["user"]["email"], "kofi@example.com");
        assert_eq!(v["user"]["password"], REDACTED);
        assert_eq!(v["request"]["headers"]["Authorization"], REDACTED);
        assert_eq!(v["request"]["headers"]["X-Api-Key"], REDACTED);
        assert_eq!(v["request"]["headers"]["accept"], "*/*");
        assert_eq!(v["csrf_token"], REDACTED);
        assert_eq!(v["token_count"], 4);
        assert_eq!(v["note"], "sent [REDACTED] to client");
    }

    #[test]
    fn source_rules_add_keys_and_hide_email() {
        let red = Redactor::new(
            &["customer.address".into(), "iban".into()],
            &[PiiKind::Email],
        );
        let mut v = json!({"customer": {"address": "12 Ring Rd", "city": "Accra"}, "iban": "GH00", "address": "kept", "email": "a@b.co", "msg": "mail a@b.co"});
        assert_eq!(red.value(&mut v), 4);
        assert_eq!(v["customer"]["address"], REDACTED);
        assert_eq!(v["customer"]["city"], "Accra");
        assert_eq!(v["address"], "kept");
        assert_eq!(v["msg"], "mail [REDACTED]");
    }

    #[test]
    fn plain_text_pairs_headers_and_keys() {
        let (out, n) = r().text(
            "login failed password=hunter2 user=kofi Authorization: Bearer abcdefghijklmnop api_key=\"x y\"",
        );
        assert_eq!(
            out,
            "login failed password=[REDACTED] user=kofi Authorization: Bearer [REDACTED] api_key=\"[REDACTED]\""
        );
        assert_eq!(n, 3);
        let (out, _) = r()
            .text("key -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- end");
        assert_eq!(out, "key [REDACTED] end");
    }

    #[test]
    fn a_line_is_sanitized_everywhere_and_flagged() {
        let raw = r#"{"level":"info","flow":"login","msg":"ok","request_id":"req_1","password":"hunter2","headers":{"cookie":"sid=abc"}}"#;
        let mut l = normalize(raw, "api", None, 0);
        assert_eq!(r().line(&mut l), 2);
        assert!(!l.raw.contains("hunter2") && !l.raw.contains("sid=abc"));
        assert!(
            l.raw.starts_with(r#"{"level":"info","flow":"login""#),
            "key order kept"
        );
        assert_eq!(l.fields.as_ref().unwrap()["password"], REDACTED);
        assert!(l.flags.contains(&"redacted:2".to_string()));
        // Plain text and a clean line.
        let mut t = normalize("GET /login?token=abc123 200", "api", None, 0);
        assert_eq!(r().line(&mut t), 1);
        assert!(t.raw.contains("token=[REDACTED]"));
        let mut c = normalize(r#"{"flow":"x","status_code":200}"#, "api", None, 0);
        assert_eq!(r().line(&mut c), 0);
        assert!(!c.flags.iter().any(|f| f.starts_with("redacted")));
    }
}
