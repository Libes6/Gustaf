use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

const SERVICE: &str = "com.maksimkulakov.mcode";

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    set_generic_password(SERVICE, &id, value.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(id: String) -> Option<String> {
    get_generic_password(SERVICE, &id).ok().and_then(|b| String::from_utf8(b).ok())
}

#[tauri::command]
pub fn secret_delete(id: String) {
    let _ = delete_generic_password(SERVICE, &id);
}
