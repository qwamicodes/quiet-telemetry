//! The search language and the query every store answers.
//!
//! `q` is free text plus `key:value` filters, the same string the UI shows
//! as chips and the export curl carries:
//!
//! ```text
//! dealer 88 level:>=warn source:order-worker status:500 -path:/health "exact phrase" -noise
//! ```
//!
//! - bare words and quoted phrases: full text over the raw line (FTS5 in SQLite,
//!   every word is a prefix, so `dealer` finds `dealers`)
//! - `-word`: lines without it
//! - `level:warn` (or `>=warn`, `≥warn`): minimum level
//! - `source:name`: one or more sources (repeat for several)
//! - `id:value`, `request_id:value`, `job_id:…`, `trace_id:…`, `correlation_id:…`:
//!   any line carrying that correlation id (the side index)
//! - any other `key:value`: a field equals value (`err.code:X` walks dots)
//! - `-key:value`: the field is not that value

use crate::hub::Line;
use crate::normalize::Level;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    #[default]
    Newest,
    Oldest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldFilter {
    /// Dot path into the parsed fields (`err.code`).
    pub key: String,
    pub value: String,
    pub negate: bool,
}

/// Position after the last line of a page: `(ts, id)` in the page's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub ts: i64,
    pub id: u64,
}

impl Cursor {
    pub fn of(line: &Line) -> Self {
        Cursor {
            ts: line.ts,
            id: line.id,
        }
    }

    /// Opaque to clients; `<ts>:<id>`.
    pub fn encode(&self) -> String {
        format!("{}:{}", self.ts, self.id)
    }

    pub fn decode(s: &str) -> Option<Self> {
        let (ts, id) = s.split_once(':')?;
        Some(Cursor {
            ts: ts.parse().ok()?,
            id: id.parse().ok()?,
        })
    }

