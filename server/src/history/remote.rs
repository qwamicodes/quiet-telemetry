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

/// The sealed secret holds the secret access key and, for temporary
/// credentials, the session token: `secret` or `secret\0token`.
pub fn pack(secret: &str, token: Option<&str>) -> String {
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => format!("{}\0{t}", secret.trim()),
        None => secret.trim().to_string(),
    }
}

pub fn unpack(sealed: &str) -> (String, Option<String>) {
    match sealed.split_once('\0') {
        Some((s, t)) => (s.to_string(), Some(t.to_string())),
        None => (sealed.to_string(), None),
    }
}

/// Build a client for a destination. Nothing is sent until it is used. A
/// blank access key id (Amazon S3) uses the credentials available to the
/// host: `AWS_*` environment, then instance, task or workload roles.
pub fn connect(d: &DestinationRow, sealed: &str) -> anyhow::Result<Remote> {
    init_tls();
    let (secret, token) = unpack(sealed);
    let mut b = if d.access_key_id.is_empty() {
        AmazonS3Builder::from_env()
    } else {
        let b = AmazonS3Builder::new()
            .with_access_key_id(&d.access_key_id)
            .with_secret_access_key(&secret);
        match token {
            Some(t) => b.with_token(t),
            None => b,
        }
    };
    b = b
        .with_bucket_name(&d.bucket)
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

/// The S3 error code and message in a provider response, if any:
/// `AccessDenied · Access Denied`.
fn s3_code(s: &str) -> Option<String> {
    let tag = |t: &str| {
        let open = format!("<{t}>");
        let start = s.find(&open)? + open.len();
        let end = s[start..].find(&format!("</{t}>"))? + start;
        Some(s[start..end].trim().to_string())
    };
    let code = tag("Code")?;
    Some(match tag("Message").filter(|m| !m.is_empty()) {
        Some(m) => format!("{code} · {m}"),
        None => code,
    })
}

fn short(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    if let Some(c) = s3_code(&s) {
        return c;
    }
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 240 {
        format!("{}…", s.chars().take(240).collect::<String>())
    } else {
        s
    }
}

/// Every step not run, because the client couldn't be built (bad endpoint,
/// no host credentials): the error goes on the first step.
pub fn unreachable(error: &str, now: i64) -> VerifyResult {
    let steps = ORDER
        .iter()
        .enumerate()
        .map(|(i, &step)| VerifyStep {
            step,
            ok: false,
            skipped: i > 0,
            error: (i == 0).then(|| error.to_string()),
        })
        .collect();
    VerifyResult::from_steps(steps, now)
}

/// The order the connection test runs in (v1.1-05/06).
const ORDER: [VerifyStepKind; 4] = [
    VerifyStepKind::List,
    VerifyStepKind::Write,
    VerifyStepKind::Read,
    VerifyStepKind::Delete,
];

/// List the prefix, write a small object, read it back, delete it. Every
/// step is reported; a failed list or write leaves the rest not run.
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
        skipped: false,
        error: r.err(),
    };
    let not_run = |kind, why: &str| VerifyStep {
        step: kind,
        ok: false,
        skipped: true,
        error: Some(why.to_string()),
    };
    // List: reading the prefix's listing (empty is fine).
    let mut listing = remote.list(Some(&ObjPath::from(format!("{prefix}v1"))));
    let mut list = Ok(());
    if let Some(Err(e)) = listing.next().await {
        list = Err(short(e));
    }
    drop(listing);
    let listed = list.is_ok();
    steps.push(step(VerifyStepKind::List, list));
    if !listed {
        steps.push(not_run(VerifyStepKind::Write, "list failed"));
        steps.push(not_run(VerifyStepKind::Read, "list failed"));
        steps.push(not_run(VerifyStepKind::Delete, "no test object created"));
        return VerifyResult::from_steps(steps, now);
    }
    let write = remote
        .put(&key, PutPayload::from(body.clone().into_bytes()))
        .await
        .map(|_| ())
        .map_err(short);
    let wrote = write.is_ok();
    steps.push(step(VerifyStepKind::Write, write));
    if !wrote {
        steps.push(not_run(VerifyStepKind::Read, "write failed"));
        steps.push(not_run(VerifyStepKind::Delete, "no test object created"));
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
    let del = remote.delete(&key).await.map_err(short);
    steps.push(step(VerifyStepKind::Delete, del));
    VerifyResult::from_steps(steps, now)
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_errors_read_as_their_s3_code() {
        let e = r#"Generic S3 error: Error performing PUT http://x/y in 1ms - Server returned non-2xx status code: 403 Forbidden: <?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"#;
        assert_eq!(super::short(e), "AccessDenied · Access Denied");
        assert_eq!(super::short("connection refused"), "connection refused");
    }
}
