//! A bounded ring of recent lines per source. Fast, lossy, gone on restart.
//!
//! Two bounds: `cap` lines per source, and a memory budget shared by every
//! source (`--ring-memory`, default 64MB). The budget is split evenly between
//! the sources that have a ring, and each ring drops its oldest lines while it
//! is over its share. Sizes are estimates ([`line_cost`]): the raw line, its
//! parsed fields (roughly three times the raw text), the summary and ids.

use super::{rank_similar, similar_prefix, HistSpec, LevelCounts, Query, Store};
use crate::hub::{Line, SourceKind};
use crate::normalize::CorrId;
use crate::search::{
    add_to_histogram, bucket_width, empty_histogram, Cursor, Order, SearchPage, SearchQuery,
};
use async_trait::async_trait;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, RwLock};

/// The default memory budget for every ring together (bytes, estimated);
/// the server takes it from `--ring-memory` (default 64MB, same value).
#[cfg(test)]
pub const DEFAULT_RING_MEMORY: usize = 64_000_000;

#[derive(Default)]
struct Ring {
    lines: VecDeque<Line>,
    /// Estimated bytes held ([`line_cost`] summed).
    bytes: usize,
}

impl Ring {
    fn retain(&mut self, keep: impl Fn(&Line) -> bool) -> usize {
        let before = self.lines.len();
        self.lines.retain(|l| keep(l));
        self.bytes = self.lines.iter().map(|l| line_cost(l)).sum();
        before - self.lines.len()
    }
}

/// Estimated heap bytes of one line in memory: the raw text, the parsed
/// fields (serde_json maps cost about three times the text they came from),
/// the summary, ids and the struct itself.
pub fn line_cost(l: &crate::normalize::LogLine) -> usize {
    let fields = if l.fields.is_some() {
        l.raw.len() * 3
    } else {
        0
    };
    let ids: usize = l.ids.iter().map(|i| i.value.len() + 32).sum();
    l.raw.len() + fields + l.msg.len() + l.source.len() + ids + 200
}

pub struct MemoryStore {
    cap: usize,
    /// Memory budget shared by every ring (estimated bytes).
    budget: usize,
    rings: RwLock<HashMap<String, Mutex<Ring>>>,
}

impl MemoryStore {
    /// `cap` lines are kept per source; the oldest falls off first.
    #[cfg(test)]
    pub fn new(cap: usize) -> Self {
        Self::with_budget(cap, DEFAULT_RING_MEMORY)
    }

    /// `cap` lines per source and `budget` bytes (estimated) for all of them.
    pub fn with_budget(cap: usize, budget: usize) -> Self {
        MemoryStore {
            cap: cap.max(1),
            budget: budget.max(1),
            rings: RwLock::new(HashMap::new()),
        }
    }

    /// Estimated bytes held by every ring, and how many rings there are.
    #[cfg(test)]
    pub fn memory(&self) -> (usize, usize) {
        let rings = self.rings.read().unwrap();
        (
            rings.values().map(|r| r.lock().unwrap().bytes).sum(),
            rings.len(),
        )
    }

    /// Forget every line of `source` (purge).
    pub fn remove_source(&self, source: &str) -> u64 {
        self.rings
            .write()
            .unwrap()
            .remove(source)
            .map_or(0, |r| r.into_inner().unwrap().lines.len() as u64)
    }

    /// Forget everything (purge).
    pub fn clear(&self) -> u64 {
        let mut rings = self.rings.write().unwrap();
        let n = rings
            .values()
            .map(|r| r.lock().unwrap().lines.len() as u64)
            .sum();
        rings.clear();
        n
    }

    /// Drop lines of `source` older than `cutoff`.
    pub fn expire_source_sync(&self, source: &str, cutoff: i64) -> u64 {
        self.rings
            .read()
            .unwrap()
            .get(source)
            .map_or(0, |r| r.lock().unwrap().retain(|l| l.ts >= cutoff) as u64)
    }

