# Tasks

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Priority: P1 (next) · P2 · P3.
Items were drafted from the README and code layout; verify against the code before starting.

## P0 — hardening and hygiene
- [x] **Remove panics and loose types**: replace non-test `unwrap()` in `db.rs`, `computer.rs`, `tools.rs` with error handling (poisoned Mutex must not brick the DB); drop `as any` in `providers/activities.ts` and `components/Markdown.tsx`.
- [x] **Validate `root` in `fs_files` / `fs_search`** the same way `resolve_in_root` does for read/list/edit.
- [ ] **Strict CSP** in `tauri.conf.json` that still allows the canvas `srcDoc` iframe (verify with `npm run tauri dev`).
- [ ] **Narrow Tauri capabilities**: drop the redundant `http://localhost:*` / `127.0.0.1` entries; decide on `http://*` vs per-provider hosts; restrict `shell` args if feasible.
- [ ] **Tooling**: `rustup component add rustfmt`, `cargo fmt`, `clippy -D warnings`, ESLint + Prettier, and add them to `npm run check` and CI.
- [x] **Split `ChatView.tsx`** into composer (`components/chat/Composer`, `ContextChip`), turn list (`TurnView`), live status (`LiveStatus`, `ApprovalCard`) and the run hook `lib/useChatRun.ts`.
- [x] **UI tests**: Vitest + Testing Library + jsdom in `tests/ui/` (`npm run test:ui`, part of `npm run check`) for Sidebar, Settings, Composer/ContextChip, ApprovalCard, GitCommitDialog and SearchPalette with a mocked Tauri backend. Not done: `ChatView` end to end (run loop, streaming), `ChangesPanel`, `ModelPicker` details, real-browser (Playwright) tests.
- [ ] **Build pipeline**: run `npm --prefix sidecar ci` in `beforeBuildCommand`; Developer ID signing and notarization instead of ad-hoc `-`.
- [x] **First commit** (done); branch protection and PR template still open.
- [ ] **README cleanup**: move the changelog-like sections into `docs/`, keep README to setup, structure and providers.

## P1
- [x] **Persist drafts and attachments** across restarts (SQLite `drafts` table, debounced writes, bounded payloads; see `lib/chatSessions.ts`, `lib/useComposerDraft.ts`).
- [x] **Full-text search across chats** (SQLite FTS5 index `messages_fts` kept in sync by triggers and backfilled on start; `search_messages` in `db.rs`; Cmd+K `SearchPalette` with project/model filters, snippets, keyboard navigation and jump to the message).
- [x] **Run setup and tests in the shadow copy** (opt-in per project: symlinked dependency dirs that review never applies, setup command, "Run tests" result shown in `ChangesPanel`; commands follow the approval rules). Not done: sandboxing writes through linked dirs, streaming command output.

## P1.5 — CLI image attachments
- [x] **Forward image attachments to CLI providers** (today `images: false` in `providers/cli.ts` and the composer refuses them). Plan:
  1. On send, write attached images to `<app data>/attachments/<chat>/<n>.png` (bounded size, unique names).
  2. Codex: pass files with `exec -i <file>` (verify on a working Codex install). Claude Code and Cursor Agent: add "Attached image: <path> (read it)" to the prompt; later consider Claude `--input-format stream-json` with native image blocks.
  3. Set `images: true` for these CLIs (keep false when the underlying model has no vision).
  4. Delete temp files after the reply and when the chat is deleted; never store them in the project folder.
  5. Tests for arg building and prompt text (`cliArgs.test.mjs`); update the README sentence about unsupported CLI attachments.
  Done in `attachments.rs`, `cli.ts`, `cliArgs.ts`, `claudeCli.ts`. Codex uses `--image=<file>` (the `-i` option is variadic); Claude gets `--add-dir=<dir>` plus the prompt line, Cursor Agent `--add-dir <dir>` plus the prompt line. Not verified against real CLIs end to end: `codex exec --help` (bundled ChatGPT app binary) and `claude --help` / `cursor-agent --help` confirm the flags exist; actual image reading is untested. `images: true` is set for every CLI model (model vision is not detectable). Native Claude `stream-json` image blocks are still a later option.

