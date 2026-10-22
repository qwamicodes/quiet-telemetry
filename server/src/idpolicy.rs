//! Which correlation-id keys count, and in what order, for each source.
//!
//! [`normalize`](crate::normalize::normalize) reads this for every line: keys
//! left out are not correlation ids for that source (not shown on the row, not
//! indexed for new lines, not followed when a flow is stitched), and the first
//! key in the order is the one a row displays.
//!
//! It is process-wide on purpose: stored lines are re-derived with `normalize`
//! on every read (only the raw line is on disk), so the live stream, search,
//! flows and export all have to see the same policy without threading a
//! handle through every read path. The server's [`Settings`](crate::settings::Settings)
//! installs it at startup and on every change; tests and `Settings::memory()`
//! never touch it, so the default (every key, request_id first) holds there.

use crate::normalize::IdKey;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

/// Every key quiet knows, in the default display priority.
pub const ALL: [IdKey; 4] = [
    IdKey::RequestId,
    IdKey::JobId,
    IdKey::TraceId,
    IdKey::CorrelationId,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdPolicy {
    /// Instance-wide order (Settings → Flow id order). Keys left out don't count.
    pub global: Vec<IdKey>,
    /// Per-source overrides (Sources → a source → Settings).
    pub sources: HashMap<String, Vec<IdKey>>,
}

impl Default for IdPolicy {
    fn default() -> Self {
        IdPolicy {
            global: ALL.to_vec(),
            sources: HashMap::new(),
        }
    }
}

impl IdPolicy {
    pub fn order_for(&self, source: &str) -> &[IdKey] {
        self.sources.get(source).unwrap_or(&self.global)
    }
}

static POLICY: LazyLock<RwLock<Arc<IdPolicy>>> =
    LazyLock::new(|| RwLock::new(Arc::new(IdPolicy::default())));

/// Make `p` the policy every line is normalized with from now on.
pub fn install(p: IdPolicy) {
    *POLICY.write().unwrap() = Arc::new(p);
}

/// The key order for `source` (owned: it is four enum values at most).
pub fn order_for(source: &str) -> Vec<IdKey> {
    POLICY.read().unwrap().order_for(source).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    /// The only test that installs a policy: it scopes it to a source no other
    /// test logs to, and restores the default afterwards.
    #[test]
    fn per_source_order_and_disabled_keys_reach_normalize() {
        let src = "idpolicy-test-src";
        let raw = r#"{"msg":"x","request_id":"r1","job_id":"j1","trace_id":"t1"}"#;
        let before = normalize(raw, src, None, 0);
        assert_eq!(before.display_id.unwrap().key, IdKey::RequestId);
        assert_eq!(before.ids.len(), 3);

        let mut p = IdPolicy::default();
        p.sources
            .insert(src.into(), vec![IdKey::JobId, IdKey::RequestId]);
        install(p);
        let after = normalize(raw, src, None, 0);
        let other = normalize(raw, "idpolicy-other-src", None, 0);
        install(IdPolicy::default());

        // job_id displays first; trace_id no longer counts for this source.
        assert_eq!(after.display_id.unwrap().key, IdKey::JobId);
        let keys: Vec<_> = after.ids.iter().map(|i| i.key).collect();
        assert!(keys.contains(&IdKey::RequestId) && !keys.contains(&IdKey::TraceId));
        // Other sources keep the default.
        assert_eq!(other.display_id.unwrap().key, IdKey::RequestId);
        assert_eq!(other.ids.len(), 3);
    }
}
