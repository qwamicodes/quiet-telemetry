//! A bounded ring of recent lines per source. Fast, lossy, gone on restart.

use super::{Query, Store};
use crate::hub::Line;
use async_trait::async_trait;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, RwLock};

pub struct MemoryStore {
    cap: usize,
    rings: RwLock<HashMap<String, Mutex<VecDeque<Line>>>>,
}

impl MemoryStore {
    /// `cap` lines are kept per source; the oldest falls off first.
    pub fn new(cap: usize) -> Self {
        MemoryStore {
            cap: cap.max(1),
            rings: RwLock::new(HashMap::new()),
        }
    }

    fn push(&self, line: &Line) {
        // Fast path: the source's ring already exists.
        if let Some(ring) = self.rings.read().unwrap().get(&line.source) {
            Self::push_into(&mut ring.lock().unwrap(), line, self.cap);
            return;
        }
        let mut rings = self.rings.write().unwrap();
        let ring = rings
            .entry(line.source.clone())
            .or_insert_with(|| Mutex::new(VecDeque::with_capacity(self.cap.min(1024))));
        Self::push_into(ring.get_mut().unwrap(), line, self.cap);
    }

    fn push_into(ring: &mut VecDeque<Line>, line: &Line, cap: usize) {
        if ring.len() >= cap {
            ring.pop_front();
        }
        ring.push_back(line.clone());
    }
}

#[async_trait]
impl Store for MemoryStore {
    fn kind(&self) -> &'static str {
        "memory"
    }

    async fn append(&self, lines: &[Line]) -> anyhow::Result<()> {
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

    async fn expire(&self, cutoff: i64) -> anyhow::Result<u64> {
        let rings = self.rings.read().unwrap();
        let mut dropped = 0u64;
        for ring in rings.values() {
            let mut ring = ring.lock().unwrap();
            let before = ring.len();
            ring.retain(|l| l.ts >= cutoff);
            dropped += (before - ring.len()) as u64;
        }
        Ok(dropped)
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
        s.append(&lines).await.unwrap();
        let tail = s.tail("api", 10).await.unwrap();
        assert_eq!(tail.iter().map(|l| l.id).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert_eq!(s.tail("api", 1).await.unwrap()[0].msg, "line 5");
        assert!(s.tail("nope", 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn query_filters_time_and_text_then_limits_newest() {
        let s = MemoryStore::new(100);
        s.append(&[
            line(1, r#"{"level":"warn","msg":"slow a"}"#, 10),
            line(2, r#"{"level":"info","msg":"ok"}"#, 20),
            line(3, r#"{"level":"error","msg":"slow b"}"#, 30),
            line(4, r#"{"level":"warn","msg":"slow c"}"#, 40),
        ])
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
}
