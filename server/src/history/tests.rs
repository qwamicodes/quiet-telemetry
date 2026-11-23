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
    // Copy history and deleting history are 5b; the active one can't go.
    assert!(matches!(
        h.activate(d2.id, true, 4_000).await,
        Err(HistoryError::NotYet(_))
    ));
    assert!(matches!(
        h.remove(d.id, false),
        Err(HistoryError::Conflict("active", _))
    ));
    assert!(matches!(
        h.remove(d2.id, true),
        Err(HistoryError::NotYet(_))
    ));
    h.remove(d2.id, false).unwrap();
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
