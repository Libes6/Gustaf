mod attachments;
mod computer;
mod cursor_accounts;
mod cursor_import;
mod db;
mod git;
mod hunks;
mod import_sources;
mod mcp;
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
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db(Mutex::new(db::open(&dir.join("app.db"))?)));
            mcp::init(app);
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
            cursor_accounts::cursor_profile_create,
            cursor_accounts::cursor_profile_dir,
            cursor_accounts::cursor_profile_remove,
            cursor_accounts::cursor_profile_status,
            cursor_import::cursor_scan,
            cursor_import::cursor_messages,
            import_sources::import_scan,
            import_sources::import_read_session,
            import_sources::import_chatgpt_scan,
            import_sources::import_chatgpt_read,
            tools::fs_read,
            tools::fs_list,
            tools::fs_files,
            tools::fs_search,
            tools::fs_edit,
            tools::fs_write,
            tools::read_instructions,
            tools::read_home_file,
            tools::run_command,
            git::git,
            git::git_status,
            git::git_commit_context,
            git::git_commit,
            review::review_prepare,
            review::review_run,
            review::review_list,
            review::review_diff,
            review::review_decide,
            review::review_hunks,
            review::review_decide_hunks,
            review::review_finish,
            computer::cu_execute,
            computer::cu_permissions,
            computer::cu_screen_size,
            attachments::attachments_save,
            attachments::attachments_clear,
            mcp::mcp_start,
            mcp::mcp_request,
            mcp::mcp_notify,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_logs,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // MCP servers are child processes: never leave them running after the app quits.
            if let tauri::RunEvent::Exit = event {
                mcp::shutdown(app);
            }
        });
}
