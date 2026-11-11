fn main() {
    // Naming a command here gives it a permission the capability file can grant.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "dropped_paths",
            "drag_window",
            "get_prevent_sleep",
            "set_prevent_sleep",
            "read_connection_catalog",
            "write_connection_catalog",
            "reveal_window",
            "window_fullscreen_state",
            "set_window_theme",
            "read_client_settings",
            "write_client_settings",
            "local_environment_bootstraps",
            "local_environment_bearer_token",
            "local_environment_enabled",
            "set_local_environment_enabled",
            "server_exposure_state",
            "set_server_exposure_mode",
            "set_tailscale_serve_enabled",
            "advertised_endpoints",
            "client_platform",
            "app_branding",
            "update_state",
            "update_check",
            "update_download",
            "update_install",
        ]),
    ))
    .expect("failed to run tauri-build");
}