    /// Lines and raw bytes per source (the memory store's "volume by source").
    pub fn per_source(&self) -> Vec<super::SourceUsage> {
        let rings = self.rings.read().unwrap();
        let mut v: Vec<_> = rings
            .iter()
            .map(|(name, r)| {
                let r = r.lock().unwrap();
                super::SourceUsage {
                    source: name.clone(),
                    lines: r.lines.len() as u64,
                    bytes: r.lines.iter().map(|l| l.raw.len() as u64).sum(),
                }
            })
            .collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.bytes));
        v
    }

    /// Append without the async trait (the SQLite store warms its ring with this).
    pub fn push_many(&self, lines: &[Line]) {
        for line in lines {
            self.push(line);
        }
    }

    fn push(&self, line: &Line) {
        // Fast path: the source's ring already exists.
        {
            let rings = self.rings.read().unwrap();
            if let Some(ring) = rings.get(&line.source) {
                let share = self.budget / rings.len().max(1);
                Self::push_into(&mut ring.lock().unwrap(), line, self.cap, share);
                return;
            }
        }
        let mut rings = self.rings.write().unwrap();
        let n = rings.len() + usize::from(!rings.contains_key(&line.source));
        let share = self.budget / n.max(1);
        let ring = rings.entry(line.source.clone()).or_insert_with(|| {
            Mutex::new(Ring {
                lines: VecDeque::with_capacity(self.cap.min(1024)),
                bytes: 0,
            })
        });
        Self::push_into(ring.get_mut().unwrap(), line, self.cap, share);
    }

    /// Append, then drop the oldest while over `cap` lines or `share` bytes
    /// (the newest line always stays).
    fn push_into(ring: &mut Ring, line: &Line, cap: usize, share: usize) {
        ring.bytes += line_cost(line);
        ring.lines.push_back(line.clone());
        while ring.lines.len() > 1 && (ring.lines.len() > cap || ring.bytes > share) {
            if let Some(old) = ring.lines.pop_front() {
                ring.bytes = ring.bytes.saturating_sub(line_cost(&old));
            }
        }
    }
}

