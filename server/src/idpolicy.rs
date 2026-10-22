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

/// Tests that install a policy hold this so they never see each other's.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The key order for `source` (owned: four built-ins plus at most 8 custom keys).
pub fn order_for(source: &str) -> Vec<IdKey> {
    POLICY.read().unwrap().order_for(source).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn custom(s: &str) -> IdKey {
        IdKey::Custom(s.into())
    }

    /// Tests that install a policy scope it to a source no other test logs
    /// to, hold [`TEST_LOCK`], and restore the default afterwards.
    #[test]
    fn per_source_order_and_disabled_keys_reach_normalize() {
        let _g = lock();
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
        let keys: Vec<_> = after.ids.iter().map(|i| i.key.clone()).collect();
        assert!(keys.contains(&IdKey::RequestId) && !keys.contains(&IdKey::TraceId));
        // Other sources keep the default.
        assert_eq!(other.display_id.unwrap().key, IdKey::RequestId);
        assert_eq!(other.ids.len(), 3);
    }

    #[test]
    fn custom_key_matches_exact_top_level_key_then_dotted_path() {
        let _g = lock();
        let src = "idpolicy-custom-src";
        let mut p = IdPolicy::default();
        p.sources.insert(
            src.into(),
            vec![
                IdKey::RequestId,
                custom("x-amzn-trace"),
                custom("ctx.trace"),
                IdKey::JobId,
            ],
        );
        install(p);
        // Exact key, even when it contains a dot.
        let flat = normalize(
            r#"{"msg":"a","ctx.trace":"flat-1","ctx":{"trace":"nested-1"}}"#,
            src,
            None,
            0,
        );
        // Dotted path into nested objects.
        let nested = normalize(r#"{"msg":"b","ctx":{"trace":"nested-2"}}"#, src, None, 0);
        // Hyphenated top-level key; numbers count, empty strings and objects don't.
        let amzn = normalize(
            r#"{"msg":"c","x-amzn-trace":42,"ctx":{"trace":""}}"#,
            src,
            None,
            0,
        );
        let none = normalize(r#"{"msg":"d","ctx":{"trace":{"id":1}}}"#, src, None, 0);
        // Custom keys only count where the order lists them.
        let other = normalize(
            r#"{"msg":"e","ctx":{"trace":"x"}}"#,
            "idpolicy-plain",
            None,
            0,
        );
        install(IdPolicy::default());

        let id = |l: &crate::normalize::LogLine, k: &str| {
            l.ids
                .iter()
                .find(|i| i.key.as_str() == k)
                .map(|i| i.value.clone())
        };
        assert_eq!(id(&flat, "ctx.trace").as_deref(), Some("flat-1"));
        assert_eq!(id(&nested, "ctx.trace").as_deref(), Some("nested-2"));
        assert_eq!(id(&amzn, "x-amzn-trace").as_deref(), Some("42"));
        assert!(id(&amzn, "ctx.trace").is_none());
        assert!(none.ids.is_empty());
        assert!(other.ids.is_empty());
    }

    #[test]
    fn custom_key_takes_its_position_in_the_order() {
        let _g = lock();
        let src = "idpolicy-position-src";
        let raw = r#"{"msg":"x","request_id":"r1","job_id":"j1","x-request-id":"edge-9"}"#;
        let mut p = IdPolicy::default();
        p.sources.insert(
            src.into(),
            vec![custom("x-request-id"), IdKey::RequestId, IdKey::JobId],
        );
        install(p.clone());
        let first = normalize(raw, src, None, 0);
        p.sources.insert(
            src.into(),
            vec![IdKey::JobId, custom("x-request-id"), IdKey::RequestId],
        );
        install(p);
        let second = normalize(raw, src, None, 0);
        install(IdPolicy::default());

        let shown = first.display_id.unwrap();
        assert_eq!(
            (shown.key, shown.value.as_str()),
            (custom("x-request-id"), "edge-9")
        );
        // request_id r1 + edge-9 (x-request-id is a built-in spelling), job_id, custom.
        assert_eq!(first.ids.len(), 4);
        assert_eq!(second.display_id.unwrap().key, IdKey::JobId);
        // The built-in request_id spelling list includes `x-request-id`, so
        // the same value is also indexed under request_id: both stitch.
        assert!(first
            .ids
            .iter()
            .any(|i| i.key == IdKey::RequestId && i.value == "edge-9"));
    }

    #[test]
    fn id_keys_serialize_as_their_names() {
        let keys = vec![
            IdKey::RequestId,
            custom("x-request-id"),
            IdKey::CorrelationId,
        ];
        let json = serde_json::to_string(&keys).unwrap();
        assert_eq!(json, r#"["request_id","x-request-id","correlation_id"]"#);
        let back: Vec<IdKey> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, keys);
        // A built-in name always means the built-in.
        let k: IdKey = serde_json::from_str(r#""job_id""#).unwrap();
        assert_eq!(k, IdKey::JobId);
        assert!(!k.is_custom());
    }

    #[test]
    fn custom_keys_are_validated() {
        use crate::settings::{valid_custom_key, FlowIdSettings, Settings};
        for ok in ["x-request-id", "ctx.trace", "meta.span_id", "a:b@c"] {
            assert!(valid_custom_key(ok), "{ok}");
        }
        for bad in [
            "",
            "has space",
            "ctx..trace",
            ".lead",
            "trail.",
            "émoji",
            &"x".repeat(65),
        ] {
            assert!(!valid_custom_key(bad), "{bad:?}");
        }

        let s = Settings::memory();
        let mut f = FlowIdSettings::default();
        f.order.push(custom("x-request-id"));
        f.order.push(custom("ctx.trace"));
        s.put_flow_ids(f.clone(), None).unwrap();
        assert_eq!(s.flow_ids().order.len(), 6);
        assert_eq!(s.flow_ids().order[4], custom("x-request-id"));

        let mut dup = f.clone();
        dup.order.push(custom("ctx.trace"));
        assert!(s.put_flow_ids(dup, None).is_err());
        let mut bad = f.clone();
        bad.order.push(custom("not ok"));
        assert!(s.put_flow_ids(bad, None).is_err());
        let mut many = FlowIdSettings::default();
        many.order.extend((0..8).map(|i| custom(&format!("f{i}"))));
        assert!(s.put_flow_ids(many.clone(), None).is_ok());
        many.order.push(custom("f8"));
        assert!(s.put_flow_ids(many, None).is_err());
    }
}
