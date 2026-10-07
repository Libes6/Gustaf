//! Only provisioned signed-update builds enable the native updater.
fn configured(plugins: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    let Some(config) = plugins.get("updater") else {
        return false;
    };
    let key = config.get("pubkey").and_then(|v| v.as_str()).unwrap_or("");
    let endpoints = config.get("endpoints").and_then(|v| v.as_array());
    !key.trim().is_empty()
        && endpoints.is_some_and(|xs| {
            !xs.is_empty()
                && xs.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|url| url.starts_with("https://") && url.len() > 8)
                })
        })
}
#[tauri::command]
pub fn updater_configured(app: tauri::AppHandle) -> bool {
    // This release feed supplies an AppImage for Linux, not a package-manager update.
    #[cfg(target_os = "linux")]
    if tauri::utils::platform::bundle_type() != Some(tauri::utils::config::BundleType::AppImage) {
        return false;
    }
    configured(&app.config().plugins.0)
}
pub fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if configured(&app.config().plugins.0) {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_signed_https_configuration_enables_updates() {
        let mut plugins = std::collections::HashMap::new();
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"", "endpoints":["https://updates.example.test"]}),
        );
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"public", "endpoints":["http://insecure.example.test"]}),
        );
        assert!(!configured(&plugins));
        plugins.insert("updater".into(), serde_json::json!({"pubkey":"public", "endpoints":["https://updates.example.test/{{target}}/{{arch}}/{{current_version}}"]}));
        assert!(configured(&plugins));
    }
}