#[async_trait]
impl Store for MemoryStore {
    fn kind(&self) -> &'static str {
        "memory"
    }

    async fn append(&self, _kind: SourceKind, lines: &[Line]) -> anyhow::Result<()> {
        for line in lines {
            self.push(line);
        }
        Ok(())
    }

    async fn query(&self, q: &Query) -> anyhow::Result<Vec<Line>> {
        let rings = self.rings.read().unwrap();
        let Some(ring) = rings.get(&q.source) else {
            return Ok(Vec::new());
        };
        let ring = ring.lock().unwrap();
        // Walk newest → oldest so a small limit stops early, then flip.
        let mut out: Vec<Line> = ring
            .lines
            .iter()
            .rev()
            .filter(|l| q.since.is_none_or(|s| l.ts >= s))
            .filter(|l| q.until.is_none_or(|u| l.ts <= u))
            .filter(|l| q.filter.matches(l))
            .take(q.limit)
            .cloned()
            .collect();
        out.reverse();
        Ok(out)
    }

    async fn search(&self, q: &SearchQuery) -> anyhow::Result<SearchPage> {
        let rings = self.rings.read().unwrap();
        let mut all: Vec<Line> = rings
            .values()
            .flat_map(|r| r.lock().unwrap().lines.iter().cloned().collect::<Vec<_>>())
            .filter(|l| q.in_time(l) && q.matches(l))
            .collect();
        all.sort_by_key(|l| (l.ts, l.id));
        if q.order == Order::Newest {
            all.reverse();
        }
        let searched = rings
            .values()
            .map(|r| r.lock().unwrap().lines.len() as u64)
            .sum();
        let mut page = SearchPage {
            searched,
            ..Default::default()
        };
        if q.cursor.is_none() {
            if let (Some(n), Some(since), Some(until)) = (q.histogram, q.since, q.until) {
                let w = bucket_width(since, until, n);
                let mut h = empty_histogram(since, w, n);
                for l in &all {
                    add_to_histogram(&mut h, since, w, l.ts, l.level);
                }
                page.total = Some(all.len() as u64);
                page.bytes = Some(all.iter().map(|l| l.raw.len() as u64).sum());
                page.histogram = Some(h);
            }
        }
        let limit = q.limit.max(1);
        let mut lines: Vec<Line> = all
            .into_iter()
            .filter(|l| q.cursor.is_none_or(|c| c.before(l, q.order)))
            .take(limit + 1)
            .collect();
        if lines.len() > limit {
            lines.truncate(limit);
            page.next_cursor = lines.last().map(Cursor::of);
        }
        page.lines = lines;
        Ok(page)
    }

    async fn level_counts(
        &self,
        q: &SearchQuery,
        hist: Option<HistSpec>,
    ) -> anyhow::Result<LevelCounts> {
        let rings = self.rings.read().unwrap();
        let mut out = LevelCounts::default();
        if let Some((since, w, n)) = hist {
            out.histogram = empty_histogram(since, w, n);
        }
        for r in rings.values() {
            for l in r.lock().unwrap().lines.iter() {
                if !(q.in_time(l) && q.matches(l)) {
                    continue;
                }
                out.add(l.level);
                if let Some((since, w, n)) = hist {
                    if l.ts >= since && l.ts < since + w * n as i64 {
                        add_to_histogram(&mut out.histogram, since, w, l.ts, l.level);
                    }
                }
            }
        }
        Ok(out)
    }

    async fn line(&self, id: u64) -> anyhow::Result<Option<Line>> {
        let rings = self.rings.read().unwrap();
        Ok(rings.values().find_map(|r| {
            let r = r.lock().unwrap();
            // Ids increase within a ring: binary search instead of a scan.
            r.lines
                .binary_search_by_key(&id, |l| l.id)
                .ok()
                .map(|i| r.lines[i].clone())
        }))
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
        let rings = self.rings.read().unwrap();
        let mut found = Vec::new();
        for r in rings.values() {
            for l in r.lock().unwrap().lines.iter() {
                if l.ts < since || l.ts > until {
                    continue;
                }
                for i in &l.ids {
                    if i.value.starts_with(&prefix) {
                        found.push((i.clone(), l.id));
                    }
                }
            }
        }
        Ok(rank_similar(value, found, limit))
    }

    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64> {
        let rings = self.rings.read().unwrap();
        let mut dropped = 0u64;
        for ring in rings.values() {
            dropped += ring.lock().unwrap().retain(|l| l.ts >= cutoff) as u64;
        }
        Ok(dropped)
    }

    async fn expire_source(&self, source: &str, cutoff: i64) -> anyhow::Result<u64> {
        Ok(self.expire_source_sync(source, cutoff))
    }

    async fn purge(&self, source: Option<&str>) -> anyhow::Result<u64> {
        Ok(match source {
            Some(s) => self.remove_source(s),
            None => self.clear(),
        })
    }

    async fn storage(&self) -> anyhow::Result<super::StorageUsage> {
        Ok(super::StorageUsage {
            hours: Vec::new(),
            sources: self.per_source(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use crate::store::LineFilter;
    use std::sync::Arc;

    fn line(id: u64, raw: &str, ts: i64) -> Line {
        let mut l = normalize(raw, "api", None, ts);
        l.id = id;
        Arc::new(l)
    }

    #[tokio::test]
    async fn ring_is_bounded_and_tail_is_oldest_first() {
        let s = MemoryStore::new(3);
        let lines: Vec<_> = (1..=5)
            .map(|i| line(i, &format!("line {i}"), i as i64))
            .collect();
        s.append(SourceKind::Http, &lines).await.unwrap();
        let tail = s.tail("api", 10).await.unwrap();
        assert_eq!(tail.iter().map(|l| l.id).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(s.tail("api", 1).await.unwrap()[0].msg, "line 5");
        assert!(s.tail("nope", 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn query_filters_time_and_text_then_limits_newest() {
        let s = MemoryStore::new(100);
        s.append(
            SourceKind::Http,
            &[
                line(1, r#"{"level":"warn","msg":"slow a"}"#, 10),
                line(2, r#"{"level":"info","msg":"ok"}"#, 20),
                line(3, r#"{"level":"error","msg":"slow b"}"#, 30),
                line(4, r#"{"level":"warn","msg":"slow c"}"#, 40),
            ],
        )
        .await
        .unwrap();
        let got = s
            .query(&Query {
                source: "api".into(),
                filter: LineFilter::new(Some("warn"), Some("SLOW")),
                since: Some(15),
                until: None,
                limit: 10,
            })
            .await
            .unwrap();
        assert_eq!(got.iter().map(|l| l.id).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(s.expire(35).await.unwrap(), 3);
        assert_eq!(s.tail("api", 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn memory_budget_is_shared_between_sources() {
        let one = line(1, &"x".repeat(1000), 1);
        let cost = line_cost(&one);
        // Room for ~10 lines in total.
        let s = MemoryStore::with_budget(1000, cost * 10);
        let lines: Vec<_> = (1..=20)
            .map(|i| line(i, &"x".repeat(1000), i as i64))
            .collect();
        s.append(SourceKind::Http, &lines).await.unwrap();
        assert_eq!(s.tail("api", 100).await.unwrap().len(), 10);
        // A second source halves each share; the first shrinks on its next push.
        let mut other = (*line(21, &"y".repeat(1000), 21)).clone();
        other.source = "web".into();
        s.append(SourceKind::Http, &[Arc::new(other)])
            .await
            .unwrap();
        s.append(SourceKind::Http, &[line(22, &"x".repeat(1000), 22)])
            .await
            .unwrap();
        assert_eq!(s.tail("api", 100).await.unwrap().len(), 5);
        let (bytes, rings) = s.memory();
        assert_eq!(rings, 2);
        assert!(bytes <= cost * 10, "{bytes} > {}", cost * 10);
        // Purge one source, then everything.
        assert_eq!(s.purge(Some("web")).await.unwrap(), 1);
        assert_eq!(s.purge(None).await.unwrap(), 5);
        assert!(s.tail("api", 10).await.unwrap().is_empty());
    }
}
