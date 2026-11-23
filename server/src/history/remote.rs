//! A destination as an object store (S3 API: Garage, R2, S3, S3-compatible),
//! the object layout, and Verify.

use super::catalog::DestinationRow;
use super::{DestinationKind, VerifyResult, VerifyStep, VerifyStepKind};
use futures_util::StreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload, RetryConfig};
use std::sync::Arc;
use std::time::Duration;

pub type Remote = Arc<dyn ObjectStore>;

/// TLS for every outbound client (object stores, Garage's admin API): rustls
/// with the `ring` provider, installed once per process. Roots come from the
/// system store (the image ships a CA bundle).
pub fn init_tls() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Build a client for a destination. Nothing is sent until it is used.
pub fn connect(d: &DestinationRow, secret: &str) -> anyhow::Result<Remote> {
    init_tls();
    let mut b = AmazonS3Builder::new()
        .with_bucket_name(&d.bucket)
        .with_access_key_id(&d.access_key_id)
        .with_secret_access_key(secret)
        .with_virtual_hosted_style_request(!d.path_style)
        .with_retry(RetryConfig {
            max_retries: 2,
            retry_timeout: Duration::from_secs(20),
            ..Default::default()
        });
    let region = match (d.kind, d.region.trim()) {
        (DestinationKind::R2, "") => "auto",
        (DestinationKind::Garage, "") => "garage",
        (_, "") => "us-east-1",
        (_, r) => r,
    };
    b = b.with_region(region);
    if let Some(e) = d
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        b = b.with_endpoint(e).with_allow_http(e.starts_with("http://"));
    }
    Ok(Arc::new(b.build()?))
}

/// Hour number (unix ms / 3 600 000) → `<prefix>v1/hours/YYYY/MM/DD/<hour>.seg.zst`.
pub fn hour_key(prefix: &str, hour: i64) -> String {
    let day = chrono::DateTime::from_timestamp_millis(hour * 3_600_000)
        .map(|t| t.format("%Y/%m/%d").to_string())
        .unwrap_or_else(|| "0000/00/00".into());
    format!("{prefix}v1/hours/{day}/{hour}.seg.zst")
}

pub fn manifest_key(prefix: &str, hour: i64) -> String {
    format!("{prefix}v1/manifest/{hour}.json")
}

pub fn instance_key(prefix: &str) -> String {
    format!("{prefix}v1/instance.json")
}

/// `quiet/<instance>/` unless the owner chose a prefix; always ends in `/`.
pub fn normalize_prefix(prefix: &str, instance_id: &str) -> String {
    let p = prefix.trim().trim_matches('/');
    if p.is_empty() {
        format!("quiet/{instance_id}/")
    } else {
        format!("{p}/")
    }
}

fn short(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 240 {
        format!("{}…", s.chars().take(240).collect::<String>())
    } else {
        s
    }
}

/// Put a small object, read it back, list the prefix, delete it. Every
/// step is reported; a failed write skips the rest.
pub async fn verify(remote: &Remote, prefix: &str, now: i64) -> VerifyResult {
    let key = ObjPath::from(format!(
        "{prefix}v1/.quiet-verify-{:08x}",
        rand::random::<u32>()
    ));
    let body = format!("quiet verify {now}");
    let mut steps = Vec::new();
    let step = |kind, r: Result<(), String>| VerifyStep {
        step: kind,
        ok: r.is_ok(),
        error: r.err(),
    };
    let write = remote
        .put(&key, PutPayload::from(body.clone().into_bytes()))
        .await
        .map(|_| ())
        .map_err(short);
    let wrote = write.is_ok();
    steps.push(step(VerifyStepKind::Write, write));
    if !wrote {
        for k in [
            VerifyStepKind::Read,
            VerifyStepKind::List,
            VerifyStepKind::Delete,
        ] {
            steps.push(step(k, Err("skipped: write failed".into())));
        }
        return VerifyResult::from_steps(steps, now);
    }
    let read = match remote.get(&key).await {
        Ok(g) => match g.bytes().await {
            Ok(b) if b.as_ref() == body.as_bytes() => Ok(()),
            Ok(_) => Err("read back different bytes".into()),
            Err(e) => Err(short(e)),
        },
        Err(e) => Err(short(e)),
    };
    steps.push(step(VerifyStepKind::Read, read));
    let mut listed = remote.list(Some(&ObjPath::from(format!("{prefix}v1"))));
    let mut list = Err("the test object was not listed".to_string());
    while let Some(m) = listed.next().await {
        match m {
            Ok(m) if m.location == key => {
                list = Ok(());
                break;
            }
            Ok(_) => {}
            Err(e) => {
                list = Err(short(e));
                break;
            }
        }
    }
    steps.push(step(VerifyStepKind::List, list));
    let del = remote.delete(&key).await.map_err(short);
    steps.push(step(VerifyStepKind::Delete, del));
    VerifyResult::from_steps(steps, now)
}
