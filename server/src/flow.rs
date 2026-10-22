//! Flows: every line that shares a correlation id, stitched across ids.
//!
//! Opening an id (or a line) walks the id index breadth first:
//!
//! - hop 0: every line carrying the opened id(s), in the window, all sources
//! - hop n: the other ids found on those lines (a worker line carrying
//!   `job_id` + `request_id` links the request to its job and the job's
//!   retries), looked up the same way
//!
//! The walk is bounded three ways so a hot id (a constant `trace_id`, a
//! `job_id` of `1`) can't pull in the whole window: [`Limits::hops`],
//! [`Limits::ids`] and [`Limits::lines`]. Hitting one marks the flow
//! `truncated` instead of failing.
//!
//! The stitched lines become ordered step nodes ([`build`]): one node per
//! line, sorted by when the work started (`ts − duration_ms`, since a
//! canonical line is written when the work ends), with child steps from
//! `wideEvents.calls` / `wideEvents.steps`, edges inside a source (`next`,
//! `retry`) and across sources (`handoff`, labelled with the shared id).
//!
//! Lines that carry OTLP span ids (spans from `/v1/traces`, or any line with
//! `span_id` + `parent_span_id`) also form a span tree: each such node points
//! at its parent span (`parent`, `depth`), and a `child` edge replaces the
//! time-order edge into it. Log records carrying a `span_id` hang under that
//! span.

use crate::hub::Line;
use crate::normalize::{CorrId, IdKey, Level, LogLine};
use crate::search::field_at;
use crate::store::Store;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

/// How far a walk may go.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Id hops after the opened ids (request → job is one hop).
    pub hops: usize,
    /// Distinct ids followed in total.
    pub ids: usize,
    /// Lines in one flow.
    pub lines: usize,
    /// Settings → Flow id order → "match ids by key": an id only links lines
    /// that carry it under the same key (the opened id matches any key).
    pub by_key: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            hops: 2,
            ids: 64,
            lines: 1000,
            by_key: false,
        }
    }
}

/// What a walk found, before it is shaped into nodes.
#[derive(Debug, Clone, Default)]
pub struct Stitched {
    /// Oldest first by event time.
    pub lines: Vec<Line>,
    /// Every id followed, in discovery order.
    pub ids: Vec<CorrId>,
    /// A limit cut the walk short.
    pub truncated: bool,
}

/// Where a walk starts.
pub enum Seed<'a> {
    /// A correlation id value (any key).
    Id(&'a str),
    /// A line: its own ids, and the line itself even when it carries none.
    Line(Line),
}

/// Walk the id index from `seed` within `[since, until]`.
pub async fn stitch(
    store: &dyn Store,
    seed: Seed<'_>,
    since: i64,
    until: i64,
    limits: Limits,
) -> anyhow::Result<Stitched> {
    let mut out = Stitched::default();
    let mut lines: HashMap<u64, Line> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = Vec::new();
    // Ids followed with the key they were found under (used when matching by key).
    let mut keyed: HashSet<(IdKey, String)> = HashSet::new();
    let mut opened_any: Option<String> = None;
    match seed {
        Seed::Id(v) => {
            seen.insert(v.to_string());
            frontier.push(v.to_string());
            opened_any = Some(v.to_string());
        }
        Seed::Line(l) => {
            for i in &l.ids {
                keyed.insert((i.key.clone(), i.value.clone()));
                if seen.insert(i.value.clone()) {
                    frontier.push(i.value.clone());
                }
            }
            lines.insert(l.id, l);
        }
    }
    // Keys come from the lines, so an id opened by value learns its key here.
    let mut pending: Vec<String> = frontier.clone();

    for hop in 0..=limits.hops {
        if frontier.is_empty() {
            break;
        }
        let room = limits.lines.saturating_sub(lines.len());
        // Ask for one more than fits (plus what we hold) to know it was cut.
        let got = store
            .with_ids(&frontier, since, until, room + lines.len() + 1)
            .await?;
        let mut next: Vec<String> = Vec::new();
        let asked: HashSet<&String> = frontier.iter().collect();
        for l in got {
            if lines.contains_key(&l.id) {
                continue;
            }
            // The index can hold ids a source no longer counts (its id keys
            // changed after the line was stored; `normalize` re-derives ids
            // with the current policy), and by key only same-key ids link.
            let links = l.ids.iter().any(|i| {
                asked.contains(&i.value)
                    && (!limits.by_key
                        || opened_any.as_ref() == Some(&i.value)
                        || keyed.contains(&(i.key.clone(), i.value.clone())))
            });
            if !links {
                continue;
            }
            if lines.len() >= limits.lines {
                out.truncated = true;
                break;
            }
            for i in &l.ids {
                keyed.insert((i.key.clone(), i.value.clone()));
                if !seen.contains(&i.value) {
                    if seen.len() >= limits.ids {
                        out.truncated = true;
                        continue;
                    }
                    seen.insert(i.value.clone());
                    next.push(i.value.clone());
                }
            }
            lines.insert(l.id, l);
        }
        if hop == limits.hops && !next.is_empty() {
            // Ids we found but may not follow.
            out.truncated = true;
        }
        pending.extend(next.iter().cloned());
        frontier = next;
    }

    let mut lines: Vec<Line> = lines.into_values().collect();
    lines.sort_by_key(|l| (l.ts, l.id));
    // Each followed id with the key it was logged under.
    for v in pending {
        let key = lines
            .iter()
            .flat_map(|l| l.ids.iter())
            .find(|i| i.value == v)
            .map(|i| i.key.clone());
        if let Some(key) = key {
            out.ids.push(CorrId { key, value: v });
        }
    }
    out.lines = lines;
    Ok(out)
}

