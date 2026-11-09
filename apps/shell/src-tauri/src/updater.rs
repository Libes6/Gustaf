//! The GitHub Releases feed is always named here. The native updater stays off
//! until a release build supplies a non-empty minisign public key, the same
//! rule as the previous Gustaf app.

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

pub fn initialize(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
    use super::configured;

    #[test]
    fn only_a_signed_https_feed_enables_updates() {
        let mut plugins = std::collections::HashMap::new();
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"", "endpoints":["https://github.com/Libes6/Gustaf/releases/latest/download/latest.json"]}),
        );
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"public", "endpoints":["https://github.com/Libes6/Gustaf/releases/latest/download/latest.json"]}),
        );
        assert!(configured(&plugins));
    }
}
