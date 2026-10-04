mod attachments;
mod codex_agents;
mod computer;
mod cursor_accounts;
mod cursor_import;
mod db;
mod git;
mod git_publish;
mod hook_exec;
mod hunks;
mod import_sources;
mod mcp;
mod oauth;
mod rawlog;
mod review;
mod secrets;
mod skills;
mod shell;
mod tools;
mod preview;
mod semantic;
mod lsp;
mod web_tools;
mod updater;
mod worktree;
mod merge_queue;
mod terminal;
mod proc_tree;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal::Terminals::default())
        .manage(preview::Previews::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            updater::initialize(app)?;
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db(Mutex::new(db::open(&dir.join("app.db"))?)));
            mcp::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            web_tools::web_fetch,
            web_tools::web_search,
            semantic::semantic_build,
            semantic::semantic_query,
            semantic::semantic_clear,
            lsp::lsp_detect,
            lsp::lsp_diagnostics,
            terminal::terminal_list,
            terminal::terminal_tail,
            preview::preview_start,
            preview::preview_status,
            preview::preview_stop,
            preview::preview_list,
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
            updater::updater_configured,
            skills::skills_scan,
            skills::skills_read,
            tools::fs_read,
            tools::fs_list,
            tools::fs_files,
            tools::fs_search,
            tools::fs_edit,
            tools::fs_write,
            tools::read_instructions,
            tools::read_home_file,
            tools::run_command,
            hook_exec::run_hook,
            proc_tree::process_kill_tree,
            git::git,
            git::git_status,
            git::git_commit_context,
            git::git_commit,
            git_publish::git_publish_info,
            git_publish::git_push,
            git_publish::git_create_branch,
            git_publish::git_pr_context,
            git_publish::gh_status,
            git_publish::git_create_pr,
            worktree::worktree_create,
            worktree::worktree_list,
            worktree::worktree_remove,
            worktree::worktree_prune,
            worktree::worktree_diff,
            worktree::worktree_link_dirs,
            merge_queue::conflicts_check,
            merge_queue::queue_enqueue,
            merge_queue::queue_status,
            merge_queue::queue_cancel,
            merge_queue::queue_resume,
            merge_queue::queue_run_next,
            merge_queue::queue_report_test,
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
            rawlog::raw_log_append,
            rawlog::raw_log_clear,
            rawlog::raw_log_info,
            codex_agents::codex_agents_scan,
            mcp::mcp_start,
            mcp::mcp_request,
            mcp::mcp_notify,
            mcp::mcp_cancel,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_logs,
            oauth::oauth_loopback_start,
            oauth::oauth_loopback_wait,
            oauth::oauth_loopback_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // MCP servers are child processes: never leave them running after the app quits.
            if let tauri::RunEvent::Exit = event {
                mcp::shutdown(app);
                terminal::shutdown(app);
                preview::shutdown(app);
            }
        });
}