/// The oldest stored line counts as an expiry edge only when it sits at the
/// start of the window (retention drops whole hours, so within an hour of
/// it). A young database's oldest line is just its first line.
pub fn expiry_edge(oldest_stored: Option<i64>, window_since: i64) -> Option<i64> {
    oldest_stored.filter(|o| *o <= window_since + 3_600_000)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum FlowStatus {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    /// The next step in the same source.
    Next,
    /// Another attempt of the same job.
    Retry,
    /// Work moving to another source (request → worker), via a shared id.
    Handoff,
    /// A span (or a log record) inside its parent span (trace_id span tree).
    Child,
}

/// A step inside a line (`wideEvents.calls` / `wideEvents.steps`).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct ChildStep {
    pub name: String,
    /// `target · status · error`, whatever the call carried.
    pub summary: String,
    /// Offset from the start of the parent line's work, ms.
    pub at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowNode {
    /// Position in the flow (0-based); edges point at it.
    pub index: u32,
    pub line_id: u64,
    pub source: String,
    pub level: Option<Level>,
    /// When the line was written (end of the work), unix ms.
    pub ts: i64,
    /// When the work started: `ts − duration_ms`, else `ts`.
    pub start: i64,
    pub duration_ms: Option<i64>,
    /// `start` minus the flow's start, ms.
    pub offset_ms: i64,
    /// Step name: `METHOD path`, else operation / step / phase / event, else the message.
    pub name: String,
    /// `status · outcome · error code · attempt`.
    pub summary: String,
    pub error: bool,
    pub warn: bool,
    /// `attempt` / `retry_attempt` when the line carries one.
    pub attempt: Option<u32>,
    pub children: Vec<ChildStep>,
    /// The OTLP span this line is (or was logged in), hex.
    pub span_id: Option<String>,
    /// The node of the parent span, when the flow has a span tree.
    pub parent: Option<u32>,
    /// Depth in the span tree (0 = a root, or no span tree).
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowEdge {
    pub from: u32,
    pub to: u32,
    pub kind: EdgeKind,
    /// The id both ends carry (handoffs).
    pub via: Option<CorrId>,
    /// Time between the end of `from` and the start of `to`, ms (backoff for retries).
    pub gap_ms: i64,
}

/// The numbers a flow header (and a search group) shows.
#[derive(Debug, Clone, Serialize, TS)]
pub struct FlowSummary {
    /// Stable for one flow whichever of its ids opened it: the first line's id.
    pub key: String,
    pub title: String,
    pub status: FlowStatus,
    /// Lines stitched.
    pub line_count: u32,
    /// Nodes plus their child steps.
    pub steps: u32,
    /// In order of first appearance.
    pub sources: Vec<String>,
    /// Unix ms.
    pub started: i64,
    pub ended: i64,
    pub duration_ms: i64,
    /// Highest attempt number seen (0 = no retries).
    pub retries: u32,
    pub errors: u32,
    pub warnings: u32,
    /// Every id stitched, in discovery order.
    pub ids: Vec<CorrId>,
    /// Distinct id keys in discovery order (`request_id → job_id`).
    pub stitched_by: Vec<IdKey>,
    /// A walk limit was hit; some lines may be missing.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Flow {
    #[serde(flatten)]
    pub summary: FlowSummary,
    /// The id that was opened (with the key it was logged under).
    pub opened: Option<CorrId>,
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    /// The lines, in node order, so the field card needs no second request.
    #[ts(as = "Vec<LogLine>")]
    pub lines: Vec<Line>,
    /// A request id the flow's jobs carry but no line of its own in the window
    /// (expired, sampled out, or not logged).
    pub missing_parent: Option<CorrId>,
    /// Retention has been dropping hours and the flow starts within a minute
    /// of the oldest line still stored, so earlier lines may have expired.
    pub partial: bool,
    /// Some nodes have a parent span: the flow reads as a span tree
    /// (`parent` / `depth` on nodes, `child` edges).
    pub span_tree: bool,
}

const DURATION_KEYS: &[&str] = &[
    "duration_ms",
    "durationMs",
    "elapsed_ms",
    "took_ms",
    "response_time_ms",
    "responseTime",
    "duration",
];
const METHOD_KEYS: &[&str] = &[
    "method",
    "http_method",
    "http.request.method",
    "http.method",
];
const PATH_KEYS: &[&str] = &[
    "path",
    "url",
    "route",
    "http.route",
    "url.path",
    "http.target",
];
const STATUS_KEYS: &[&str] = &[
    "status",
    "status_code",
    "statusCode",
    "http.response.status_code",
    "http.status_code",
];
const NAME_KEYS: &[&str] = &["operation", "step", "phase", "event", "name", "job_name"];
const ATTEMPT_KEYS: &[&str] = &["attempt", "retry_attempt", "attemptsMade", "attempts"];
const FAILED: &[&str] = &["failed", "failure", "error", "errored", "fatal"];
const WARNED: &[&str] = &[
    "retry",
    "retrying",
    "partial",
    "needs_review",
    "slow",
    "timeout",
];

fn num(fields: Option<&Value>, keys: &[&str]) -> Option<f64> {
    let f = fields?;
    keys.iter().find_map(|k| match field_at(f, k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    })
}

fn text(fields: Option<&Value>, keys: &[&str]) -> Option<String> {
    let f = fields?;
    keys.iter().find_map(|k| match field_at(f, k)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn is_request(l: &LogLine) -> bool {
    let f = l.fields.as_ref();
    text(f, METHOD_KEYS).is_some() && text(f, PATH_KEYS).is_some()
}

fn step_name(l: &LogLine) -> String {
    let f = l.fields.as_ref();
    if let (Some(m), Some(p)) = (text(f, METHOD_KEYS), text(f, PATH_KEYS)) {
        return format!("{m} {p}");
    }
    text(f, NAME_KEYS).unwrap_or_else(|| l.msg.clone())
}

fn status_of(l: &LogLine) -> Option<i64> {
    num(l.fields.as_ref(), STATUS_KEYS).map(|n| n as i64)
}

fn outcome_of(l: &LogLine) -> Option<String> {
    text(l.fields.as_ref(), &["outcome", "result"]).map(|s| s.to_ascii_lowercase())
}

fn error_code(l: &LogLine) -> Option<String> {
    text(
        l.fields.as_ref(),
        &["err.code", "error.code", "err.name", "error.name"],
    )
}

fn node_flags(l: &LogLine) -> (bool, bool) {
    let level = l.level.map_or(0, |v| v as u8);
    let status = status_of(l);
    let outcome = outcome_of(l);
    let error = level >= Level::Error as u8
        || status.is_some_and(|s| s >= 500)
        || outcome.as_deref().is_some_and(|o| FAILED.contains(&o));
    let warn = !error
        && (level == Level::Warn as u8
            || status.is_some_and(|s| (400..500).contains(&s))
            || outcome.as_deref().is_some_and(|o| WARNED.contains(&o)));
    (error, warn)
}

fn summary_of(l: &LogLine, attempt: Option<u32>) -> String {
    let f = l.fields.as_ref();
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = status_of(l) {
        parts.push(s.to_string());
    }
    if let Some(o) = outcome_of(l) {
        parts.push(o);
    }
    if let Some(c) = error_code(l) {
        parts.push(c);
    }
    if let Some(a) = attempt {
        parts.push(format!("attempt {a}"));
    }
    // The queue says little on every node of a job; only when nothing else does.
    if parts.is_empty() {
        if let Some(q) = text(f, &["queue"]) {
            parts.push(q);
        }
    }
    if parts.is_empty() && l.msg != step_name(l) {
        parts.push(l.msg.clone());
    }
    parts.join(" · ")
}

/// Child steps from `wideEvents.calls`, `wideEvents.steps` or a top-level `steps`.
fn children_of(l: &LogLine) -> Vec<ChildStep> {
    let Some(f) = l.fields.as_ref() else {
        return Vec::new();
    };
    let list = [
        "wideEvents.calls",
        "wideEvents.steps",
        "wide_events.calls",
        "steps",
    ]
    .iter()
    .find_map(|k| field_at(f, k).and_then(Value::as_array));
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|c| {
            let c = c.as_object()?;
            let s = |k: &str| match c.get(k) {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            };
            let n = |k: &str| c.get(k).and_then(Value::as_f64).map(|v| v as i64);
            let name = s("name")
                .or_else(|| match (s("provider"), s("action")) {
                    (Some(p), Some(a)) => Some(format!("{p}.{a}")),
                    (p, a) => a.or(p),
                })
                .or_else(|| s("operation"))
                .or_else(|| s("target"))?;
            let error = c.get("ok").and_then(Value::as_bool) == Some(false)
                || c.get("error").is_some_and(|e| !e.is_null())
                || n("status").is_some_and(|v| v >= 500);
            let summary = ["target", "status", "job_id", "error"]
                .iter()
                .filter_map(|k| s(k))
                .collect::<Vec<_>>()
                .join(" · ");
            Some(ChildStep {
                name,
                summary,
                at_ms: n("at_ms"),
                duration_ms: n("duration_ms"),
                error,
            })
        })
        .collect()
}

/// Prefer the most specific shared id for a handoff label.
fn shared_id(a: &LogLine, b: &LogLine) -> Option<CorrId> {
    let order = [
        IdKey::JobId,
        IdKey::TraceId,
        IdKey::CorrelationId,
        IdKey::RequestId,
    ];
    order
        .iter()
        .find_map(|k| {
            b.ids
                .iter()
                .find(|i| i.key == *k && a.ids.iter().any(|x| x.value == i.value))
                .cloned()
        })
        // Custom id fields (Settings → Flow id order) come after the built-ins.
        .or_else(|| {
            b.ids
                .iter()
                .find(|i| i.key.is_custom() && a.ids.iter().any(|x| x.value == i.value))
                .cloned()
        })
}

/// Shape stitched lines into a flow. `expiry_edge` is the oldest stored line
/// when retention has been dropping data (see [`expiry_edge`]), else `None`.
pub fn build(st: Stitched, opened: Option<&str>, expiry_edge: Option<i64>) -> Flow {
    let mut lines = st.lines;
    let mut nodes: Vec<FlowNode> = lines
        .iter()
        .map(|l| {
            let duration_ms = num(l.fields.as_ref(), DURATION_KEYS)
                .map(|d| d.round() as i64)
                .filter(|d| *d >= 0);
            let attempt = num(l.fields.as_ref(), ATTEMPT_KEYS).map(|a| a.max(0.0) as u32);
            let (error, warn) = node_flags(l);
            FlowNode {
                index: 0,
                line_id: l.id,
                source: l.source.clone(),
                level: l.level,
                ts: l.ts,
                start: l.ts - duration_ms.unwrap_or(0),
                duration_ms,
                offset_ms: 0,
                name: step_name(l),
                summary: summary_of(l, attempt),
                error,
                warn,
                attempt,
                children: children_of(l),
                span_id: text(l.fields.as_ref(), &["span_id", "spanId"]),
                parent: None,
                depth: 0,
            }
        })
        .collect();
    // Order by when the work started; ties keep arrival (line id) order.
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| (nodes[i].start, nodes[i].line_id));
    nodes = order.iter().map(|&i| nodes[i].clone()).collect();
    lines = order.iter().map(|&i| lines[i].clone()).collect();

    let started = nodes.iter().map(|n| n.start).min().unwrap_or(0);
    let ended = nodes.iter().map(|n| n.ts).max().unwrap_or(started);
    let mut sources: Vec<String> = Vec::new();
    for (i, n) in nodes.iter_mut().enumerate() {
        n.index = i as u32;
        n.offset_ms = n.start - started;
        if !sources.contains(&n.source) {
            sources.push(n.source.clone());
        }
    }

    // Edges: the previous node of the same source, else a handoff from the
    // latest earlier node of another source that shares an id.
    let mut edges = Vec::new();
    let mut last_in: HashMap<&str, usize> = HashMap::new();
    for i in 0..nodes.len() {
        let n = &nodes[i];
        if let Some(&p) = last_in.get(n.source.as_str()) {
            let prev = &nodes[p];
            let same_job = shared_id(&lines[p], &lines[i]).is_some_and(|c| c.key == IdKey::JobId);
            let retry = same_job
                && match (prev.attempt, n.attempt) {
                    (Some(a), Some(b)) => b > a,
                    _ => false,
                }
                && prev.name == n.name;
            edges.push(FlowEdge {
                from: p as u32,
                to: i as u32,
                kind: if retry {
                    EdgeKind::Retry
                } else {
                    EdgeKind::Next
                },
                via: None,
                gap_ms: n.start - prev.ts,
            });
        } else if i > 0 {
            let from = (0..i)
                .rev()
                .find(|&j| nodes[j].source != n.source && shared_id(&lines[j], &lines[i]).is_some())
                .or_else(|| (0..i).rev().find(|&j| nodes[j].source != n.source));
            if let Some(j) = from {
                edges.push(FlowEdge {
                    from: j as u32,
                    to: i as u32,
                    kind: EdgeKind::Handoff,
                    via: shared_id(&lines[j], &lines[i]),
                    gap_ms: n.start - nodes[j].start,
                });
            }
        }
        last_in.insert(nodes[i].source.as_str(), i);
    }

    let span_tree = span_tree(&mut nodes, &lines, &mut edges);

    // Title: the request, else the step name that repeats most (a job's
    // operation across its attempts), else the first step.
    let title = nodes
        .iter()
        .zip(&lines)
        .find(|(_, l)| is_request(l))
        .map(|(n, _)| n.name.clone())
        .or_else(|| {
            let mut count: Vec<(&str, usize)> = Vec::new();
            for n in &nodes {
                match count.iter_mut().find(|(k, _)| *k == n.name) {
                    Some(c) => c.1 += 1,
                    None => count.push((n.name.as_str(), 1)),
                }
            }
            count
                .iter()
                .max_by_key(|(_, c)| *c)
                .filter(|(_, c)| *c > 1)
                .map(|(k, _)| k.to_string())
        })
        .or_else(|| nodes.first().map(|n| n.name.clone()))
        .unwrap_or_default();

    // Status: an error that nothing in its source recovered from (the last
    // node of a source failed, or a request failed) is an error; any other
    // problem is a warning.
    let last_of_source_failed = sources.iter().any(|s| {
        nodes
            .iter()
            .rev()
            .find(|n| &n.source == s)
            .is_some_and(|n| n.error)
    });
    let request_failed = nodes
        .iter()
        .zip(&lines)
        .any(|(n, l)| n.error && is_request(l));
    let errors = nodes.iter().filter(|n| n.error).count() as u32;
    let warnings = nodes.iter().filter(|n| n.warn).count() as u32;
    let status = if last_of_source_failed || request_failed {
        FlowStatus::Error
    } else if errors + warnings > 0 {
        FlowStatus::Warn
    } else {
        FlowStatus::Ok
    };

    let mut stitched_by: Vec<IdKey> = Vec::new();
    for i in &st.ids {
        if !stitched_by.contains(&i.key) {
            stitched_by.push(i.key.clone());
        }
    }
    let opened = opened.and_then(|v| st.ids.iter().find(|i| i.value == v).cloned());

    // A request id carried only by job lines: its request isn't here.
    let missing_parent = st
        .ids
        .iter()
        .filter(|i| i.key == IdKey::RequestId)
        .find(|i| {
            !lines.iter().any(|l| {
                l.ids.iter().any(|x| x.value == i.value)
                    && !l.ids.iter().any(|x| x.key == IdKey::JobId)
            }) && lines
                .iter()
                .any(|l| l.ids.iter().any(|x| x.key == IdKey::JobId))
        })
        .cloned();

    let summary = FlowSummary {
        key: lines.first().map(|l| l.id.to_string()).unwrap_or_default(),
        title,
        status,
        line_count: nodes.len() as u32,
        steps: nodes.iter().map(|n| 1 + n.children.len() as u32).sum(),
        sources,
        started,
        ended,
        duration_ms: ended - started,
        retries: nodes.iter().filter_map(|n| n.attempt).max().unwrap_or(0),
        errors,
        warnings,
        ids: st.ids,
        stitched_by,
        truncated: st.truncated,
    };
    Flow {
        summary,
        opened,
        nodes,
        edges,
        lines,
        missing_parent,
        partial: expiry_edge.is_some_and(|o| started - o < 60_000),
        span_tree,
    }
}

/// Hang span nodes under their parent span and log records under their span;
/// a `child` edge replaces the time-order edge into each. Returns whether
/// any node found a parent.
fn span_tree(nodes: &mut [FlowNode], lines: &[Line], edges: &mut Vec<FlowEdge>) -> bool {
    let info: Vec<(Option<String>, Option<String>, bool)> = lines
        .iter()
        .map(|l| {
            let f = l.fields.as_ref();
            let span = text(f, &["span_id", "spanId"]);
            let parent = text(f, &["parent_span_id", "parentSpanId"]);
            let is_span = parent.is_some() || text(f, &["otel.type"]).as_deref() == Some("span");
            (span, parent, is_span)
        })
        .collect();
    let mut by_span: HashMap<&str, usize> = HashMap::new();
    for (i, (span, _, is_span)) in info.iter().enumerate() {
        if let (Some(s), true) = (span, is_span) {
            by_span.entry(s.as_str()).or_insert(i);
        }
    }
    if by_span.is_empty() {
        return false;
    }
    let mut any = false;
    for (i, (span, parent, is_span)) in info.iter().enumerate() {
        let up = if *is_span { parent } else { span };
        let p = up
            .as_deref()
            .and_then(|s| by_span.get(s).copied())
            .filter(|&p| p != i);
        if let Some(p) = p {
            any = true;
            nodes[i].parent = Some(p as u32);
            edges.retain(|e| e.to != i as u32);
            edges.push(FlowEdge {
                from: p as u32,
                to: i as u32,
                kind: EdgeKind::Child,
                via: None,
                gap_ms: nodes[i].start - nodes[p].start,
            });
        }
    }
    // Depth by walking up; a cycle (bad data) stops at the node count.
    for i in 0..nodes.len() {
        let (mut d, mut at) = (0u32, nodes[i].parent);
        while let Some(p) = at {
            d += 1;
            if d as usize >= nodes.len() {
                break;
            }
            at = nodes[p as usize].parent;
        }
        nodes[i].depth = d;
    }
    edges.sort_by_key(|e| (e.to, e.from));
    any
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::SourceKind;
    use crate::normalize::normalize;
    use crate::store::{MemoryStore, SqliteOptions, SqliteStore};
    use std::sync::Arc;

    const T0: i64 = 1_792_000_000_000;
    const WIDE: (i64, i64) = (T0 - 3_600_000, T0 + 3_600_000);

    fn line(id: u64, source: &str, raw: &str, ts: i64) -> Line {
        let mut l = normalize(raw, source, None, ts);
        l.id = id;
        Arc::new(l)
    }

    /// A request, its job (carrying the request id in `data`), and the job's
    /// retry and final failure (job id only), plus an unrelated request.
    fn fixture() -> Vec<(SourceKind, Line)> {
        vec![
            (
                SourceKind::Docker,
                line(
                    1,
                    "api",
                    r#"{"level":30,"method":"POST","path":"/api/v1/payouts","status":201,"duration_ms":120,"request_id":"req_1","wideEvents":{"calls":[{"name":"db.insert","at_ms":5,"duration_ms":30,"ok":true},{"provider":"bullmq","action":"add","at_ms":40,"duration_ms":4,"job_id":"payout:1"}]}}"#,
                    T0 + 120,
                ),
            ),
            (
                SourceKind::Docker,
                line(
                    2,
                    "worker",
                    r#"{"level":30,"phase":"picked_up","job_id":"payout:1","data":{"request_id":"req_1"},"queue":"payouts"}"#,
                    T0 + 200,
                ),
            ),
            (
                SourceKind::Docker,
                line(
                    3,
                    "worker",
                    r#"{"level":40,"operation":"settle","job_id":"payout:1","attempt":0,"outcome":"retry","duration_ms":800,"err":{"code":"TIMEOUT"}}"#,
                    T0 + 1_100,
                ),
            ),
            (
                SourceKind::Docker,
                line(
                    4,
                    "worker",
                    r#"{"level":50,"operation":"settle","job_id":"payout:1","attempt":1,"outcome":"failed","duration_ms":600,"err":{"code":"TIMEOUT"}}"#,
                    T0 + 3_800,
                ),
            ),
            (
                SourceKind::Docker,
                line(
                    5,
                    "api",
                    r#"{"level":30,"method":"GET","path":"/health","status":200,"request_id":"req_2"}"#,
                    T0 + 50,
                ),
            ),
        ]
    }

    async fn memory() -> MemoryStore {
        let s = MemoryStore::new(100);
        for (k, l) in fixture() {
            s.append(k, &[l]).await.unwrap();
        }
        s
    }

    async fn sqlite() -> SqliteStore {
        let dir = std::env::temp_dir().join(format!(
            "quiet-flow-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let s = SqliteStore::open(SqliteOptions {
            path: dir.join("quiet.db"),
            ring: 100,
            ring_memory: crate::store::DEFAULT_RING_MEMORY,
        })
        .unwrap();
        for (k, l) in fixture() {
            s.append(k, &[l]).await.unwrap();
        }
        s.flush().await.unwrap();
        s
    }

    fn ids(st: &Stitched) -> Vec<u64> {
        st.lines.iter().map(|l| l.id).collect()
    }

    #[test]
    fn otlp_spans_form_a_span_tree() {
        let span = |id: u64, sid: &str, parent: Option<&str>, name: &str, start: i64, dur: i64| {
            let p = parent
                .map(|p| format!(r#","parent_span_id":"{p}""#))
                .unwrap_or_default();
            line(
                id,
                "api",
                &format!(
                    r#"{{"otel.type":"span","name":"{name}","msg":"{name}","trace_id":"t1","span_id":"{sid}"{p},"duration_ms":{dur}}}"#
                ),
                start + dur,
            )
        };
        let lines = vec![
            span(1, "a", None, "GET /orders", T0, 100),
            span(2, "b", Some("a"), "SELECT orders", T0 + 10, 20),
            span(3, "c", Some("b"), "pg.connect", T0 + 12, 5),
            // A log record inside span b.
            line(
                4,
                "api",
                r#"{"msg":"slow query","trace_id":"t1","span_id":"b"}"#,
                T0 + 25,
            ),
        ];
        let f = build(
            Stitched {
                lines,
                ids: vec![CorrId {
                    key: IdKey::TraceId,
                    value: "t1".into(),
                }],
                truncated: false,
            },
            Some("t1"),
            None,
        );
        assert!(f.span_tree);
        let by_name = |n: &str| f.nodes.iter().find(|x| x.name == n).unwrap();
        assert_eq!(by_name("GET /orders").depth, 0);
        assert_eq!(by_name("SELECT orders").depth, 1);
        assert_eq!(by_name("pg.connect").depth, 2);
        assert_eq!(by_name("slow query").depth, 2);
        assert_eq!(
            by_name("slow query").parent,
            Some(by_name("SELECT orders").index)
        );
        assert_eq!(
            f.edges.iter().filter(|e| e.kind == EdgeKind::Child).count(),
            3
        );
        // One edge into each child: the child edges replaced the time-order ones.
        for n in &f.nodes[1..] {
            assert_eq!(f.edges.iter().filter(|e| e.to == n.index).count(), 1);
        }

        // Plain request/job flows are not span trees.
        let f = build(
            Stitched {
                lines: fixture().into_iter().map(|(_, l)| l).collect(),
                ..Default::default()
            },
            None,
            None,
        );
        assert!(!f.span_tree);
        assert!(f.nodes.iter().all(|n| n.parent.is_none() && n.depth == 0));
    }

    #[test]
    fn semconv_http_keys_name_and_status() {
        let l = line(
            1,
            "api",
            r#"{"http.request.method":"GET","http.route":"/orders","http.response.status_code":503}"#,
            T0,
        );
        assert_eq!(step_name(&l), "GET /orders");
        assert_eq!(status_of(&l), Some(503));
        assert!(node_flags(&l).0);
    }

    #[tokio::test]
    async fn request_pulls_in_its_job_and_the_jobs_retries() {
        for store in [
            Box::new(memory().await) as Box<dyn Store>,
            Box::new(sqlite().await),
        ] {
            let st = stitch(
                &*store,
                Seed::Id("req_1"),
                WIDE.0,
                WIDE.1,
                Limits::default(),
            )
            .await
            .unwrap();
            assert_eq!(ids(&st), vec![1, 2, 3, 4], "{}", store.kind());
            assert!(!st.truncated);
            let keys: Vec<_> = st
                .ids
                .iter()
                .map(|i| (i.key.clone(), i.value.as_str()))
                .collect();
            assert_eq!(
                keys,
                vec![(IdKey::RequestId, "req_1"), (IdKey::JobId, "payout:1")]
            );
        }
    }

    #[tokio::test]
    async fn a_retry_line_without_request_id_finds_the_request() {
        let s = sqlite().await;
        // Line 4 carries only the job id; one hop reaches the request.
        let seed = s.line(4).await.unwrap().unwrap();
        let st = stitch(&s, Seed::Line(seed), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![1, 2, 3, 4]);
        let f = build(st, None, None);
        assert_eq!(f.summary.stitched_by, vec![IdKey::JobId, IdKey::RequestId]);
        assert_eq!(f.summary.title, "POST /api/v1/payouts");
    }

    #[tokio::test]
    async fn single_id_is_a_one_node_flow_and_unknown_is_empty() {
        let s = memory().await;
        let st = stitch(&s, Seed::Id("req_2"), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        let f = build(st, Some("req_2"), None);
        assert_eq!(f.nodes.len(), 1);
        assert!(f.edges.is_empty());
        assert_eq!(f.summary.status, FlowStatus::Ok);
        assert_eq!(
            f.opened,
            Some(CorrId {
                key: IdKey::RequestId,
                value: "req_2".into()
            })
        );
        let st = stitch(&s, Seed::Id("nope"), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        assert!(st.lines.is_empty() && st.ids.is_empty());

        // A line with no ids at all is still a (one-node) flow when opened by line.
        let plain = line(9, "api", "server listening", T0);
        let st = stitch(&s, Seed::Line(plain), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![9]);
    }

    #[tokio::test]
    async fn limits_cut_the_walk_and_say_so() {
        let s = sqlite().await;
        // No hops: only lines carrying req_1 itself.
        let st = stitch(
            &s,
            Seed::Id("req_1"),
            WIDE.0,
            WIDE.1,
            Limits {
                by_key: false,
                hops: 0,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(ids(&st), vec![1, 2]);
        assert!(st.truncated, "payout:1 was found but not followed");

        let st = stitch(
            &s,
            Seed::Id("req_1"),
            WIDE.0,
            WIDE.1,
            Limits {
                lines: 3,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(st.lines.len(), 3);
        assert!(st.truncated);

        // The window bounds the walk too.
        let st = stitch(&s, Seed::Id("req_1"), T0, T0 + 500, Limits::default())
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![1, 2]);
    }

    #[tokio::test]
    async fn nodes_edges_children_and_status() {
        let s = memory().await;
        let st = stitch(&s, Seed::Id("payout:1"), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        let f = build(st, Some("payout:1"), None);
        let names: Vec<_> = f.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["POST /api/v1/payouts", "picked_up", "settle", "settle"]
        );
        // Ordered by start: the request started at T0 (ts − duration).
        assert_eq!(f.nodes[0].start, T0);
        assert_eq!(f.nodes[0].offset_ms, 0);
        assert_eq!(f.nodes[0].children.len(), 2);
        assert_eq!(f.nodes[0].children[1].name, "bullmq.add");
        assert_eq!(f.summary.steps, 6);
        assert_eq!(f.summary.line_count, 4);
        assert_eq!(f.summary.sources, vec!["api", "worker"]);

        let kinds: Vec<_> = f.edges.iter().map(|e| (e.from, e.to, e.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                (0, 1, EdgeKind::Handoff),
                (1, 2, EdgeKind::Next),
                (2, 3, EdgeKind::Retry)
            ]
        );
        assert_eq!(f.edges[0].via.as_ref().unwrap().value, "req_1");
        // Backoff: attempt 0 ended at +1100, attempt 1 started at +3200.
        assert_eq!(f.edges[2].gap_ms, 2_100);

        assert!(f.nodes[2].warn && !f.nodes[2].error);
        assert!(f.nodes[3].error);
        assert_eq!(f.nodes[3].summary, "failed · TIMEOUT · attempt 1");
        assert_eq!(
            f.nodes[1].summary, "payouts",
            "queue only when nothing else"
        );
        assert_eq!(f.summary.status, FlowStatus::Error);
        assert_eq!(f.summary.retries, 1);
        assert_eq!((f.summary.errors, f.summary.warnings), (1, 1));
        assert_eq!(f.summary.key, "1");
        assert!(f.missing_parent.is_none());
        assert_eq!(f.lines.len(), 4);
    }

    #[tokio::test]
    async fn job_without_its_request_names_the_missing_parent() {
        let s = MemoryStore::new(100);
        for (k, l) in fixture().into_iter().filter(|(_, l)| l.id != 1) {
            s.append(k, &[l]).await.unwrap();
        }
        let st = stitch(&s, Seed::Id("payout:1"), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        let f = build(st, Some("payout:1"), Some(T0 + 150));
        assert_eq!(f.missing_parent.unwrap().value, "req_1");
        assert_eq!(f.summary.title, "settle");
        assert!(
            f.partial,
            "starts within a minute of the oldest stored line"
        );
    }

    #[tokio::test]
    async fn close_matches_share_a_prefix() {
        let s = sqlite().await;
        assert!(
            s.similar_ids("req_9", WIDE.0, WIDE.1, 5)
                .await
                .unwrap()
                .is_empty(),
            "too short"
        );
        assert!(s
            .similar_ids("zzzzzz9", WIDE.0, WIDE.1, 5)
            .await
            .unwrap()
            .is_empty());
        let got = s.similar_ids("req_1x", WIDE.0, WIDE.1, 5).await.unwrap();
        let vals: Vec<_> = got.iter().map(|(c, _)| c.value.as_str()).collect();
        assert_eq!(vals, vec!["req_1", "req_2"]);
        let m = memory().await;
        let got = m.similar_ids("payout:12", WIDE.0, WIDE.1, 5).await.unwrap();
        assert_eq!(got[0].0.value, "payout:1");
        let got = s.similar_ids("payout:12", WIDE.0, WIDE.1, 5).await.unwrap();
        assert_eq!(got[0].0.value, "payout:1");
        assert_eq!(got[0].1, 4, "newest line carrying it");
    }

    #[tokio::test]
    async fn matching_by_key_keeps_unrelated_numeric_ids_apart() {
        let s = MemoryStore::new(100);
        s.append(
            SourceKind::Http,
            &[
                line(1, "api", r#"{"msg":"GET /a","request_id":"42"}"#, T0),
                line(2, "worker", r#"{"msg":"job","job_id":"42"}"#, T0 + 10),
                line(
                    3,
                    "worker",
                    r#"{"msg":"retry","job_id":"42","attempt":1}"#,
                    T0 + 20,
                ),
            ],
        )
        .await
        .unwrap();
        // By value (default): the same "42" merges a request and a job.
        let st = stitch(&s, Seed::Id("42"), WIDE.0, WIDE.1, Limits::default())
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![1, 2, 3]);
        // By key: opening the request's line keeps to request_id 42.
        let by_key = Limits {
            by_key: true,
            ..Default::default()
        };
        let seed = s.line(1).await.unwrap().unwrap();
        let st = stitch(&s, Seed::Line(seed), WIDE.0, WIDE.1, by_key)
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![1]);
        let seed = s.line(2).await.unwrap().unwrap();
        let st = stitch(&s, Seed::Line(seed), WIDE.0, WIDE.1, by_key)
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![2, 3]);
        // An id typed in (no key) still matches any key at the start.
        let st = stitch(&s, Seed::Id("42"), WIDE.0, WIDE.1, by_key)
            .await
            .unwrap();
        assert_eq!(ids(&st), vec![1, 2, 3]);
    }
}