## P1.6 — Computer Use reliability and speed
- [x] **Verified Computer Use loop**: screenshot → inspect → small batch → verification screenshot → confirmed result. Done as planned below (`agent/computerCore.ts`, `computerBridge.ts`, `computer.rs`; README "Computer Use"). Not smoke-tested on a live Mac: settle timing, window-title reading, `open_app`, CLI image forwarding with real codex/claude/cursor runs. `open_app` exists only in the shared `mcode-computer` protocol, which every provider uses (the native Anthropic/OpenAI computer tools are bypassed by `withComputer`).
  1. CLI providers get screenshots as real images through the attachment pipeline (codex `--image`, claude/cursor path + `--add-dir`) instead of a bare "inspect this file" line; API providers keep inline images.
  2. Tool results carry facts, not "OK": frontmost app and window title, whether the screen changed, cursor position, failed step index.
  3. Automatic verification screenshot after every action batch (settle by waiting for the screen to stabilise, bounded), so no extra turn is needed.
  4. Fast primitives: `open_app` (by name, via `open -a`) and adaptive waits; prompt rules: batch actions, no filler messages, claim success only when the screenshot shows it, say when unsure.
  5. Approvals: in Full access ask only for likely-irreversible steps (Enter/Return right after typing in a messaging app, delete/quit shortcuts), with "allow for this task"; keep the existing confirmation flow otherwise.

## P2
- [ ] **Automatic Cursor account rotation.** Several Cursor accounts, each logged in through the `cursor-agent` CLI (browser login, not API key: reportedly faster). When the active account is out of quota, the next message goes to the next account, round-robin. No mid-response switching; the current message just fails with a clear error.
  - [~] **Research first** (partly done, 2026-10-02). Verified locally with `cursor-agent` 2026.09.28: `CURSOR_CONFIG_DIR=<dir>` is honoured (the CLI creates `cli-config.json` there instead of in `~/.cursor`); overriding `HOME` also isolates but also redirects caches. No Keychain reference found in the binary's strings, so the token is probably file-based in that dir. Not in the official docs, only in third-party material. Still to verify with a real login (needs the user's browser): `CURSOR_CONFIG_DIR=<dir> cursor-agent login`, then `status --format json` per profile, then confirm two profiles hold different accounts at once, that tokens refresh independently, and that nothing lands in the shared Keychain. Also measure CLI-login vs API-key speed. Note: the CLI is currently not logged in on this Mac.
  - [ ] Account model: per-account isolated profile directory under app data, "Add account" flow that runs `cursor-agent login` in that profile and shows the logged-in email; remove/re-login.
  - [ ] Replace the single `backupProviderId` with an ordered pool (`providers/cursorAccounts.ts`, `reserveFor`, `Settings.tsx`); keep API-key accounts as an optional fallback type.
  - [ ] Detect quota exhaustion from `cursor-agent` output/exit; mark the account exhausted until its reset time, pick the next non-exhausted account for the following message, wrap around; error when all are exhausted.
  - [ ] Show the active account in the UI, notify on switch, keep per-account usage in telemetry.
  - [ ] Session resume: provider sessions are tied to an account, so after a switch start a fresh session (with context carried by app-side history/summary) and check the model exists on the new account.

- [ ] **Cross-platform build (Windows/Linux)**; today macOS only.
  - [ ] Replace `security-framework` in `src-tauri/src/secrets.rs` with `keyring` (or gate with `cfg(target_os)`).
  - [ ] Pick the shell per OS: `/bin/zsh` in `tools.rs` and `zsh -lc` in `providers/cli.ts` (bash/sh on Linux, PowerShell on Windows).
  - [ ] `tauri.conf.json`: add `nsis`/`msi`/`deb`/`rpm`/`appimage` targets; make `titleBarStyle`/`trafficLightPosition` macOS-only.
  - [ ] Per-OS Cursor history path in `cursor_import.rs` (`%APPDATA%`, `~/.config`).
  - [ ] CLI discovery in `providers/cli.ts` (hardcoded `/Applications/ChatGPT.app`, `~/.nvm`) and Windows paths.
  - [ ] Review Computer Use (Wayland), macOS-specific wording in prompts/i18n, system font stack in `theme.css`.
  - [ ] CI matrix: `windows-latest`, `ubuntu-latest` (install `libwebkit2gtk-4.1-dev` etc.).
