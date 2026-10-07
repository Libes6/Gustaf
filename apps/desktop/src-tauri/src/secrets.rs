//! API keys in the OS credential store, under the service name [`SERVICE`] (the bundle identifier).
//! Builds from before the rename stored them under [`OLD_SERVICE`]: a key missing under the new name is read there once,
//! written under the new name and, only after that write succeeded, removed from the old one.
use crate::legacy::{IDENTIFIER as SERVICE, OLD_IDENTIFIER as OLD_SERVICE};

#[cfg(target_os = "macos")]
mod backend {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// errSecItemNotFound (Security.framework).
    const ITEM_NOT_FOUND: i32 = -25300;

    pub fn set(service: &str, id: &str, value: &str) -> Result<(), String> {
        set_generic_password(service, id, value.as_bytes()).map_err(|e| e.to_string())
    }

    /// Ok(None) when there is no such item; Err when the read failed (e.g. the user denied Keychain access).
    pub fn get(service: &str, id: &str) -> Result<Option<String>, String> {
        match get_generic_password(service, id) {
            Ok(b) => Ok(String::from_utf8(b).ok()),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(service: &str, id: &str) {
        let _ = delete_generic_password(service, id);
    }
}

/// Windows (Credential Manager) and Linux (Secret Service: GNOME Keyring / KWallet) through the `keyring` crate.
#[cfg(not(target_os = "macos"))]
mod backend {
    fn entry(service: &str, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, id).map_err(|e| e.to_string())
    }

    pub fn set(service: &str, id: &str, value: &str) -> Result<(), String> {
        entry(service, id)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn get(service: &str, id: &str) -> Result<Option<String>, String> {
        match entry(service, id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(service: &str, id: &str) {
        if let Ok(e) = entry(service, id) {
            let _ = e.delete_credential();
        }
    }
}

/// The secret store seen by the rest of the app: `get`/`set`/`delete` under one service name.
trait Store {
    fn get(&self, service: &str, id: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str, id: &str);
}

struct Os;
impl Store for Os {
    fn get(&self, service: &str, id: &str) -> Result<Option<String>, String> {
        backend::get(service, id)
    }
    fn set(&self, service: &str, id: &str, value: &str) -> Result<(), String> {
        backend::set(service, id, value)
    }
    fn delete(&self, service: &str, id: &str) {
        backend::delete(service, id)
    }
}

/// Reads under [`SERVICE`]; a missing item is looked up under [`OLD_SERVICE`] and moved over (the old entry is deleted
/// only after the new one was written; when the write fails the value is still returned and the old entry kept).
fn get_migrating(store: &impl Store, id: &str) -> Result<Option<String>, String> {
    if let Some(v) = store.get(SERVICE, id)? {
        return Ok(Some(v));
    }
    let Some(v) = store.get(OLD_SERVICE, id)? else {
        return Ok(None);
    };
    match store.set(SERVICE, id, &v) {
        Ok(()) => store.delete(OLD_SERVICE, id),
        Err(e) => {
            eprintln!("gustaf migration: cannot move secret {id} to the new keychain service: {e}")
        }
    }
    Ok(Some(v))
}

/// Deletes under both names, so a removed key does not come back from the old service.
fn delete_everywhere(store: &impl Store, id: &str) {
    store.delete(SERVICE, id);
    store.delete(OLD_SERVICE, id);
}

/// Values read or written in this run. The OS may ask the user before a Keychain read (macOS does, again after every
/// re-signed build), so each secret is read from the Keychain at most once per run and then served from memory.
/// Only successful reads are kept: a missing item or a denied read is tried again next time.
#[derive(Default)]
struct Cache(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl Cache {
    fn get(
        &self,
        id: &str,
        read: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        if let Some(v) = self.0.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return Ok(Some(v.clone()));
        }
        let value = read(id)?;
        if let Some(v) = &value {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_string(), v.clone());
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
    cache().get(id, |id| get_migrating(&Os, id)).ok().flatten()
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    cache().put(&id, None);
    Os.set(SERVICE, &id, &value)?;
    cache().put(&id, Some(&value));
    Ok(())
}

/// `null` when there is no such item; an error when the read failed, so a denied prompt is not taken for "no key".
#[tauri::command]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    cache().get(&id, |id| get_migrating(&Os, id))
}

#[tauri::command]
pub fn secret_delete(id: String) {
    cache().put(&id, None);
    delete_everywhere(&Os, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// In-memory store; `fail_set` makes every write fail.
    #[derive(Default)]
    struct Mem {
        items: RefCell<HashMap<(String, String), String>>,
        fail_set: bool,
    }
    impl Mem {
        fn with(service: &str, id: &str, v: &str) -> Self {
            let m = Mem::default();
            m.items
                .borrow_mut()
                .insert((service.into(), id.into()), v.into());
            m
        }
        fn has(&self, service: &str, id: &str) -> Option<String> {
            self.items
                .borrow()
                .get(&(service.into(), id.into()))
                .cloned()
        }
    }
    impl Store for Mem {
        fn get(&self, service: &str, id: &str) -> Result<Option<String>, String> {
            Ok(self.has(service, id))
        }
        fn set(&self, service: &str, id: &str, value: &str) -> Result<(), String> {
            if self.fail_set {
                return Err("denied".into());
            }
            self.items
                .borrow_mut()
                .insert((service.into(), id.into()), value.into());
            Ok(())
        }
        fn delete(&self, service: &str, id: &str) {
            self.items.borrow_mut().remove(&(service.into(), id.into()));
        }
    }

    #[test]
    fn moves_a_key_from_the_old_service_on_first_read() {
        let store = Mem::with(OLD_SERVICE, "provider:a", "k1");
        assert_eq!(
            get_migrating(&store, "provider:a").unwrap().as_deref(),
            Some("k1")
        );
        assert_eq!(store.has(SERVICE, "provider:a").as_deref(), Some("k1"));
        assert_eq!(store.has(OLD_SERVICE, "provider:a"), None);
    }

    #[test]
    fn the_new_service_wins_and_the_old_entry_is_not_touched() {
        let store = Mem::with(SERVICE, "provider:a", "new");
        store
            .items
            .borrow_mut()
            .insert((OLD_SERVICE.into(), "provider:a".into()), "old".into());
        assert_eq!(
            get_migrating(&store, "provider:a").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(store.has(OLD_SERVICE, "provider:a").as_deref(), Some("old"));
    }

    #[test]
    fn a_failed_write_keeps_the_old_entry() {
        let store = Mem {
            fail_set: true,
            ..Mem::with(OLD_SERVICE, "provider:a", "k1")
        };
        assert_eq!(
            get_migrating(&store, "provider:a").unwrap().as_deref(),
            Some("k1")
        );
        assert_eq!(store.has(OLD_SERVICE, "provider:a").as_deref(), Some("k1"));
        assert_eq!(store.has(SERVICE, "provider:a"), None);
    }

    #[test]
    fn missing_everywhere_is_none_and_delete_clears_both() {
        let store = Mem::with(OLD_SERVICE, "provider:a", "k1");
        assert_eq!(get_migrating(&store, "provider:b").unwrap(), None);
        store.set(SERVICE, "provider:a", "k2").unwrap();
        delete_everywhere(&store, "provider:a");
        assert_eq!(get_migrating(&store, "provider:a").unwrap(), None);
    }

    #[test]
    fn reads_the_keychain_once_and_follows_writes() {
        let cache = Cache::default();
        let reads = Cell::new(0);
        let backend = |_: &str| {
            reads.set(reads.get() + 1);
            Ok(Some("k1".to_string()))
        };
        assert_eq!(
            cache.get("provider:a", backend).unwrap().as_deref(),
            Some("k1")
        );
        assert_eq!(
            cache.get("provider:a", backend).unwrap().as_deref(),
            Some("k1")
        );
        assert_eq!(reads.get(), 1);
        cache.put("provider:a", Some("k2"));
        assert_eq!(
            cache.get("provider:a", backend).unwrap().as_deref(),
            Some("k2")
        );
        assert_eq!(reads.get(), 1);
        cache.put("provider:a", None);
        assert_eq!(
            cache.get("provider:a", backend).unwrap().as_deref(),
            Some("k1")
        );
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
        assert_eq!(
            cache
                .get("y", |_| Ok(Some("v".to_string())))
                .unwrap()
                .as_deref(),
            Some("v")
        );
    }
}
