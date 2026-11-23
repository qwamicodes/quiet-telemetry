//! Destination secrets at rest: ChaCha20-Poly1305 with a 32-byte key in
//! `<data dir>/secret.key` (created 0600 on first use). Stored as
//! `nonce (12 bytes) || ciphertext`. The API never returns a secret.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use std::path::Path;

pub struct SecretBox {
    cipher: ChaCha20Poly1305,
}

impl SecretBox {
    /// Read the key file, or create it (0600) when missing.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let key = match std::fs::read(path) {
            Ok(k) if k.len() == 32 => k,
            Ok(_) => anyhow::bail!("{} is not a 32-byte key", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut k = vec![0u8; 32];
                rand::thread_rng().fill_bytes(&mut k);
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                write_private(path, &k)?;
                k
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self::from_key(&key))
    }

    /// A key that lives only in memory (tests, `--store memory`).
    pub fn ephemeral() -> Self {
        let mut k = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut k);
        Self::from_key(&k)
    }

    fn from_key(k: &[u8]) -> Self {
        let mut a = [0u8; 32];
        a.copy_from_slice(k);
        SecretBox {
            cipher: ChaCha20Poly1305::new(&Key::from(a)),
        }
    }

    pub fn seal(&self, plain: &str) -> anyhow::Result<Vec<u8>> {
        let mut n = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut n);
        let ct = self
            .cipher
            .encrypt(&Nonce::from(n), plain.as_bytes())
            .map_err(|_| anyhow::anyhow!("encrypting a secret failed"))?;
        let mut out = n.to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn open_sealed(&self, sealed: &[u8]) -> anyhow::Result<String> {
        if sealed.len() < 12 + 16 {
            anyhow::bail!("sealed secret is too short");
        }
        let mut n = [0u8; 12];
        n.copy_from_slice(&sealed[..12]);
        let pt = self
            .cipher
            .decrypt(&Nonce::from(n), &sealed[12..])
            .map_err(|_| anyhow::anyhow!("secret can't be decrypted (was secret.key replaced?)"))?;
        Ok(String::from_utf8(pt)?)
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    std::fs::write(path, bytes)?;
    Ok(())
}

/// `AKIA••••7Q2X`: enough to recognise a key, never enough to use it.
pub fn preview(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= 8 {
        return "••••".into();
    }
    let head: String = c[..4].iter().collect();
    let tail: String = c[c.len() - 4..].iter().collect();
    format!("{head}••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_with_the_key_file_only() {
        let dir = std::env::temp_dir().join(format!("quiet-secret-{}", rand::random::<u32>()));
        let path = dir.join("secret.key");
        let b = SecretBox::open(&path).unwrap();
        let sealed = b.seal("s3cr3t-value").unwrap();
        assert!(!sealed.windows(6).any(|w| w == b"s3cr3t"));
        // Same key file → same box.
        assert_eq!(
            SecretBox::open(&path)
                .unwrap()
                .open_sealed(&sealed)
                .unwrap(),
            "s3cr3t-value"
        );
        // Another key can't read it.
        assert!(SecretBox::ephemeral().open_sealed(&sealed).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(preview("AKIAIOSFODNN7EXAMPLE"), "AKIA••••MPLE");
        assert_eq!(preview("short"), "••••");
    }
}