- [x] **MCP servers**: API-provider agents use tools of stdio and streamable-HTTP MCP servers (`src/agent/mcp/`, `mcp.rs`, `McpServers.tsx`): Keychain secrets, import of `mcpServers` JSON, approvals per call/tool/server, read-only mode, action log. Not done: resources/prompts/sampling/OAuth, the legacy SSE transport, subagent access to MCP tools, CLI providers (own config); not smoke-tested against real servers or in `tauri dev`.
- [x] **Partial accept**: accept/reject per hunk in the diff view (`hunks.rs`, `HunkDiff`); whole-file decisions remain for new, deleted and binary files.
- [x] **Git integration**: commit accepted changes, generated commit message, optional branch before commit (`git.rs`, `GitCommitDialog`). Not done: push and pull-request creation.
- [x] **`@file` mentions** in the composer with autocomplete (already existed; `@folder` not supported).
- [x] **Chat branching**: "Branch from here" on any message copies the history up to it into a new chat (`branchChat` in `lib/data.ts`).
- [x] **Model comparison**: send one prompt to 2-4 models side by side (`lib/compare.ts`, `Compare.tsx`): parallel read-only runs, per-column stop/run again, live and reported tokens, classified errors, "Continue in chat". Nothing is persisted except a continued chat; not smoke-tested in `tauri dev`. Not done: budget gauge does not count un-continued comparison tokens (it reads stored messages); system prompt and reasoning level are fixed.
- [x] **Budgets and alerts**: token limits per day or chat (no cost: providers do not report prices); warn near Codex/Claude quota.
- [x] **Command allow/deny rules** (allow/ask/deny prefix and glob rules, global or per project, parsed-command evaluation, built-in deny defaults, rules editor) and a **unified agent action log** with undo of file edits (`rules.ts`, `actionLog.ts`, `fileUndo.ts`). Command execution itself cannot be undone; the UI was not smoke-tested in `tauri dev`.
- [x] **Keyboard shortcuts** map and settings screen (global shortcut plugin is already wired).
- [x] **Per-project system prompt / instructions file** (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, always-apply `.cursor/rules` auto-loaded with caps, dedupe, untrusted-content fencing and no repeat of files a CLI reads itself; per-project custom text in the sidebar project menu; loaded files listed in the context chip). Not done: nested/subfolder instruction files, `.cursor/rules` globs/agent-requested rules; the UI was not smoke-tested in `tauri dev`.
- [x] **Message actions**: edit and resend, regenerate, copy, delete (disabled while a run is active; `lib/messageActions.ts`).
- [x] **Streaming robustness**: cancel, resume after network loss, backoff on 429/5xx (`providers/retry.ts`; retry only before any output, otherwise the interrupted-request flow continues; a "Retrying in Ns…" notice is shown in the chat).
- [ ] **Accessibility pass** (focus order, ARIA, contrast) using the design review skills.

## P3
- [ ] **Canvas**: multi-file modules, bundled extra libraries, export to HTML/PNG, revision diff.
- [x] **Model routing** by task type (cheap vs strong model). Done for agents: default model per subagent type, an allow-list for explicit `model` requests, and a cheap model for chat compaction and commit messages (Settings, Usage, Agents; `agentSettings.ts`, `lib/modelRouting.ts`). Not done: automatic routing of the main chat's own requests.
- [ ] **Scheduled prompts.**
- [ ] **Voice input** and screenshot paste.
- [ ] **Auto-update** channel (Tauri updater) and crash reporting opt-in.
- [x] **Theming**: light/dark/system and accent color.
- [ ] **Windows/Linux support audit** (`secrets.rs` is macOS Keychain only; `computer.rs`; paths).
- [x] **Export/import chats** (Markdown/JSON export, JSON import).
- [x] **Importers** for Claude Code, Codex and ChatGPT histories (`import_sources.rs`, `src/lib/importers/`; Cursor stays in `cursor_import.rs`).
- [ ] **Smoke-test in `tauri dev`**: draft restore, budgets banner, chat export/import, save dialog.