    /// True when `line` comes after this cursor in `order`.
    pub fn before(&self, line: &Line, order: Order) -> bool {
        let k = (line.ts, line.id);
        let c = (self.ts, self.id);
        match order {
            Order::Newest => k < c,
            Order::Oldest => k > c,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchQuery {
    /// Words/phrases that must all appear (case-insensitive).
    pub text: Vec<String>,
    /// Words/phrases that must not appear.
    pub not_text: Vec<String>,
    pub fields: Vec<FieldFilter>,
    /// Empty = every source.
    pub sources: Vec<String>,
    pub min_level: Option<Level>,
    /// Correlation ids; a line matches when it carries any of them.
    pub ids: Vec<String>,
    /// Event time bounds, unix ms, inclusive.
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub order: Order,
    pub cursor: Option<Cursor>,
    pub limit: usize,
    /// When set, the first page also counts every match into this many
    /// buckets over `[since, until]` (needs both bounds).
    pub histogram: Option<usize>,
}

/// Lines per page the API allows.
pub const MAX_PAGE: usize = 1000;

const ID_FIELDS: &[&str] = &["id", "request_id", "job_id", "trace_id", "correlation_id"];

impl SearchQuery {
    /// Parse the `q` language above into this query (adds to what is set).
    pub fn parse_q(mut self, q: &str) -> Self {
        for tok in tokenize(q) {
            let (neg, body) = match tok.strip_prefix('-') {
                Some(rest) if !rest.is_empty() && !tok.quoted => (true, rest.to_string()),
                _ => (false, tok.text.clone()),
            };
            let kv = if tok.quoted {
                None
            } else {
                body.split_once(':')
                    .filter(|(k, v)| !k.is_empty() && !v.is_empty() && !k.contains('/'))
            };
            match kv {
                Some((k, v)) => self.add_filter(k, v, neg),
                None if neg => self.not_text.push(body),
                None => self.text.push(body),
            }
        }
        self
    }

    fn add_filter(&mut self, key: &str, value: &str, negate: bool) {
        let v = value.trim_matches('"').to_string();
        match key {
            "level" | "lvl" if !negate => {
                let name = v.trim_start_matches(['>', '=', '≥']);
                if let Some(l) = Level::parse_name(name) {
                    self.min_level = Some(l);
                }
            }
            "source" if !negate => self.sources.push(v),
            k if ID_FIELDS.contains(&k) && !negate => self.ids.push(v),
            _ => self.fields.push(FieldFilter {
                key: key.to_string(),
                value: v,
                negate,
            }),
        }
    }

    /// Everything except paging and time: does this line match?
    /// The memory store uses it directly; SQLite expresses the same in SQL.
    /// Text is a case-insensitive substring here and a token prefix in FTS5;
    /// for words the two agree.
    pub fn matches(&self, line: &Line) -> bool {
        if !self.sources.is_empty() && !self.sources.iter().any(|s| *s == line.source) {
            return false;
        }
        if let Some(min) = self.min_level {
            match line.level {
                Some(l) if l as u8 >= min as u8 => {}
                _ => return false,
            }
        }
        if !self.ids.is_empty() && !line.ids.iter().any(|i| self.ids.contains(&i.value)) {
            return false;
        }
        let raw = line.raw.to_lowercase();
        if !self.text.iter().all(|t| raw.contains(&t.to_lowercase())) {
            return false;
        }
        if self
            .not_text
            .iter()
            .any(|t| raw.contains(&t.to_lowercase()))
        {
            return false;
        }
        self.fields.iter().all(|f| {
            let got = line.fields.as_ref().and_then(|v| field_at(v, &f.key));
            let eq = got.is_some_and(|g| scalar_eq(g, &f.value));
            eq != f.negate
        })
    }

    pub fn in_time(&self, line: &Line) -> bool {
        self.since.is_none_or(|s| line.ts >= s) && self.until.is_none_or(|u| line.ts <= u)
    }
}

/// The value at a dot path (`err.code`), trying the whole key first so keys
/// that contain dots (`log.level`) still resolve.
pub fn field_at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let obj = v.as_object()?;
    if let Some(x) = obj.get(path) {
        return Some(x);
    }
    let (head, rest) = path.split_once('.')?;
    field_at(obj.get(head)?, rest)
}

/// A field's value as text: strings as-is, numbers/bools as JSON, objects as JSON.
pub fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn scalar_eq(v: &Value, want: &str) -> bool {
    scalar_text(v) == want
}

/// One histogram bar.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
pub struct Bucket {
    /// Bucket start, unix ms.
    pub start: i64,
    pub count: u64,
    pub warn: u64,
    /// error + fatal
    pub error: u64,
}

#[derive(Debug, Clone, Default)]
pub struct SearchPage {
    pub lines: Vec<Line>,
    pub next_cursor: Option<Cursor>,
    /// Matches in the whole range (first page with `histogram` only).
    pub total: Option<u64>,
    /// Raw bytes of those matches (export size estimate).
    pub bytes: Option<u64>,
    pub histogram: Option<Vec<Bucket>>,
    /// Lines stored in the range that was searched.
    pub searched: u64,
}

/// Bucket boundaries for `[since, until]` in `n` bars.
pub fn bucket_width(since: i64, until: i64, n: usize) -> i64 {
    ((until - since).max(1) / n.max(1) as i64).max(1)
}

/// Fold a counted line into histogram buckets (shared by both stores).
pub fn add_to_histogram(h: &mut [Bucket], since: i64, width: i64, ts: i64, level: Option<Level>) {
    if h.is_empty() || ts < since {
        return;
    }
    let i = (((ts - since) / width) as usize).min(h.len() - 1);
    let b = &mut h[i];
    b.count += 1;
    match level {
        Some(Level::Warn) => b.warn += 1,
        Some(Level::Error | Level::Fatal) => b.error += 1,
        _ => {}
    }
}

pub fn empty_histogram(since: i64, width: i64, n: usize) -> Vec<Bucket> {
    (0..n)
        .map(|i| Bucket {
            start: since + width * i as i64,
            ..Default::default()
        })
        .collect()
}

struct Token {
    text: String,
    quoted: bool,
}

impl Token {
    fn strip_prefix(&self, p: char) -> Option<&str> {
        self.text.strip_prefix(p)
    }
}

/// Split on whitespace, keeping `"quoted phrases"` (and `key:"quoted value"`) whole.
fn tokenize(q: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut quoted = false;
    for c in q.chars() {
        match c {
            '"' => {
                // A quote that opens a token makes it a phrase; one inside
                // (`key:"a b"`) only groups the value. Quotes are never kept.
                if !in_quote && cur.is_empty() {
                    quoted = true;
                }
                in_quote = !in_quote;
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(Token {
                        text: std::mem::take(&mut cur),
                        quoted,
                    });
                }
                quoted = false;
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(Token { text: cur, quoted });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use std::sync::Arc;

    fn q(s: &str) -> SearchQuery {
        SearchQuery::default().parse_q(s)
    }

    #[test]
    fn parses_words_filters_and_negation() {
        let s = q(
            r#"dealer 88 level:>=warn source:api -path:/health status:500 "exact phrase" -noise id:req_1"#,
        );
        assert_eq!(s.text, vec!["dealer", "88", "exact phrase"]);
        assert_eq!(s.not_text, vec!["noise"]);
        assert_eq!(s.min_level, Some(Level::Warn));
        assert_eq!(s.sources, vec!["api"]);
        assert_eq!(s.ids, vec!["req_1"]);
        assert_eq!(
            s.fields,
            vec![
                FieldFilter {
                    key: "path".into(),
                    value: "/health".into(),
                    negate: true
                },
                FieldFilter {
                    key: "status".into(),
                    value: "500".into(),
                    negate: false
                },
            ]
        );
        // A URL is text, not a filter.
        assert_eq!(q("GET /api/v1:x").text, vec!["GET", "/api/v1:x"]);
        assert_eq!(q("level:≥error").min_level, Some(Level::Error));
    }

    #[test]
    fn matches_like_sql_would() {
        let line = Arc::new(normalize(
            r#"{"level":40,"msg":"Slow dealers","request_id":"r1","status":500,"err":{"code":"T_O"},"path":"/a"}"#,
            "api",
            None,
            5,
        ));
        assert!(q("slow DEALER").matches(&line));
        assert!(q("status:500 err.code:T_O source:api level:warn").matches(&line));
        assert!(q("request_id:r1").matches(&line));
        assert!(!q("request_id:r2").matches(&line));
        assert!(!q("level:error").matches(&line));
        assert!(!q("-slow").matches(&line));
        assert!(!q("-path:/a").matches(&line));
        assert!(q("-path:/b").matches(&line));
        assert!(!q("source:worker").matches(&line));
    }

    #[test]
    fn cursor_round_trip_and_order() {
        let c = Cursor { ts: -5, id: 9 };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        assert_eq!(Cursor::decode("nope"), None);
        let line = Arc::new(normalize("x", "a", None, 10));
        let c = Cursor { ts: 10, id: 1 };
        assert!(c.before(&line, Order::Newest)); // (10,0) sorts after (10,1) newest-first
        let mut l2 = (*line).clone();
        l2.id = 2;
        assert!(c.before(&Arc::new(l2), Order::Oldest));
    }

    #[test]
    fn histogram_buckets() {
        let w = bucket_width(0, 100, 10);
        let mut h = empty_histogram(0, w, 10);
        add_to_histogram(&mut h, 0, w, 5, Some(Level::Warn));
        add_to_histogram(&mut h, 0, w, 100, Some(Level::Fatal));
        assert_eq!((h[0].count, h[0].warn), (1, 1));
        assert_eq!((h[9].count, h[9].error), (1, 1));
    }
}
