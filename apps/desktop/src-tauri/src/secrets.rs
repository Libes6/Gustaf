const SERVICE: &str = "com.maksimkulakov.mcode";

#[cfg(target_os = "macos")]
mod backend {
    use super::SERVICE;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// errSecItemNotFound (Security.framework).
    const ITEM_NOT_FOUND: i32 = -25300;

    pub fn set(id: &str, value: &str) -> Result<(), String> {
        set_generic_password(SERVICE, id, value.as_bytes()).map_err(|e| e.to_string())
    }

    /// Ok(None) when there is no such item; Err when the read failed (e.g. the user denied Keychain access).
    pub fn get(id: &str) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE, id) {
            Ok(b) => Ok(String::from_utf8(b).ok()),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(id: &str) {
        let _ = delete_generic_password(SERVICE, id);
    }
}

/// Windows (Credential Manager) and Linux (Secret Service: GNOME Keyring / KWallet) through the `keyring` crate.
#[cfg(not(target_os = "macos"))]
mod backend {
    use super::SERVICE;

    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
    }

    pub fn set(id: &str, value: &str) -> Result<(), String> {
        entry(id)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn get(id: &str) -> Result<Option<String>, String> {
        match entry(id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(id: &str) {
        if let Ok(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

/// Values read or written in this run. The OS may ask the user before a Keychain read (macOS does, again after every
/// re-signed build), so each secret is read from the Keychain at most once per run and then served from memory.
/// Only successful reads are kept: a missing item or a denied read is tried again next time.
#[derive(Default)]
struct Cache(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl Cache {
    fn get(&self, id: &str, read: impl FnOnce(&str) -> Result<Option<String>, String>) -> Result<Option<String>, String> {
        if let Some(v) = self.0.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return Ok(Some(v.clone()));
        }
        let value = read(id)?;
        if let Some(v) = &value {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), v.clone());
        }
        Ok(value)
    }

    fn put(&self, id: &str, value: Option<&str>) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match value {
            Some(v) => map.insert(id.to_string(), v.to_string()),
            None => map.remove(id),
        };
    }
}

fn cache() -> &'static Cache {
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Cache::default)
}

/// For Rust callers (web search, embeddings): the value, or None when it is missing or could not be read.
pub fn read(id: &str) -> Option<String> {
    cache().get(id, backend::get).ok().flatten()
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    cache().put(&id, None);
    backend::set(&id, &value)?;
    cache().put(&id, Some(&value));
    Ok(())
}

/// `null` when there is no such item; an error when the read failed, so a denied prompt is not taken for "no key".
#[tauri::command]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    cache().get(&id, backend::get)
}

#[tauri::command]
pub fn secret_delete(id: String) {
    cache().put(&id, None);
    backend::delete(&id)
}

#[cfg(test)]
mod tests {
    use super::Cache;
    use std::cell::Cell;

    #[test]
    fn reads_the_keychain_once_and_follows_writes() {
        let cache = Cache::default();
        let reads = Cell::new(0);
        let backend = |_: &str| {
            reads.set(reads.get() + 1);
            Ok(Some("k1".to_string()))
        };
        assert_eq!(cache.get("provider:a", backend).unwrap().as_deref(), Some("k1"));
        assert_eq!(cache.get("provider:a", backend).unwrap().as_deref(), Some("k1"));
        assert_eq!(reads.get(), 1);
        cache.put("provider:a", Some("k2"));
        assert_eq!(cache.get("provider:a", backend).unwrap().as_deref(), Some("k2"));
        assert_eq!(reads.get(), 1);
        cache.put("provider:a", None);
        assert_eq!(cache.get("provider:a", backend).unwrap().as_deref(), Some("k1"));
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn missing_and_denied_reads_are_not_cached() {
        let cache = Cache::default();
        let reads = Cell::new(0);
        let missing = |_: &str| {
            reads.set(reads.get() + 1);
            Ok(None)
        };
        assert_eq!(cache.get("x", missing).unwrap(), None);
        assert_eq!(cache.get("x", missing).unwrap(), None);
        assert_eq!(reads.get(), 2);
        assert!(cache.get("y", |_| Err("denied".to_string())).is_err());
        assert_eq!(cache.get("y", |_| Ok(Some("v".to_string()))).unwrap().as_deref(), Some("v"));
    }
}
