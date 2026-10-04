//! The server's self-signed certificate: generated once, stored in the app data directory, pinned by the phone through
//! its SHA-256 fingerprint (the QR carries it). There is no certificate authority involved, so the fingerprint IS the trust.

use super::pairing::hex;
use rcgen::{CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_rustls::rustls::{
    self,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};

pub struct Identity {
    pub cert_der: Vec<u8>,
    key_der: Vec<u8>,
    /// SHA-256 of the DER certificate, lowercase hex (64 characters).
    pub fingerprint: String,
}

const DIR: &str = "mobile-server";
const CERT_FILE: &str = "cert.der";
const KEY_FILE: &str = "key.der";

pub fn fingerprint(cert_der: &[u8]) -> String {
    hex(&Sha256::digest(cert_der))
}

fn civil_year(now: SystemTime) -> i32 {
    // Days since 1970-01-01 to a calendar year (Howard Hinnant's civil_from_days).
    let days = now.duration_since(UNIX_EPOCH).map(|d| (d.as_secs() / 86_400) as i64).unwrap_or(0);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2)) as i32
}

fn generate() -> Result<(Vec<u8>, Vec<u8>), String> {
    let key = KeyPair::generate().map_err(|e| format!("certificate key: {e}"))?;
    let mut params = CertificateParams::new(vec!["gustaf.local".to_string()]).map_err(|e| format!("certificate parameters: {e}"))?;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "Gustaf desktop");
    name.push(DnType::OrganizationName, "Gustaf");
    params.distinguished_name = name;
    params.is_ca = IsCa::ExplicitNoCa;
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    // Valid from last January (clock skew on a phone must not matter) for ten years: the certificate is pinned, so a
    // rotation would unpair every phone; it is regenerated only when the files are missing or unusable.
    let year = civil_year(SystemTime::now());
    params.not_before = rcgen::date_time_ymd(year - 1, 1, 1);
    params.not_after = rcgen::date_time_ymd(year + 10, 1, 1);
    let cert = params.self_signed(&key).map_err(|e| format!("certificate: {e}"))?;
    Ok((cert.der().to_vec(), key.serialize_der()))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn identity_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

/// Loads the stored certificate, or creates one. A stored pair that does not form a usable server configuration (damaged,
/// key and certificate not matching) is replaced.
pub fn load_or_create(data_dir: &Path) -> Result<Identity, String> {
    let dir = identity_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (cert_path, key_path) = (dir.join(CERT_FILE), dir.join(KEY_FILE));
    if let (Ok(cert_der), Ok(key_der)) = (fs::read(&cert_path), fs::read(&key_path)) {
        let id = Identity { fingerprint: fingerprint(&cert_der), cert_der, key_der };
        if server_config(&id).is_ok() {
            return Ok(id);
        }
    }
    let (cert_der, key_der) = generate()?;
    write_private(&key_path, &key_der)?;
    write_private(&cert_path, &cert_der)?;
    Ok(Identity { fingerprint: fingerprint(&cert_der), cert_der, key_der })
}

/// TLS 1.2/1.3 server configuration (ring provider), HTTP/1.1 only, no client certificates.
pub fn server_config(id: &Identity) -> Result<Arc<rustls::ServerConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cert = CertificateDer::from(id.cert_der.clone());
    let key = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(id.key_der.clone()));
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls versions: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|e| format!("tls certificate: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn year_conversion() {
        assert_eq!(civil_year(UNIX_EPOCH), 1970);
        assert_eq!(civil_year(UNIX_EPOCH + std::time::Duration::from_secs(1_767_225_600)), 2026); // 2026-01-01
        assert_eq!(civil_year(UNIX_EPOCH + std::time::Duration::from_secs(1_767_225_599)), 2025);
        assert_eq!(civil_year(UNIX_EPOCH + std::time::Duration::from_secs(951_782_400)), 2000); // 2000-02-29
    }

    #[test]
    fn the_certificate_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(dir.path()).unwrap();
        assert_eq!(a.fingerprint.len(), 64);
        assert!(a.fingerprint.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(a.fingerprint, fingerprint(&a.cert_der));
        let b = load_or_create(dir.path()).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint, "same certificate on the next start");
        assert!(server_config(&b).is_ok());
    }

    #[test]
    fn a_damaged_or_mismatched_pair_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(dir.path()).unwrap();
        let d = identity_dir(dir.path());
        fs::write(d.join(KEY_FILE), b"garbage").unwrap();
        let b = load_or_create(dir.path()).unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        // Key of another certificate.
        let other = tempfile::tempdir().unwrap();
        let c = load_or_create(other.path()).unwrap();
        fs::write(d.join(KEY_FILE), fs::read(identity_dir(other.path()).join(KEY_FILE)).unwrap()).unwrap();
        let e = load_or_create(dir.path()).unwrap();
        assert_ne!(e.fingerprint, c.fingerprint);
        assert_ne!(e.fingerprint, b.fingerprint);
    }

    #[cfg(unix)]
    #[test]
    fn the_private_key_is_readable_by_the_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        let mode = fs::metadata(identity_dir(dir.path()).join(KEY_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
