//! Keep the catalog (and the cloud account, see account.rs) encrypted on disk and only
//! a small encryption key in the OS credential store. Catalogs can exceed Windows
//! Credential Manager's limit.

use std::{fs, path::Path, sync::Mutex};

use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Key, Nonce,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct CatalogStore(Mutex<()>);

#[derive(Serialize, Deserialize)]
struct EncryptedCatalog {
    version: u8,
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

fn encrypt(catalog: &str, key: &Key) -> Result<Vec<u8>, String> {
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = ChaCha20Poly1305::new(key)
        .encrypt(&nonce, catalog.as_bytes())
        .map_err(|_| "Cannot encrypt saved data")?;
    serde_json::to_vec(&EncryptedCatalog {
        version: 1,
        nonce: nonce.into(),
        ciphertext,
    })
    .map_err(|_| "Cannot encode saved data".to_owned())
}

fn decrypt(raw: &[u8], key: &Key) -> Result<String, String> {
    let saved: EncryptedCatalog =
        serde_json::from_slice(raw).map_err(|_| "Cannot decode encrypted saved data")?;
    if saved.version != 1 {
        return Err("Unsupported saved data encryption version".to_owned());
    }
    let plaintext = ChaCha20Poly1305::new(key)
        .decrypt(Nonce::from_slice(&saved.nonce), saved.ciphertext.as_ref())
        .map_err(|_| "Cannot decrypt saved data")?;
    String::from_utf8(plaintext).map_err(|_| "Invalid saved data encoding".to_owned())
}

fn read_key(entry: &keyring::Entry) -> Result<Option<Key>, String> {
    match entry.get_secret() {
        Ok(secret) => {
            if secret.len() != 32 {
                return Err("Invalid storage key".to_owned());
            }
            Ok(Some(*Key::from_slice(&secret)))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        // Do not include credential data in errors sent to the renderer/logs.
        Err(_) => Err("Cannot access the system keyring".to_owned()),
    }
}

pub(crate) fn read_catalog(path: &Path, entry: &keyring::Entry) -> Result<Option<String>, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read saved data: {error}")),
    };
    let key = read_key(entry)?.ok_or("The storage key is missing from the system keyring")?;
    decrypt(&raw, &key).map(Some)
}

pub(crate) fn write_catalog(
    path: &Path,
    entry: &keyring::Entry,
    catalog: &str,
) -> Result<(), String> {
    let key = match read_key(entry)? {
        Some(key) => key,
        None => {
            // Never replace the key of an existing catalog: that would destroy it.
            if path.try_exists().map_err(|error| error.to_string())? {
                return Err("The storage key is missing from the system keyring".to_owned());
            }
            let key = ChaCha20Poly1305::generate_key(&mut OsRng);
            entry
                .set_secret(key.as_slice())
                .map_err(|_| "Cannot save the storage key in the system keyring")?;
            key
        }
    };
    let raw = encrypt(catalog, &key)?;
    fs::create_dir_all(path.parent().ok_or("Missing storage directory")?)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, raw).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

// A second Gustaf process must not race key creation or replace the same temp file.
pub(crate) fn lock_catalog(path: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(path.parent().ok_or("Missing storage directory")?)
        .map_err(|error| error.to_string())?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| error.to_string())?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

// Native credential dialogs and Secret Service calls must not block the UI thread.
#[tauri::command]
pub(crate) async fn read_connection_catalog(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CatalogStore>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "Connection storage is unavailable")?;
        let path = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("connections.encrypted.json");
        let _file_lock = lock_catalog(&path)?;
        let entry = keyring::Entry::new(&app.config().identifier, "connection-catalog-key")
            .map_err(|_| "Cannot open the system keyring for connections")?;
        read_catalog(&path, &entry)
    })
    .await
    .map_err(|_| "Connection storage task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn write_connection_catalog(
    app: tauri::AppHandle,
    catalog: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CatalogStore>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "Connection storage is unavailable")?;
        let path = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("connections.encrypted.json");
        let _file_lock = lock_catalog(&path)?;
        let entry = keyring::Entry::new(&app.config().identifier, "connection-catalog-key")
            .map_err(|_| "Cannot open the system keyring for connections")?;
        write_catalog(&path, &entry, &catalog)
    })
    .await
    .map_err(|_| "Connection storage task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_large_catalogs_and_rejects_tampering_or_another_key() {
        let key = ChaCha20Poly1305::generate_key(&mut OsRng);
        let catalog = "secret-bearer-token".repeat(1000);
        let raw = encrypt(&catalog, &key).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-bearer-token"));
        assert_eq!(decrypt(&raw, &key).unwrap(), catalog);
        assert_ne!(encrypt(&catalog, &key).unwrap(), raw);
        let other_key = ChaCha20Poly1305::generate_key(&mut OsRng);
        assert!(decrypt(&raw, &other_key).is_err());
        let mut saved: EncryptedCatalog = serde_json::from_slice(&raw).unwrap();
        saved.ciphertext[0] ^= 1;
        assert!(decrypt(&serde_json::to_vec(&saved).unwrap(), &key).is_err());
        saved.version = 2;
        assert!(decrypt(&serde_json::to_vec(&saved).unwrap(), &key).is_err());
    }

    #[test]
    fn persists_catalog_and_refuses_to_replace_a_missing_key() {
        // A per-entry mock avoids changing the process-global credential backend.
        let entry = keyring::Entry::new_with_credential(
            keyring::mock::default_credential_builder()
                .build(None, "test", "catalog")
                .unwrap(),
        );
        let dir = std::env::temp_dir().join(format!("gustaf-catalog-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("catalog.json");
        assert_eq!(read_catalog(&path, &entry).unwrap(), None);
        write_catalog(&path, &entry, "first").unwrap();
        write_catalog(&path, &entry, "second").unwrap();
        assert_eq!(
            read_catalog(&path, &entry).unwrap().as_deref(),
            Some("second")
        );
        entry.delete_credential().unwrap();
        let previous = fs::read(&path).unwrap();
        assert!(read_catalog(&path, &entry).is_err());
        assert!(write_catalog(&path, &entry, "replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), previous);
        fs::remove_dir_all(dir).unwrap();
    }
}
