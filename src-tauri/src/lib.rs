mod computer;
mod cursor_import;
mod db;
mod git;
mod review;
mod secrets;
mod tools;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db(Mutex::new(db::open(&dir.join("app.db"))?)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_select,
            db::db_execute,
            db::search_messages,
            db::search_models,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            cursor_import::cursor_scan,
            cursor_import::cursor_messages,
            tools::fs_read,
            tools::fs_list,
            tools::fs_files,
            tools::fs_search,
            tools::fs_edit,
            tools::fs_write,
            tools::read_rules,
            tools::read_home_file,
            tools::run_command,
            git::git,
            review::review_prepare,
            review::review_list,
            review::review_diff,
            review::review_decide,
            review::review_finish,
            computer::cu_execute,
            computer::cu_save_shot,
            computer::cu_permissions,
            computer::cu_screen_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
