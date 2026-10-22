//! `quiet pipe --name <source>`: stdin → `POST /ingest/ndjson`.
//!
//! `bun run start | quiet pipe --name legivent-api --token qi_…` sends every
//! line (JSON or plain text) to the server and echoes it to stdout, so the
//! terminal looks the same. Lines are batched (up to 500 lines or 200 ms).
//!
//! Plain `http://` only, by design: no TLS stack in the binary for this. For
//! a server behind https, use curl or a shipper (Vector, Fluent Bit).

use crate::cli::PipeArgs;
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

const BATCH_LINES: usize = 500;
const BATCH_WAIT: Duration = Duration::from_millis(200);

/// Where to POST, from `http://host[:port][/prefix]`.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub path: String,
}

pub fn target(url: &str) -> Result<Target, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| match url.starts_with("https://") {
            true => "quiet pipe speaks plain http only; for https use curl or Vector/Fluent Bit (see the Connect a source screen)".to_string(),
            false => format!("`{url}`: expected http://host:port"),
        })?;
    let (authority, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| format!("`{url}`: bad port"))?,
        ),
        None => (authority.to_string(), 80),
    };
    if host.is_empty() {
        return Err(format!("`{url}`: missing host"));
    }
    let prefix = prefix.trim_end_matches('/');
    let path = if prefix.is_empty() {
        "/ingest/ndjson".to_string()
    } else {
        format!("/{prefix}/ingest/ndjson")
    };
    Ok(Target { host, port, path })
}

/// One HTTP/1.1 POST; returns the status code and the body.
fn post(
    t: &Target,
    source: &str,
    token: Option<&str>,
    body: &[u8],
) -> std::io::Result<(u16, String)> {
    let mut s = TcpStream::connect((t.host.as_str(), t.port))?;
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    s.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut head = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nX-Quiet-Source: {}\r\nConnection: close\r\n",
        t.path,
        t.host,
        t.port,
        body.len(),
        source
    );
    if let Some(tok) = token {
        head.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    head.push_str("\r\n");
    let mut req = head.into_bytes();
    req.extend_from_slice(body);
    s.write_all(&req)?;
    let mut res = String::new();
    s.read_to_string(&mut res)?;
    let status = res
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = res
        .split_once("\r\n\r\n")
        .map(|x| x.1)
        .unwrap_or("")
        .to_string();
    Ok((status, body))
}

/// Exit code: 0 at end of input, 1 when the server refuses the token or is unreachable.
pub fn run(args: PipeArgs) -> i32 {
    let t = match target(&args.url) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("quiet pipe: {e}");
            return 2;
        }
    };
    if args.name.trim().is_empty() || args.name.chars().any(char::is_control) {
        eprintln!("quiet pipe: --name must be a plain source name");
        return 2;
    }
    let (tx, rx) = mpsc::sync_channel::<String>(10_000);
    let silent = args.silent;
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut out = std::io::stdout();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if !silent {
                let _ = writeln!(out, "{line}");
            }
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut code = 0;
    let mut batch: Vec<String> = Vec::new();
    loop {
        let mut done = false;
        match rx.recv_timeout(BATCH_WAIT) {
            Ok(line) => batch.push(line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => done = true,
        }
        // Whatever else is already queued goes in the same request.
        while !done && batch.len() < BATCH_LINES {
            match rx.try_recv() {
                Ok(line) => batch.push(line),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => done = true,
            }
        }
        if !batch.is_empty() {
            let body = batch.join("\n");
            let mut sent = false;
            for attempt in 0..3u64 {
                match post(&t, &args.name, args.token.as_deref(), body.as_bytes()) {
                    Ok((s, _)) if (200..300).contains(&s) => {
                        sent = true;
                        break;
                    }
                    Ok((401, b)) => {
                        eprintln!("quiet pipe: the server refused the token: {}", b.trim());
                        return 1;
                    }
                    Ok((429, _)) | Err(_) if attempt < 2 => {
                        std::thread::sleep(Duration::from_secs(1 + attempt))
                    }
                    Ok((s, b)) => {
                        eprintln!("quiet pipe: {s} from the server: {}", b.trim());
                        break;
                    }
                    Err(e) => {
                        eprintln!("quiet pipe: can't reach {}:{}: {e}", t.host, t.port);
                        code = 1;
                        break;
                    }
                }
            }
            if !sent {
                eprintln!("quiet pipe: dropped {} lines", batch.len());
            }
            batch.clear();
        }
        if done {
            return code;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(
            target("http://127.0.0.1:7070").unwrap(),
            Target {
                host: "127.0.0.1".into(),
                port: 7070,
                path: "/ingest/ndjson".into()
            }
        );
        assert_eq!(
            target("http://quiet.lan/logs/").unwrap(),
            Target {
                host: "quiet.lan".into(),
                port: 80,
                path: "/logs/ingest/ndjson".into()
            }
        );
        assert!(target("https://quiet.legivent.com")
            .unwrap_err()
            .contains("plain http"));
        assert!(target("quiet:7070").is_err());
        assert!(target("http://:7070").is_err());
    }

    #[test]
    fn posts_a_batch_with_source_and_token() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            while !req.ends_with(b"a\nb") {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
            }
            s.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            String::from_utf8_lossy(&req).to_string()
        });
        let t = target(&format!("http://127.0.0.1:{port}")).unwrap();
        let (status, _) = post(&t, "api", Some("qi_x"), b"a\nb").unwrap();
        assert_eq!(status, 202);
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /ingest/ndjson HTTP/1.1"));
        assert!(req.contains("X-Quiet-Source: api\r\n"));
        assert!(req.contains("Authorization: Bearer qi_x\r\n"));
        assert!(req.ends_with("a\nb"));
    }
}