## Multi-agent (epic)
Reference: the "Background tasks" panel in Claude Code desktop (running agents with model, elapsed time, tokens, tool uses, current step, stop button, transcript link, finished list).
- [x] **Agent runtime**: spawn a subagent as a separate run (own provider/model, system prompt, tool set, budget) from the main chat; the parent receives only the final report. Reuse `agent/agent.ts` loop; no shared mutable chat state. Done: `spawn_agent`, queue (3), cancellation, report cap; see README "Subagents".
- [x] **Isolation**: each subagent works in its own shadow copy (`review.rs`); on completion its changes appear as a separate review in `ChangesPanel`. Detect overlapping files between agents and flag conflicts before accept. Done: per-agent shadow copy, overlap warning in the report and panel; no pre-accept conflict gate in ChangesPanel yet.
- [x] **Background tasks panel**: list Running/Finished agents with title, model, elapsed time, token count, tool-use count, current step, Stop button, and "View transcript".
- [x] **Orchestration**: planner splits a request into tasks with file ownership; parallelism limit (default 3-4); task queue with dependencies; retry/cancel; results merged into one summary message. Done: `delegate_tasks` (the main agent is the planner): up to 12 tasks with `files` ownership and `dependsOn`, validated (ids, unknown deps, cycles, models) before anything starts, run up to the shared concurrency limit, overlapping (or undeclared) write ownership between general tasks queued, dependants of a failed task skipped (setting, overridable per call), one merged summary (`orchestrator.ts`). Not done: automatic retry of a failed task (the main agent can resubmit); dependants do not see earlier tasks' pending file changes, only their reports.
- [x] **Agent types** (explore read-only, plan, general, review) with per-type tool allowlists and default models (ties into model routing). Allowlists per type; default model per type in settings with fallback to the parent's model; only API providers with tool support can host a subagent.
- [x] **Per-agent budgets** (tokens, time, tool calls) integrated with Budgets and alerts; aggregate usage in telemetry. Per-run limits (steps, tool calls, wall time, tokens) with user-configurable defaults per type (hard caps kept); a breach stops the run, is noted in its transcript and report; subagent tokens are recorded via `recordTokens` (Usage telemetry) and in the `agentUsage` ledger (per day and parent chat) that the day/chat budgets and their banner add to the stored-message totals.
- [x] **Persistence**: store agent runs and transcripts in SQLite; survive app restart (mark interrupted runs). Transcripts are clipped step summaries in `settings` (`agentRuns`), not full messages in SQLite.
- [x] **Notifications** when an agent finishes or needs approval; approvals from background agents surface in the UI. Done: `tauri-plugin-notification` (Rust plugin + capability, called through `invoke`, no npm package) plus dock badge and bounce while the window is unfocused (`lib/attention.ts`); a "!" badge on chats with an open approval in the sidebar; a switch in Settings. Not smoke-tested in `tauri dev` (notification attribution in an unsigned dev build is unverified).
- [x] **Tests**: scheduler/queue unit tests, isolation tests (two agents, same file), cancellation tests. Scheduler, cancellation, budgets (defaults and overrides), isolation with two agents on one file, approvals, model selection per type and allow-list, plan validation, dependency scheduling, ownership conflicts and cancellation of dependants are covered in `tests/scheduler|subagentCore|subagents|agentRuns|agentSettings|orchestrator.test.mjs`. The UI (panel, settings section, sidebar badge, notifications) is untested.

## Done
- [x] Multi-provider chat (API + Codex/Claude/Cursor CLI)
- [x] Interactive React canvas with revisions
- [x] File review with diff, conflict check and checkpoints
- [x] Context compression, token usage and quota telemetry
- [x] Cursor history import, Computer Use
