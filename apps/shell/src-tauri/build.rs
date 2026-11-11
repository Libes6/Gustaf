fn main() {
    // Naming the command here gives it a permission the capability file can grant.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["dropped_paths"])),
    )
    .expect("failed to run tauri-build");
}
