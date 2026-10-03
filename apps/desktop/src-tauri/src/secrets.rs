const SERVICE: &str = "com.maksimkulakov.mcode";

#[cfg(target_os = "macos")]
mod backend {
    use super::SERVICE;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    pub fn set(id: &str, value: &str) -> Result<(), String> {
        set_generic_password(SERVICE, id, value.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn get(id: &str) -> Option<String> {
        get_generic_password(SERVICE, id).ok().and_then(|b| String::from_utf8(b).ok())
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

    pub fn get(id: &str) -> Option<String> {
        entry(id).ok()?.get_password().ok()
    }

    pub fn delete(id: &str) {
        if let Ok(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    backend::set(&id, &value)
}

#[tauri::command]
pub fn secret_get(id: String) -> Option<String> {
    backend::get(&id)
}

#[tauri::command]
pub fn secret_delete(id: String) {
    backend::delete(&id)
}
