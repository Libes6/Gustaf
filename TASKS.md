# Tasks

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Priority: P1 (next) · P2 · P3.
Items were drafted from the README and code layout; verify against the code before starting.

## P0 — hardening and hygiene
- [x] **Remove panics and loose types**: replace non-test `unwrap()` in `db.rs`, `computer.rs`, `tools.rs` with error handling (poisoned Mutex must not brick the DB); drop `as any` in `providers/activities.ts` and `components/Markdown.tsx`.
- [x] **Validate `root` in `fs_files` / `fs_search`** the same way `resolve_in_root` does for read/list/edit.
- [ ] **Strict CSP** in `tauri.conf.json` that still allows the canvas `srcDoc` iframe (verify with `npm run tauri dev`).
- [ ] **Narrow Tauri capabilities**: drop the redundant `http://localhost:*` / `127.0.0.1` entries; decide on `http://*` vs per-provider hosts; restrict `shell` args if feasible.
- [ ] **Tooling**: `rustup component add rustfmt`, `cargo fmt`, `clippy -D warnings`, ESLint + Prettier, and add them to `npm run check` and CI.
- [ ] **Split `ChatView.tsx`** (630 lines) into composer, message list and header components.
- [ ] **UI tests** for Sidebar, Settings and ChatView (Vitest + Testing Library or Playwright against `npm run dev`).
- [ ] **Build pipeline**: run `npm --prefix sidecar ci` in `beforeBuildCommand`; Developer ID signing and notarization instead of ad-hoc `-`.
- [ ] **First commit and branch protection**; PR template.
- [ ] **README cleanup**: move the changelog-like sections into `docs/`, keep README to setup, structure and providers.

## P1
- [x] **Persist drafts and attachments** across restarts (SQLite `drafts` table, debounced writes, bounded payloads; see `lib/chatSessions.ts`, `lib/useComposerDraft.ts`).
- [ ] **Full-text search across chats** (SQLite FTS5 over `messages`, Cmd+K, filter by project/model).
- [ ] **Run setup and tests in the shadow copy** (install deps or link `node_modules`; optional `npm test` before accepting changes).

## P2
- [ ] **MCP servers**: connect external tools (GitHub, databases, browser).
- [ ] **Partial accept**: apply changes per hunk in `ChangesPanel`.
- [ ] **Git integration**: commit accepted changes, generated commit message, branch/PR (`git.rs`).
- [ ] **`@file` / `@folder` mentions** in the composer with autocomplete.
- [ ] **Chat branching**: fork a conversation from any message.
- [ ] **Model comparison**: send one prompt to several models side by side.
- [x] **Budgets and alerts**: token limits per day or chat (no cost: providers do not report prices); warn near Codex/Claude quota.
- [x] **Command allow/deny rules** (allow/ask/deny prefix and glob rules, global or per project, parsed-command evaluation, built-in deny defaults, rules editor) and a **unified agent action log** with undo of file edits (`rules.ts`, `actionLog.ts`, `fileUndo.ts`). Command execution itself cannot be undone; the UI was not smoke-tested in `tauri dev`.
- [ ] **Keyboard shortcuts** map and settings screen (global shortcut plugin is already wired).
- [ ] **Per-project system prompt / instructions file** (`AGENTS.md` / `CLAUDE.md` auto-load).
- [ ] **Message actions**: edit and resend, regenerate, copy, delete.
- [ ] **Streaming robustness**: cancel, resume after network loss, backoff on 429/5xx.
- [ ] **Accessibility pass** (focus order, ARIA, contrast) using the design review skills.

## P3
- [ ] **Canvas**: multi-file modules, bundled extra libraries, export to HTML/PNG, revision diff.
- [ ] **Model routing** by task type (cheap vs strong model).
- [ ] **Scheduled prompts.**
- [ ] **Voice input** and screenshot paste.
- [ ] **Auto-update** channel (Tauri updater) and crash reporting opt-in.
- [ ] **Theming**: light/dark/system and accent color.
- [ ] **Windows/Linux support audit** (`secrets.rs` is macOS Keychain only; `computer.rs`; paths).
- [x] **Export/import chats** (Markdown/JSON export, JSON import).
- [ ] **Importers** for Claude Code, Codex and ChatGPT histories (Cursor exists in `cursor_import.rs`).
- [ ] **Smoke-test in `tauri dev`**: draft restore, budgets banner, chat export/import, save dialog.

## Multi-agent (epic)
Reference: the "Background tasks" panel in Claude Code desktop (running agents with model, elapsed time, tokens, tool uses, current step, stop button, transcript link, finished list).
- [ ] **Agent runtime**: spawn a subagent as a separate run (own provider/model, system prompt, tool set, budget) from the main chat; the parent receives only the final report. Reuse `agent/agent.ts` loop; no shared mutable chat state.
- [ ] **Isolation**: each subagent works in its own shadow copy (`review.rs`); on completion its changes appear as a separate review in `ChangesPanel`. Detect overlapping files between agents and flag conflicts before accept.
- [ ] **Background tasks panel**: list Running/Finished agents with title, model, elapsed time, token count, tool-use count, current step, Stop button, and "View transcript".
- [ ] **Orchestration**: planner splits a request into tasks with file ownership; parallelism limit (default 3-4); task queue with dependencies; retry/cancel; results merged into one summary message.
- [ ] **Agent types** (explore read-only, plan, general, review) with per-type tool allowlists and default models (ties into model routing).
- [ ] **Per-agent budgets** (tokens, time, tool calls) integrated with Budgets and alerts; aggregate usage in telemetry.
- [ ] **Persistence**: store agent runs and transcripts in SQLite; survive app restart (mark interrupted runs).
- [ ] **Notifications** when an agent finishes or needs approval; approvals from background agents surface in the UI.
- [ ] **Tests**: scheduler/queue unit tests, isolation tests (two agents, same file), cancellation tests.

## Done
- [x] Multi-provider chat (API + Codex/Claude/Cursor CLI)
- [x] Interactive React canvas with revisions
- [x] File review with diff, conflict check and checkpoints
- [x] Context compression, token usage and quota telemetry
- [x] Cursor history import, Computer Use
