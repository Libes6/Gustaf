mod antigravity_profile;
mod antigravity_runtime;
mod attachments;
mod codex_agents;
mod computer;
mod cursor_accounts;
mod cursor_import;
mod db;
mod device_bridge;
mod git;
mod git_branches;
mod git_publish;
mod hook_exec;
mod hunks;
mod import_sources;
mod knowledge;
mod legacy;
mod lsp;
mod mcp;
mod merge_queue;
mod mobile_server;
mod oauth;
mod pr_watch;
mod preview;
mod proc_ledger;
mod proc_tree;
mod quick_ask;
mod rawlog;
mod review;
mod scratch;
mod secrets;
mod semantic;
mod shell;
mod skills;
mod terminal;
mod tools;
mod updater;
mod web_tools;
mod webhooks;
mod worktree;

pub use knowledge::{extract_pdf_with_exe, pdf_child_main};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any window or the database: move the data of builds from before the rename (see legacy.rs).
    legacy::migrate_app_dirs();
    tauri::Builder::default()
        .manage(terminal::Terminals::default())
        .manage(preview::Previews::default())
        .manage(mobile_server::MobileServer::default())
        .manage(device_bridge::DeviceBridge::default())
        .manage(quick_ask::QuickAsk::default())
        .manage(webhooks::Webhooks::default())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                quick_ask::on_main_destroyed(window.app_handle());
                // The UI that controlled the agent processes is gone: stop them (the exit path repeats this, harmlessly).
                proc_ledger::shutdown(window.app_handle());
            }
        })
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
            proc_ledger::init(app, &dir);
            mcp::init(app);
            mobile_server::init(app);
            antigravity_runtime::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scratch::scratch_dir,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            web_tools::web_fetch,
            web_tools::web_search,
            semantic::semantic_build,
            semantic::semantic_query,
            semantic::semantic_clear,
            knowledge::knowledge_list,
            knowledge::knowledge_create,
            knowledge::knowledge_rename,
            knowledge::knowledge_delete,
            knowledge::knowledge_add_source,
            knowledge::knowledge_remove_source,
            knowledge::knowledge_set_include,
            knowledge::knowledge_set_config,
            knowledge::knowledge_estimate,
            knowledge::knowledge_reindex,
            knowledge::knowledge_cancel,
            knowledge::knowledge_search,
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
            antigravity_profile::antigravity_profile_prepare,
            antigravity_profile::antigravity_profile_remove,
            antigravity_runtime::antigravity_runtime_status,
            antigravity_runtime::antigravity_runtime_resolve,
            antigravity_runtime::antigravity_runtime_install,
            antigravity_runtime::antigravity_runtime_cancel,
            antigravity_runtime::antigravity_runtime_remove,
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
            proc_tree::process_signal_tree,
            proc_ledger::process_ledger_add,
            proc_ledger::process_ledger_remove,
            proc_tree::process_snapshot,
            proc_tree::app_logs_dir,
            git::git,
            git::git_status,
            git::git_commit_context,
            git::git_commit,
            git_branches::git_branches,
            git_branches::git_switch_branch,
            git_publish::git_publish_info,
            git_publish::git_push,
            git_publish::git_create_branch,
            git_publish::git_pr_context,
            git_publish::gh_status,
            git_publish::git_create_pr,
            pr_watch::gh_pr_view,
            webhooks::webhook_serve,
            webhooks::webhook_stop,
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
            rawlog::raw_log_prune,
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
            mobile_server::mobile_server_start,
            mobile_server::mobile_server_stop,
            device_bridge::device_bridge_prepare,
            device_bridge::device_bridge_register,
            device_bridge::device_bridge_reply,
            mobile_server::mobile_server_status,
            mobile_server::mobile_pairing_start,
            mobile_server::mobile_pairing_cancel,
            mobile_server::mobile_devices,
            mobile_server::mobile_device_revoke,
            mobile_server::mobile_report_status,
            mobile_server::mobile_command_reply,
            quick_ask::quick_ask_configure,
            quick_ask::quick_ask_show,
            quick_ask::quick_ask_hide,
            quick_ask::quick_ask_toggle,
            quick_ask::quick_ask_ready,
            quick_ask::quick_ask_resize,
            quick_ask::quick_ask_open_main,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // MCP servers are child processes: never leave them running after the app quits.
            if let tauri::RunEvent::Exit = event {
                // Agent CLIs (and what they started) first: SIGTERM, a short grace, then SIGKILL.
                proc_ledger::shutdown(app);
                mcp::shutdown(app);
                terminal::shutdown(app);
                preview::shutdown(app);
                mobile_server::shutdown(app);
            }
        });
}
