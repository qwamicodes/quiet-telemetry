use super::*;
use crate::hub::SourceKind;
use crate::normalize::normalize;
use crate::search::SearchQuery;
use crate::store::{SqliteOptions, SqliteStore};
use object_store::memory::InMemory;
use object_store::ObjectStore;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const H: i64 = HOUR;

fn tmp() -> PathBuf {
    std::env::temp_dir().join(format!("quiet-hist-{:08x}", rand::random::<u32>()))
}

fn store(dir: &Path) -> SqliteStore {
    SqliteStore::open(SqliteOptions {
        path: dir.join("quiet.db"),
        ring: 100,
        ring_memory: crate::store::DEFAULT_RING_MEMORY,
    })
    .unwrap()
}

/// `n` hours of lines ending one hour before `now`'s hour: in each hour one
/// `api` request line (with a request_id) and one `worker` line.
async fn fill(s: &SqliteStore, first_hour: i64, hours: i64) {
    let mut lines = Vec::new();
    let mut id = 0;
    for h in first_hour..first_hour + hours {
        for (src, raw) in [
            (
                "api",
                format!(r#"{{"flow":"create_payout","request_id":"req_{h}","msg":"payout {h}"}}"#),
            ),
            (
                "worker",
                format!(r#"{{"flow":"settle","job_id":"job_{h}"}}"#),
            ),
        ] {
            id += 1;
            let mut l = normalize(&raw, src, None, h * H + 60_000 + id);
            l.id = id as u64;
            lines.push(Arc::new(l));
        }
    }
    s.append(SourceKind::Http, &lines).await.unwrap();
    s.flush().await.unwrap();
}

/// A connector whose destinations all share one in-memory bucket, and that
/// can be switched to fail.
struct Bucket {
    mem: Arc<InMemory>,
    down: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
}

fn bucket() -> (Bucket, Connector) {
    let mem = Arc::new(InMemory::new());
    let down = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let (m, d, c) = (mem.clone(), down.clone(), calls.clone());
    let conn: Connector = Arc::new(move |_, secret| {
        assert_eq!(
            secret, "s3cr3t",
            "the secret is decrypted for the client only"
        );
        c.fetch_add(1, Ordering::SeqCst);
        if d.load(Ordering::SeqCst) {
            anyhow::bail!("connection refused");
        }
        Ok(m.clone() as Remote)
    });
    (Bucket { mem, down, calls }, conn)
}

fn new_dest(name: &str, activate: bool) -> NewDestination {
    NewDestination {
        name: name.into(),
        kind: DestinationKind::Garage,
        endpoint: Some("http://garage:3900".into()),
        region: None,
        bucket: "quiet-history".into(),
        prefix: None,
        path_style: None,
        access_key_id: "GK0123456789abcdef".into(),
        secret_access_key: "s3cr3t".into(),
        session_token: None,
        activate: Some(activate),
    }
}

async fn get(mem: &InMemory, key: &str) -> Vec<u8> {
    mem.get(&ObjPath::from(key))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
async fn segment_round_trip_keeps_lines_fts_and_ids_minus_excluded() {
    let dir = tmp();
    let s = store(&dir);
    let hour = 482_950;
    fill(&s, hour, 1).await;
    let out = dir.join("seg.sqlite");
    let stats = s
        .build_segment(hour, &["worker".to_string()], &out)
        .await
        .unwrap();
    assert_eq!(stats.lines, 1);
    assert_eq!(stats.sources, vec!["api".to_string()]);
    let c = Connection::open(&out).unwrap();
    let (l, f, i) = (
        format!("\"l_{hour}\""),
        format!("\"f_{hour}\""),
        format!("\"i_{hour}\""),
    );
    let n: i64 = c
        .query_row(&format!("SELECT COUNT(*) FROM {l}"), [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    // The FTS index is rebuilt and answers like the store's.
    let fts: Vec<i64> = c
        .prepare(&format!("SELECT rowid FROM {f} WHERE {f} MATCH 'payout'"))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let local = s
        .search(&SearchQuery {
            text: vec!["payout".into()],
            limit: 10,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        fts.iter().map(|x| *x as u64).collect::<Vec<_>>(),
        local.lines.iter().map(|l| l.id).collect::<Vec<_>>()
    );
    // Only ids of kept lines, and the metadata table.
    let ids: Vec<String> = c
        .prepare(&format!("SELECT value FROM {i}"))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ids, vec![format!("req_{hour}")]);
    let schema: String = c
        .query_row("SELECT v FROM segment WHERE k = 'schema'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(schema, "1");
    assert!(s.build_segment(hour + 5, &[], &out).await.is_err());
}

#[tokio::test]
async fn create_verifies_activates_and_never_returns_the_secret() {
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let (d, v) = h
        .create(new_dest("garage-local", true), 1_000)
        .await
        .unwrap();
    assert!(v.ok && v.cleanup, "{v:?}");
    assert_eq!(v.steps.len(), 4);
    assert!(d.active);
    assert_eq!(d.state, DestinationState::Ok);
    assert_eq!(d.access_key_preview, "GK01••••cdef");
    let json = serde_json::to_string(&h.status().unwrap()).unwrap();
    assert!(!json.contains("s3cr3t"));
    assert!(json.contains("\"enabled\":true"));
    // Prefix defaults to quiet/<instance id>/, and instance.json is written.
    let inst = h.catalog.instance_id().unwrap();
    assert_eq!(d.prefix, format!("quiet/{inst}/"));
    let body = get(&b.mem, &format!("quiet/{inst}/v1/instance.json")).await;
    assert!(String::from_utf8(body).unwrap().contains(&inst));
    // The verify object was cleaned up.
    let left: Vec<_> = futures_util::StreamExt::collect::<Vec<_>>(b.mem.list(None)).await;
    assert_eq!(left.len(), 1, "only instance.json remains");
    // Names are unique; an unreachable destination can be saved, not made active.
    assert!(matches!(
        h.create(new_dest("GARAGE-LOCAL", false), 2_000).await,
        Err(HistoryError::Conflict("name_taken", _))
    ));
    b.down.store(true, Ordering::SeqCst);
    let (d2, v2) = h.create(new_dest("r2-prod", true), 3_000).await.unwrap();
    assert!(!v2.ok && !d2.active);
    assert!(v2.steps.iter().all(|s| !s.ok));
    assert!(matches!(
        h.activate(d2.id, false, 4_000).await,
        Err(HistoryError::Conflict("verify_failed", _))
    ));
    // The active one can't go.
    assert!(matches!(
        h.remove(d.id, false, 4_000),
        Err(HistoryError::Conflict("active", _))
    ));
    assert!(h.remove(d2.id, false, 4_000).unwrap().is_none());
    assert_eq!(h.destinations().unwrap().len(), 1);
}

#[tokio::test]
async fn archives_expiring_hours_then_drops_them() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let (d, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    let now = 482_960 * H + 30 * 60_000;
    fill(&s, 482_950, 10).await; // hours 482950 … 482959
    let sys = SystemState::default();
    // Window: 4 hours back from half past → hours ending ≤ cutoff expire.
    let cutoff = now - 4 * H;
    let pass = h.pass(&s, cutoff, &[], now, &sys).await;
    assert_eq!(pass.archived, (482_950..482_956).collect::<Vec<_>>());
    assert!(!pass.hold);
    assert_eq!(
        s.hours().await.unwrap(),
        (482_956..482_960).collect::<Vec<_>>()
    );
    let rec = h.catalog.hours_of(d.id).unwrap();
    assert_eq!(rec.len(), 6);
    assert_eq!(rec[0].lines, 2);
    assert_eq!(
        rec[0].sources,
        vec!["api".to_string(), "worker".to_string()]
    );
    // The object is a zstd SQLite file with the hour's lines; the manifest
    // carries its checksum.
    let seg = get(&b.mem, &rec[0].key).await;
    assert_eq!(seg.len() as u64, rec[0].bytes_stored);
    assert_eq!(hex(&sha2::Sha256::digest(&seg)), rec[0].sha256);
    assert!(
        rec[0].key.ends_with("v1/hours/2025/02/03/482950.seg.zst"),
        "{}",
        rec[0].key
    );
    let raw = zstd::decode_all(seg.as_slice()).unwrap();
    let f = dir.join("check.sqlite");
    std::fs::write(&f, raw).unwrap();
    let n: i64 = Connection::open(&f)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM \"l_482950\"", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    let manifest =
        String::from_utf8(get(&b.mem, &format!("{}v1/manifest/482950.json", d.prefix)).await)
            .unwrap();
    assert!(manifest.contains(&rec[0].sha256));
    let view = h.destination(d.id).unwrap();
    assert_eq!((view.hours, view.lines), (6, 12));
    assert_eq!(view.first, Some(482_950 * H));
    assert!(sys.history_issue().is_none());
    // Nothing left to archive: a second pass does nothing.
    assert_eq!(h.pass(&s, cutoff, &[], now, &sys).await, Pass::default());
}

#[tokio::test]
async fn an_unreachable_destination_holds_hours_with_backoff_then_catches_up() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    h.create(new_dest("garage-local", true), 0).await.unwrap();
    fill(&s, 482_950, 3).await;
    let sys = SystemState::default();
    let now = 482_960 * H;
    b.down.store(true, Ordering::SeqCst);
    let pass = h.pass(&s, now, &[], now, &sys).await;
    assert!(pass.hold);
    assert_eq!(pass.waiting.len(), 3);
    assert_eq!(s.hours().await.unwrap().len(), 3, "held locally");
    let issue = sys.history_issue().unwrap();
    assert_eq!(issue.kind, IssueKind::HistoryUnavailable);
    assert!(
        issue.detail.starts_with("3 hours waiting"),
        "{}",
        issue.detail
    );
    let st = h.status().unwrap();
    assert_eq!(st.waiting_hours, 3);
    assert_eq!(st.destinations[0].state, DestinationState::Unavailable);
    assert_eq!(st.destinations[0].next_retry, Some(now + 30_000));
    // Before the retry time nothing is attempted.
    let calls = b.calls.load(Ordering::SeqCst);
    assert!(h.pass(&s, now, &[], now + 10_000, &sys).await.hold);
    assert_eq!(b.calls.load(Ordering::SeqCst), calls);
    // Second failure doubles the wait.
    h.pass(&s, now, &[], now + 30_000, &sys).await;
    assert_eq!(
        h.status().unwrap().destinations[0].next_retry,
        Some(now + 90_000)
    );
    // Back up: everything goes, the banner clears.
    b.down.store(false, Ordering::SeqCst);
    let pass = h.pass(&s, now, &[], now + 90_000, &sys).await;
    assert_eq!(pass.archived.len(), 3);
    assert!(s.hours().await.unwrap().is_empty());
    assert!(sys.history_issue().is_none());
    assert_eq!(
        h.status().unwrap().destinations[0].state,
        DestinationState::Ok
    );
}

#[tokio::test]
async fn gaps_say_why_an_hour_was_not_retained() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    // Before history was ever on, nothing is a gap.
    assert_eq!(
        h.record_gaps(&[1, 2], &[], 10 * H, &Pass::default(), 0)
            .unwrap(),
        0
    );
    let (d, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    // Excluded sources only → an `excluded` gap, the hour still drops.
    fill(&s, 482_950, 1).await;
    let pass = h
        .pass(
            &s,
            482_960 * H,
            &["api".into(), "worker".into()],
            1,
            &SystemState::default(),
        )
        .await;
    assert_eq!(pass.archived, vec![482_950]);
    assert!(s.hours().await.unwrap().is_empty());
    // Held hours the cap dropped, an hour in the window the cap dropped, and
    // (with no active destination) hours the window dropped.
    b.down.store(true, Ordering::SeqCst);
    let held = Pass {
        hold: true,
        waiting: vec![10],
        ..Default::default()
    };
    h.record_gaps(&[10, 11, 12], &[12], 11 * H, &held, 5)
        .unwrap();
    h.create(new_dest("other", false), 0).await.unwrap();
    h.catalog.set_active(999).unwrap(); // nothing active now
    h.record_gaps(&[20], &[], 21 * H, &Pass::default(), 6)
        .unwrap();
    let gaps: Vec<(i64, GapReason)> = h
        .catalog
        .gaps(10)
        .unwrap()
        .into_iter()
        .map(|(hr, r, _)| (hr, r))
        .collect();
    assert_eq!(
        gaps,
        vec![
            (482_950, GapReason::Excluded),
            (20, GapReason::NoDestination),
            (11, GapReason::DiskCap),
            (10, GapReason::DestinationUnavailable),
        ]
    );
    assert_eq!(h.status().unwrap().gap_hours, 4);
    let _ = d;
}

#[tokio::test]
async fn the_retention_job_holds_old_hours_while_the_destination_is_down() {
    let dir = tmp();
    let s: Arc<dyn Store> = Arc::new(store(&dir));
    let (b, conn) = bucket();
    let h = Arc::new(History::memory().with_connector(conn));
    h.create(new_dest("garage-local", true), 0).await.unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    // 30 h ago … now: the 24 h default window expires the oldest ones.
    let mut lines = Vec::new();
    for (i, age) in [30i64, 29, 2, 0].iter().enumerate() {
        let mut l = normalize(&format!("line {age}h"), "api", None, now - age * H);
        l.id = i as u64 + 1;
        lines.push(Arc::new(l));
    }
    s.append(SourceKind::Http, &lines).await.unwrap();
    s.flush().await.unwrap();
    // Destination down: the window holds the old hours (no gaps yet).
    b.down.store(true, Ordering::SeqCst);
    let settings = Arc::new(crate::settings::Settings::memory());
    let system = Arc::new(SystemState::default());
    let shutdown = tokio_util::sync::CancellationToken::new();
    let job = tokio::spawn(crate::retention::run(
        s.clone(),
        settings.clone(),
        system.clone(),
        Arc::new(AtomicUsize::new(0)),
        Some(h.clone()),
        shutdown.clone(),
    ));
    let mut held = false;
    for _ in 0..100 {
        if system.history_issue().is_some() {
            held = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(held, "banner raised");
    assert_eq!(
        s.usage().await.unwrap().lines,
        4,
        "nothing dropped while held"
    );
    assert_eq!(h.status().unwrap().gap_hours, 0);
    shutdown.cancel();
    job.await.unwrap();
}

// ── 5b: retention policy, capacity, cleanup, backfill, copy, delete ────────

use super::jobs::{classify, OpError};
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt as _;
use object_store::{
    CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta,
    PutMultipartOptions, PutOptions, PutResult,
};

/// An in-memory bucket that can refuse deletes (AccessDenied) and counts them.
#[derive(Debug)]
struct Refusing {
    inner: Arc<InMemory>,
    refuse: Arc<AtomicBool>,
    deletes: Arc<AtomicUsize>,
}

impl std::fmt::Display for Refusing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Refusing({})", self.inner)
    }
}

#[async_trait]
impl ObjectStore for Refusing {
    async fn put_opts(
        &self,
        location: &ObjPath,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &ObjPath,
        opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(
        &self,
        location: &ObjPath,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        self.inner.get_opts(location, options).await
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, object_store::Result<ObjPath>>,
    ) -> BoxStream<'static, object_store::Result<ObjPath>> {
        if self.refuse.load(Ordering::SeqCst) {
            let n = self.deletes.clone();
            return locations
                .map(move |l| {
                    n.fetch_add(1, Ordering::SeqCst);
                    let path = l?.to_string();
                    Err(object_store::Error::PermissionDenied {
                        path,
                        source: "AccessDenied: object lock".into(),
                    })
                })
                .boxed();
        }
        let n = self.deletes.clone();
        let out = self.inner.delete_stream(
            locations
                .inspect(move |_| {
                    n.fetch_add(1, Ordering::SeqCst);
                })
                .boxed(),
        );
        out
    }

    fn list(
        &self,
        prefix: Option<&ObjPath>,
    ) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(
        &self,
        prefix: Option<&ObjPath>,
    ) -> object_store::Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy_opts(
        &self,
        from: &ObjPath,
        to: &ObjPath,
        options: CopyOptions,
    ) -> object_store::Result<()> {
        self.inner.copy_opts(from, to, options).await
    }
}

struct Guarded {
    mem: Arc<InMemory>,
    refuse: Arc<AtomicBool>,
    deletes: Arc<AtomicUsize>,
}

fn guarded() -> (Guarded, Connector) {
    let mem = Arc::new(InMemory::new());
    let refuse = Arc::new(AtomicBool::new(false));
    let deletes = Arc::new(AtomicUsize::new(0));
    let (m, r, d) = (mem.clone(), refuse.clone(), deletes.clone());
    let conn: Connector = Arc::new(move |_, _| {
        Ok(Arc::new(Refusing {
            inner: m.clone(),
            refuse: r.clone(),
            deletes: d.clone(),
        }) as Remote)
    });
    (
        Guarded {
            mem,
            refuse,
            deletes,
        },
        conn,
    )
}

async fn keys(mem: &InMemory) -> Vec<String> {
    let mut v: Vec<String> = mem
        .list(None)
        .filter_map(|m| async move { m.ok().map(|m| m.location.to_string()) })
        .collect()
        .await;
    v.sort();
    v
}

/// `n` archived hours from `first` in the active destination of `h`.
async fn archived(h: &History, s: &SqliteStore, first: i64, n: i64) {
    fill(s, first, n).await;
    let sys = SystemState::default();
    let now = (first + n) * H;
    let pass = h.pass(s, now, &[], now, &sys).await;
    assert_eq!(pass.archived.len() as i64, n, "{pass:?}");
}

#[test]
fn refused_deletes_are_told_apart_from_network_errors() {
    let denied = object_store::Error::PermissionDenied {
        path: "x".into(),
        source: "nope".into(),
    };
    assert!(matches!(classify(&denied), OpError::Refused(_)));
    let generic = object_store::Error::Generic {
        store: "S3",
        source: "Error performing DELETE: 403 Forbidden: AccessDenied".into(),
    };
    assert!(matches!(classify(&generic), OpError::Refused(_)));
    let net = object_store::Error::Generic {
        store: "S3",
        source: "error sending request: connection reset".into(),
    };
    assert!(matches!(classify(&net), OpError::Transient(_)));
    assert_eq!(
        crate::history::garage::quota_of(
            &serde_json::json!({"quotas": {"maxSize": 5_000_000_000u64, "maxObjects": null}})
        ),
        Some(5_000_000_000)
    );
    assert_eq!(
        crate::history::garage::quota_of(&serde_json::json!({"quotas": {"maxSize": null}})),
        None
    );
    assert_eq!(fmt_bytes(5_000_000_000), "5 GB");
    assert_eq!(fmt_bytes(1_260_000), "1.3 MB");
}

#[tokio::test]
async fn a_shorter_history_window_previews_needs_confirming_then_deletes() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let (d, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    archived(&h, &s, 482_950, 10).await;
    assert_eq!(
        keys(&b.mem).await.len(),
        10 * 2 + 1,
        "segments, manifests, instance.json"
    );
    // Two days, five hours after the first archived hour: 482950 … 482954 go.
    let now = (482_950 + 48 + 5) * H + 1;
    // 30 days is the default; indefinitely deletes nothing.
    assert_eq!(h.status_at(now).unwrap().policy.retention_days, Some(30));
    assert_eq!(h.preview(None, now).unwrap().hours, 0);
    let p = h.preview(Some(2), now).unwrap();
    assert_eq!((p.hours, p.lines), (5, 10));
    assert_eq!(p.before, Some((482_955) * H));
    assert_eq!(p.destinations.len(), 1);
    assert_eq!(p.destinations[0].name, "garage-local");
    let policy = HistoryPolicy {
        retention_days: Some(2),
        at_capacity: AtCapacity::Evict,
        ..Default::default()
    };
    match h.set_policy(policy.clone(), false, now) {
        Err(HistoryError::ConfirmRequired(p)) => assert_eq!(p.hours, 5),
        other => panic!("expected confirm_required, got {other:?}"),
    }
    assert!(matches!(
        h.set_policy(
            HistoryPolicy {
                retention_days: Some(0),
                ..policy.clone()
            },
            true,
            now
        ),
        Err(HistoryError::Invalid(_))
    ));
    h.set_policy(policy, true, now).unwrap();
    let st = h.status_at(now).unwrap();
    assert_eq!((st.expired_hours, st.retained_from), (5, Some(482_955 * H)));
    let w = h.work(&s, &[], now, &SystemState::default()).await.unwrap();
    assert_eq!(w.deleted, 5);
    let left: Vec<i64> = h
        .catalog
        .hours_of(d.id)
        .unwrap()
        .iter()
        .map(|r| r.hour)
        .collect();
    assert_eq!(left, (482_955..482_960).collect::<Vec<_>>());
    let k = keys(&b.mem).await;
    assert_eq!(k.len(), 5 * 2 + 1);
    assert!(!k.iter().any(|k| k.contains("482950")));
    assert_eq!(h.status_at(now).unwrap().expired_hours, 0);
    // Nothing more to do.
    assert!(!h
        .work(&s, &[], now, &SystemState::default())
        .await
        .unwrap()
        .busy());
}

#[tokio::test]
async fn at_capacity_evicts_oldest_or_stops_archiving() {
    let dir = tmp();
    let s = store(&dir);
    let (_b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let (d, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    archived(&h, &s, 482_950, 6).await;
    let per = h.catalog.hours_of(d.id).unwrap()[0].bytes_stored;
    // Garage's quota is the capacity of garage-local unless an owner set one.
    h.set_garage_quota(Some(per * 100));
    let view = h.destination(d.id).unwrap();
    assert_eq!(view.capacity_source, Some(CapacitySource::Garage));
    assert!(!view.at_capacity);
    // Owner-set wins: room for about three hours → the three oldest go.
    let held = h.catalog.held(d.id).unwrap().bytes_stored;
    let cap = held - 2 * per - per / 2;
    let view = h.set_capacity(d.id, Some(cap.max(1_000_000))).unwrap();
    assert_eq!(view.capacity_source, Some(CapacitySource::Owner));
    assert!(matches!(
        h.set_capacity(d.id, Some(10)),
        Err(HistoryError::Invalid(_))
    ));
    // Segments here are tiny: compare against the stored total instead.
    h.catalog.set_capacity(d.id, Some(cap)).unwrap();
    assert!(h.destination(d.id).unwrap().at_capacity);
    let now = 482_960 * H;
    let w = h.work(&s, &[], now, &SystemState::default()).await.unwrap();
    assert_eq!(w.deleted, 3);
    let left: Vec<i64> = h
        .catalog
        .hours_of(d.id)
        .unwrap()
        .iter()
        .map(|r| r.hour)
        .collect();
    assert_eq!(left, vec![482_953, 482_954, 482_955]);
    // A capacity smaller than one hour never evicts the newest hour.
    h.catalog.set_capacity(d.id, Some(1)).unwrap();
    h.work(&s, &[], now, &SystemState::default()).await.unwrap();
    assert_eq!(h.catalog.hours_of(d.id).unwrap().len(), 1);

    // Stop archiving: expiring hours wait, the banner says why, and once
    // the disk cap drops them they are `at_capacity` gaps.
    h.set_policy(
        HistoryPolicy {
            retention_days: None,
            at_capacity: AtCapacity::Stop,
            ..Default::default()
        },
        true,
        now,
    )
    .unwrap();
    fill(&s, 482_970, 2).await;
    let sys = SystemState::default();
    let now = 482_980 * H;
    let before = s.hours().await.unwrap();
    let pass = h.pass(&s, now, &[], now, &sys).await;
    assert!(pass.hold && pass.at_capacity);
    assert_eq!(pass.waiting, vec![482_970, 482_971]);
    assert_eq!(s.hours().await.unwrap().len(), 2, "held locally");
    let issue = sys.history_issue_of(IssueKind::HistoryAtCapacity).unwrap();
    assert!(issue.detail.contains("2 hours waiting"), "{}", issue.detail);
    h.record_gaps(&before, &[], now, &pass, now).unwrap();
    assert_eq!(h.catalog.gaps(1).unwrap()[0].1, GapReason::AtCapacity);
    // Room again: the banner clears on the next pass.
    h.catalog.set_capacity(d.id, None).unwrap();
    h.set_garage_quota(None);
    fill(&s, 482_972, 1).await;
    let pass = h.pass(&s, now, &[], now, &sys).await;
    assert!(!pass.at_capacity);
    assert!(sys.history_issue_of(IssueKind::HistoryAtCapacity).is_none());
}

#[tokio::test]
async fn refused_deletes_block_cleanup_with_backoff_until_retry() {
    let dir = tmp();
    let s = store(&dir);
    let (g, conn) = guarded();
    let h = History::memory().with_connector(conn);
    let (d, v) = h.create(new_dest("r2-prod", true), 0).await.unwrap();
    assert!(v.ok);
    archived(&h, &s, 482_950, 4).await;
    h.set_policy(
        HistoryPolicy {
            retention_days: Some(1),
            at_capacity: AtCapacity::Evict,
            ..Default::default()
        },
        true,
        0,
    )
    .unwrap();
    g.refuse.store(true, Ordering::SeqCst);
    let sys = SystemState::default();
    let now = (482_960 + 48) * H;
    let w = h.work(&s, &[], now, &sys).await.unwrap();
    assert_eq!(w.deleted, 0);
    let view = h.destination(d.id).unwrap();
    assert_eq!(view.cleanup_blocked_hours, 4);
    assert!(view
        .cleanup_error
        .as_deref()
        .unwrap()
        .contains("AccessDenied"));
    assert_eq!(view.cleanup_retry_at, Some(now + 5 * 60_000));
    let issue = sys
        .history_issue_of(IssueKind::HistoryCleanupBlocked)
        .unwrap();
    assert!(issue.title.contains("r2-prod"), "{}", issue.title);
    assert!(
        issue.detail.starts_with("4 hours can't be deleted"),
        "{}",
        issue.detail
    );
    // No tight loop: before the retry time nothing is attempted.
    let tried = g.deletes.load(Ordering::SeqCst);
    h.work(&s, &[], now + 60_000, &sys).await.unwrap();
    assert_eq!(g.deletes.load(Ordering::SeqCst), tried);
    // The second refusal doubles the wait.
    h.work(&s, &[], now + 5 * 60_000, &sys).await.unwrap();
    assert_eq!(
        h.destination(d.id).unwrap().cleanup_retry_at,
        Some(now + 5 * 60_000 + 10 * 60_000)
    );
    // Permissions fixed, Retry: the hours go and the banner clears.
    g.refuse.store(false, Ordering::SeqCst);
    h.retry_cleanup(d.id).unwrap();
    let w = h.work(&s, &[], now + 6 * 60_000, &sys).await.unwrap();
    assert_eq!(w.deleted, 4);
    let view = h.destination(d.id).unwrap();
    assert_eq!(
        (view.cleanup_blocked_hours, view.cleanup_error.clone()),
        (0, None)
    );
    assert!(sys
        .history_issue_of(IssueKind::HistoryCleanupBlocked)
        .is_none());
    assert_eq!(keys(&g.mem).await.len(), 1, "only instance.json");
}

#[tokio::test]
async fn backfill_archives_the_local_window_now_and_expiry_reuses_it() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let now = 482_954 * H + 10 * 60_000;
    // Nothing active: no backfill.
    assert!(matches!(
        h.backfill(&s, now).await,
        Err(HistoryError::Conflict("no_destination", _))
    ));
    let (d, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    fill(&s, 482_950, 5).await; // the last hour (482954) is still open
    assert_eq!(
        h.backfill_candidates(&s, now).await.unwrap(),
        vec![482_950, 482_951, 482_952, 482_953]
    );
    assert_eq!(h.status_with(&s, now).await.unwrap().backfill_hours, 4);
    let job = h.backfill(&s, now).await.unwrap();
    assert_eq!(
        (job.kind, job.state, job.total),
        (JobKind::Backfill, JobState::Running, 4)
    );
    // Asking again returns the same job.
    assert_eq!(h.backfill(&s, now).await.unwrap().id, job.id);
    let w = h.work(&s, &[], now, &SystemState::default()).await.unwrap();
    assert_eq!(w.archived, 4);
    let job = h.job(job.id).unwrap();
    assert_eq!((job.state, job.done), (JobState::Done, 4));
    assert!(job.bytes > 0);
    // Local hours are untouched: the window still serves them.
    assert_eq!(s.hours().await.unwrap().len(), 5);
    assert_eq!(h.catalog.hours_of(d.id).unwrap().len(), 4);
    assert!(matches!(
        h.backfill(&s, now).await,
        Err(HistoryError::Conflict("nothing_to_backfill", _))
    ));
    // When they expire, the unchanged hours are not uploaded again.
    let first = h.catalog.hour_of(d.id, 482_950).unwrap().unwrap();
    let before = keys(&b.mem).await;
    let pass = h
        .pass(&s, 482_952 * H, &[], 482_999 * H, &SystemState::default())
        .await;
    assert_eq!(pass.archived, vec![482_950, 482_951]);
    assert_eq!(
        h.catalog
            .hour_of(d.id, 482_950)
            .unwrap()
            .unwrap()
            .archived_at,
        first.archived_at
    );
    assert_eq!(keys(&b.mem).await, before);
}

#[tokio::test]
async fn switching_destinations_copies_history_and_resumes_after_a_restart() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::open(&dir).unwrap().with_connector(conn.clone());
    let (a, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    archived(&h, &s, 482_950, 6).await;
    let mut r2 = new_dest("r2-prod", false);
    r2.kind = DestinationKind::R2;
    r2.endpoint = Some("https://acct.r2.cloudflarestorage.com".into());
    r2.bucket = "other".into(); // not the same bucket: download → upload
    r2.prefix = Some("r2/".into());
    let (r, _) = h.create(r2, 0).await.unwrap();
    let now = 482_999 * H;
    h.activate(r.id, true, now).await.unwrap();
    let st = h.status_at(now).unwrap();
    assert_eq!(st.active, Some(r.id));
    let job = st.jobs[0].clone();
    assert_eq!((job.kind, job.total, job.done), (JobKind::Copy, 6, 0));
    assert_eq!(
        (job.source.as_deref(), job.destination.as_deref()),
        (Some("garage-local"), Some("r2-prod"))
    );
    // Two hours, then the server stops.
    let w = h
        .work_budget(&s, &[], now, &SystemState::default(), 2)
        .await
        .unwrap();
    assert_eq!(w.copied, 2);
    drop(h);
    let h = History::open(&dir).unwrap().with_connector(conn);
    let job = h.job(job.id).unwrap();
    assert_eq!((job.state, job.done), (JobState::Running, 2));
    let w = h
        .work(&s, &[], now + 1, &SystemState::default())
        .await
        .unwrap();
    assert_eq!(w.copied, 4);
    let job = h.job(job.id).unwrap();
    assert_eq!((job.state, job.done), (JobState::Done, 6));
    // Both hold every hour; the copies live under r2/ with their manifests.
    assert_eq!(h.catalog.hours_of(a.id).unwrap().len(), 6);
    let copies = h.catalog.hours_of(r.id).unwrap();
    assert_eq!(copies.len(), 6);
    assert!(
        copies[0].key.starts_with("r2/v1/hours/"),
        "{}",
        copies[0].key
    );
    let k = keys(&b.mem).await;
    assert!(k.contains(&"r2/v1/manifest/482950.json".to_string()));
    assert_eq!(
        get(&b.mem, &copies[0].key).await.len() as u64,
        copies[0].bytes_stored
    );
    // Cancelling a finished job is refused.
    assert!(matches!(
        h.cancel_job(job.id, now),
        Err(HistoryError::Conflict("finished", _))
    ));
}

#[tokio::test]
async fn removing_a_destination_can_delete_its_history_first() {
    let dir = tmp();
    let s = store(&dir);
    let (b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let (a, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    archived(&h, &s, 482_950, 3).await;
    let mut other = new_dest("r2-prod", true);
    other.prefix = Some("r2/".into());
    let (r, _) = h.create(other, 0).await.unwrap();
    assert!(h.destination(r.id).unwrap().active);
    // The active destination can't go until another is active or history is off.
    assert!(matches!(
        h.remove(r.id, true, 1),
        Err(HistoryError::Conflict("active", _))
    ));
    let job = h.remove(a.id, true, 1).unwrap().unwrap();
    assert_eq!((job.kind, job.total), (JobKind::Delete, 3));
    assert!(h.destination(a.id).unwrap().removing);
    assert!(matches!(
        h.activate(a.id, false, 1).await,
        Err(HistoryError::Conflict("removing", _))
    ));
    // Asking again returns the running job.
    assert_eq!(h.remove(a.id, true, 1).unwrap().unwrap().id, job.id);
    let w = h.work(&s, &[], 2, &SystemState::default()).await.unwrap();
    assert_eq!(w.deleted, 3);
    // Next step: nothing left, so it is forgotten and instance.json goes.
    h.work(&s, &[], 3, &SystemState::default()).await.unwrap();
    assert!(matches!(h.destination(a.id), Err(HistoryError::NotFound)));
    assert_eq!(h.job(job.id).unwrap().state, JobState::Done);
    let inst = h.catalog.instance_id().unwrap();
    assert!(!keys(&b.mem)
        .await
        .iter()
        .any(|k| k.starts_with(&format!("quiet/{inst}/"))));
    // History off, then the last destination can be removed (keeping data).
    h.turn_off().unwrap();
    assert!(h.remove(r.id, false, 4).unwrap().is_none());
    assert!(h.destinations().unwrap().is_empty());
}

#[tokio::test]
async fn a_refused_delete_job_is_blocked_and_cancel_keeps_what_is_left() {
    let dir = tmp();
    let s = store(&dir);
    let (g, conn) = guarded();
    let h = History::memory().with_connector(conn);
    let (a, _) = h.create(new_dest("garage-local", true), 0).await.unwrap();
    archived(&h, &s, 482_950, 2).await;
    h.turn_off().unwrap();
    g.refuse.store(true, Ordering::SeqCst);
    let job = h.remove(a.id, true, 10).unwrap().unwrap();
    h.work(&s, &[], 10, &SystemState::default()).await.unwrap();
    let j = h.job(job.id).unwrap();
    assert_eq!(j.state, JobState::Blocked);
    assert!(j.error.unwrap().contains("AccessDenied"));
    assert_eq!(j.next_retry, Some(10 + 5 * 60_000));
    // Cancel: the destination stays, read-only, with its hours.
    h.cancel_job(job.id, 11).unwrap();
    let d = h.destination(a.id).unwrap();
    assert!(!d.removing);
    assert_eq!(d.hours, 2);
    // Retry on a cancelled job is refused; a new removal starts a new job.
    assert!(matches!(
        h.retry_job(job.id, 12),
        Err(HistoryError::Conflict("finished", _))
    ));
    g.refuse.store(false, Ordering::SeqCst);
    let again = h.remove(a.id, true, 13).unwrap().unwrap();
    assert_ne!(again.id, job.id);
    h.retry_cleanup(a.id).unwrap();
    h.work(&s, &[], 14, &SystemState::default()).await.unwrap();
    h.work(&s, &[], 15, &SystemState::default()).await.unwrap();
    assert!(matches!(h.destination(a.id), Err(HistoryError::NotFound)));
}

// ── Phase 5c: searching retained history ───────────────────────────────────

mod history_search {
    use super::*;
    use crate::history::search::{Cache, HistorySearch, SearchJobState};

    fn searcher(dir: &Path, max: u64) -> Arc<HistorySearch> {
        Arc::new(HistorySearch::new(
            Cache::open(&dir.join("history-cache"), max).unwrap(),
        ))
    }

    fn q(text: &str, since: i64, until: i64) -> SearchQuery {
        SearchQuery {
            text: if text.is_empty() {
                vec![]
            } else {
                vec![text.into()]
            },
            since: Some(since),
            until: Some(until),
            limit: 100,
            histogram: Some(10),
            ..Default::default()
        }
    }

    async fn settle(job: &crate::history::search::Job) {
        for _ in 0..500 {
            if job.state() != SearchJobState::Retrieving {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("history job never finished");
    }

    /// Ten hours 482950…482959; the first six archived to `garage-local`
    /// and dropped locally, so the local window starts at 482956.
    async fn setup() -> (PathBuf, SqliteStore, Bucket, Arc<History>, Vec<u64>) {
        let dir = tmp();
        let s = store(&dir);
        let (b, conn) = bucket();
        let h = History::memory().with_connector(conn);
        // These hours are from 2025: keep them (the 30-day default would
        // count them as expired).
        h.catalog
            .set_policy(&HistoryPolicy {
                retention_days: None,
                ..Default::default()
            })
            .unwrap();
        h.create(new_dest("garage-local", true), 0).await.unwrap();
        fill(&s, 482_950, 10).await;
        // What a local search finds in the six hours that will be archived.
        let before = s
            .search(&q("payout", 482_950 * H, 482_956 * H - 1))
            .await
            .unwrap();
        let expected: Vec<u64> = before.lines.iter().map(|l| l.id).collect();
        assert_eq!(expected.len(), 6);
        let now = 482_960 * H;
        let pass = h
            .pass(&s, 482_956 * H, &[], now, &SystemState::default())
            .await;
        assert_eq!(pass.archived.len(), 6);
        assert_eq!(s.hours().await.unwrap()[0], 482_956);
        (dir, s, b, Arc::new(h), expected)
    }

    #[tokio::test]
    async fn a_segment_answers_like_the_local_window_did() {
        let (dir, _s, _b, h, expected) = setup().await;
        let hs = searcher(&dir, u64::MAX);
        let job = hs
            .start(
                h.clone(),
                q("payout", 482_950 * H, 482_960 * H),
                Some(482_956),
                1,
                482_960 * H,
            )
            .unwrap();
        settle(&job).await;
        let v = job.view(0, 100);
        assert_eq!(v.state, SearchJobState::Done);
        assert_eq!((v.done, v.total), (6, 6));
        assert_eq!(v.lines.iter().map(|l| l.id).collect::<Vec<_>>(), expected);
        assert!(v.locations.values().all(|n| n == "garage-local"));
        assert_eq!(v.matched, 6);
        assert!(v.downloaded > 0 && v.downloaded == v.bytes);
        let hist: u64 = v.histogram.unwrap().iter().map(|b| b.count).sum();
        assert_eq!(hist, 6);
        // A second job reuses the cache: nothing downloaded.
        let again = hs
            .start(
                h.clone(),
                q("payout", 482_950 * H, 482_960 * H),
                Some(482_956),
                1,
                482_960 * H,
            )
            .unwrap();
        settle(&again).await;
        assert_eq!(again.view(0, 1).downloaded, 0);
        // An id lookup through the segment's id index.
        let by_id = hs
            .start(
                h.clone(),
                SearchQuery {
                    ids: vec!["req_482951".into()],
                    ..q("", 482_950 * H, 482_960 * H)
                },
                Some(482_956),
                1,
                482_960 * H,
            )
            .unwrap();
        settle(&by_id).await;
        assert_eq!(by_id.view(0, 10).lines.len(), 1);
        // Jobs are per user.
        assert!(hs.job(&job.id, 2).is_err());
        assert!(hs.job(&job.id, 1).is_ok());
    }

    #[tokio::test]
    async fn coverage_reports_hours_gaps_and_where_history_starts() {
        let (_dir, _s, _b, h, _) = setup().await;
        h.catalog.add_gap(482_949, GapReason::DiskCap, 0).unwrap();
        h.catalog.add_gap(482_948, GapReason::DiskCap, 0).unwrap();
        let (c, planned) = h
            .coverage(482_940 * H, 482_960 * H, Some(482_956), 482_960 * H)
            .unwrap()
            .unwrap();
        assert_eq!((c.from, c.to), (482_940 * H, 482_956 * H));
        assert_eq!((c.hours, c.archived), (16, 6));
        assert_eq!(c.expired_before, Some(482_950 * H));
        assert_eq!(c.destinations.len(), 1);
        assert_eq!(c.destinations[0].percent, 100);
        assert_eq!(c.destinations[0].first, Some(482_950 * H));
        assert_eq!(c.gaps.len(), 1, "consecutive gap hours merge");
        assert_eq!((c.gaps[0].from, c.gaps[0].to), (482_948 * H, 482_950 * H));
        assert!(!c.auto, "16 hours back is more than the automatic 6");
        assert!(!c.truncated);
        assert_eq!(
            planned.iter().map(|p| p.hour).collect::<Vec<_>>(),
            (482_950..482_956).rev().collect::<Vec<_>>(),
            "newest first"
        );
        // A range inside the local window has no history part.
        assert!(h
            .coverage(482_957 * H, 482_960 * H, Some(482_956), 482_960 * H)
            .unwrap()
            .is_none());
        // Reaching three hours back: searched automatically.
        let (near, _) = h
            .coverage(482_953 * H, 482_960 * H, Some(482_956), 482_960 * H)
            .unwrap()
            .unwrap();
        assert!(near.auto);
        assert_eq!(near.expired_before, None);
    }

    #[tokio::test]
    async fn cancel_keeps_what_was_found_and_a_down_destination_is_incomplete() {
        let (dir, _s, b, h, _) = setup().await;
        let hs = searcher(&dir, u64::MAX);
        let job = hs
            .start(
                h.clone(),
                q("payout", 482_950 * H, 482_960 * H),
                Some(482_956),
                7,
                482_960 * H,
            )
            .unwrap();
        // Cancelled before the job ran an hour.
        hs.cancel(&job.id, 7).unwrap();
        settle(&job).await;
        assert_eq!(job.state(), SearchJobState::Cancelled);
        b.down.store(true, Ordering::SeqCst);
        let down = hs
            .start(
                h.clone(),
                q("payout", 482_950 * H, 482_960 * H),
                Some(482_956),
                7,
                482_960 * H,
            )
            .unwrap();
        settle(&down).await;
        let v = down.view(0, 10);
        assert_eq!(v.state, SearchJobState::Incomplete);
        assert_eq!(v.failures.len(), 1);
        assert_eq!(v.failures[0].destination, "garage-local");
        assert_eq!(v.failures[0].hours, 6);
        assert_eq!(
            (v.failures[0].from, v.failures[0].to),
            (482_950 * H, 482_956 * H)
        );
        assert!(v.failures[0].error.contains("connection refused"));
        // The destination is tried once, not once per hour.
        assert_eq!(v.done, 6);
    }

    #[tokio::test]
    async fn the_api_runs_jobs_per_user_and_exports_their_matches() {
        use crate::accounts::Role;
        use crate::api::AppState;
        use crate::auth::Viewer;
        use crate::hub::Hub;
        use crate::pipeline::Pipeline;
        use crate::receiver::DockerStatus;
        use crate::store::MemoryStore;
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let (dir, _s, _b, h, _) = setup().await;
        let st = AppState::new(
            Pipeline::new(Arc::new(MemoryStore::new(10)), Hub::new()),
            Arc::new(Mutex::new(DockerStatus::Disabled)),
        )
        .auth_off()
        .with_history(h.clone())
        .with_history_search(searcher(&dir, u64::MAX));
        let app = |id: i64, role: Role| {
            let mut v = Viewer::local();
            v.user.id = id;
            v.user.role = role;
            crate::history_search_api::routes()
                .layer(axum::Extension(v))
                .with_state(st.clone())
        };
        let call = |app: axum::Router, req: Request<Body>| async move {
            let r = app.oneshot(req).await.unwrap();
            let status = r.status();
            let body = r.into_body().collect().await.unwrap().to_bytes().to_vec();
            (status, body)
        };
        let post = |query: String| {
            Request::post("/api/search/history")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "query": query }).to_string(),
                ))
                .unwrap()
        };
        // No archived hour in the range: nothing to search.
        let now = chrono::Utc::now().timestamp_millis();
        let (code, body) = call(
            app(1, Role::Owner),
            post(format!("since={}&until={}", now + H, now + 2 * H)),
        )
        .await;
        assert_eq!(
            code,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&body)
        );
        let (code, body) = call(
            app(1, Role::Owner),
            post(format!(
                "q=payout&since={}&until={}",
                482_950 * H,
                482_956 * H - 1
            )),
        )
        .await;
        assert_eq!(code, StatusCode::ACCEPTED);
        let id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        settle(&st.history_search.job(&id, 1).unwrap()).await;
        let get = |path: String| Request::get(path).body(Body::empty()).unwrap();
        let (code, body) = call(
            app(1, Role::Owner),
            get(format!("/api/search/history/{id}")),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["state"], "done");
        assert_eq!(v["count"], 6);
        // Another user can't see it.
        let (code, _) = call(
            app(2, Role::Member),
            get(format!("/api/search/history/{id}")),
        )
        .await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        // Export: NDJSON, oldest first.
        let (code, body) = call(
            app(1, Role::Owner),
            get(format!("/api/search/history/{id}/export?format=ndjson")),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let text = String::from_utf8(body).unwrap();
        assert_eq!(text.lines().count(), 6);
        assert!(text.lines().next().unwrap().contains("req_482950"));
    }

    #[test]
    fn the_cache_evicts_least_recently_used_and_refuses_bad_checksums() {
        let dir = tmp();
        let seg = |n: u8| {
            let raw = vec![n; 1000];
            let z = zstd::encode_all(raw.as_slice(), 3).unwrap();
            (hex(&sha2::Sha256::digest(&z)), z)
        };
        let c = Cache::open(&dir, 2_500).unwrap();
        let (a, az) = seg(1);
        let (b2, bz) = seg(2);
        let (c3, cz) = seg(3);
        c.put(&a, &az).unwrap();
        c.put(&b2, &bz).unwrap();
        assert!(c.get(&a).is_some(), "touch a: b is now least recently used");
        c.put(&c3, &cz).unwrap();
        assert!(c.get(&b2).is_none(), "b evicted");
        assert!(c.get(&a).is_some() && c.get(&c3).is_some());
        let err = c.put(&a, &bz).unwrap_err().to_string();
        assert!(err.contains("checksum mismatch"), "{err}");
        // What an earlier run downloaded is kept on restart.
        let again = Cache::open(&dir, 2_500).unwrap();
        assert!(again.get(&a).is_some() && again.get(&c3).is_some());
    }

    #[tokio::test]
    async fn a_flow_near_the_window_edge_or_found_in_the_cache_is_marked() {
        let (dir, _s, _b, h, _) = setup().await;
        let hs = searcher(&dir, u64::MAX);
        let near = hs
            .flow_history(
                &h,
                &["req_482956".into()],
                Some(482_956 * H + 60_000),
                Some(482_956),
            )
            .unwrap()
            .unwrap();
        assert_eq!((near.since, near.until), (482_950 * H, 482_956 * H));
        assert!(!near.found);
        let far = || {
            hs.flow_history(&h, &["req_482951".into()], Some(482_959 * H), Some(482_956))
                .unwrap()
        };
        assert!(far().is_none(), "far from the edge, nothing cached");
        let job = hs
            .start(
                h.clone(),
                q("", 482_950 * H, 482_960 * H),
                Some(482_956),
                1,
                482_960 * H,
            )
            .unwrap();
        settle(&job).await;
        assert!(far().unwrap().found, "a cached segment holds the id");
        // No local window, no marker.
        assert!(hs
            .flow_history(&h, &["req_482951".into()], None, None)
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn the_connection_test_lists_writes_reads_deletes_and_saves_nothing() {
    let (_b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let v = h.test(&new_dest("production-r2", false), 0).await.unwrap();
    let order: Vec<_> = v.steps.iter().map(|s| s.step).collect();
    assert_eq!(
        order,
        [
            VerifyStepKind::List,
            VerifyStepKind::Write,
            VerifyStepKind::Read,
            VerifyStepKind::Delete
        ]
    );
    assert!(v.ok && v.cleanup && v.steps.iter().all(|s| !s.skipped));
    // Nothing was saved.
    assert!(h.catalog.destinations().unwrap().is_empty());
    // A client that can't be built: the first step says why, the rest are
    // not run.
    let down: Connector = Arc::new(|_, _| anyhow::bail!("no credentials found"));
    let h = History::memory().with_connector(down);
    let v = h.test(&new_dest("x", false), 0).await.unwrap();
    assert!(!v.ok);
    assert!(v.steps[0]
        .error
        .as_deref()
        .unwrap()
        .contains("no credentials"));
    assert!(v.steps[1..].iter().all(|s| s.skipped));
}

#[test]
fn a_session_token_is_sealed_with_the_secret() {
    use super::remote::{pack, unpack};
    assert_eq!(unpack(&pack("s3cr3t", None)), ("s3cr3t".into(), None));
    assert_eq!(
        unpack(&pack("s3cr3t", Some("tok"))),
        ("s3cr3t".into(), Some("tok".into()))
    );
    assert_eq!(unpack(&pack(" s ", Some("  "))), ("s".into(), None));
}

#[tokio::test]
async fn host_credentials_need_no_keys_on_amazon_s3_only() {
    let (_b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    let mut n = new_dest("disaster-recovery", false);
    n.access_key_id = String::new();
    n.secret_access_key = String::new();
    assert!(matches!(h.test(&n, 0).await, Err(HistoryError::Invalid(_))));
    n.kind = DestinationKind::S3;
    n.endpoint = None;
    assert!(h.check_s3_host(&n));
}

#[tokio::test]
async fn the_policy_size_limit_is_each_connectors_capacity() {
    let (_b, conn) = bucket();
    let h = History::memory().with_connector(conn);
    h.create(new_dest("garage-local", true), 0).await.unwrap();
    let d = h.catalog.destinations().unwrap().remove(0);
    assert_eq!(h.capacity(&d), None);
    h.catalog
        .set_policy(&HistoryPolicy {
            size_limit_bytes: Some(100_000_000_000),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        h.capacity(&d),
        Some((100_000_000_000, CapacitySource::Policy))
    );
}
