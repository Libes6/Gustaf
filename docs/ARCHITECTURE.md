# Architecture

M Code is a Tauri 2 desktop app: a React 19 + TypeScript frontend (Vite) and a Rust backend. User-facing behaviour is described in the [README](../README.md); this file describes how the code is organised.

## Layers

```
React UI (src/components) ── state.tsx ── lib/ (api, data, chatSessions, context, checkpoints)
        │                                   │
        │                           providers/ (model backends)      agent/ (tool loop)
        ▼                                   ▼                              ▼
              Tauri commands (src-tauri/src/*.rs)  ◄── sidecar/ (Node helpers)
```

### Frontend (`src/`)
| Path | Role |
| --- | --- |
| `App.tsx`, `state.tsx` | Root component and global app state |
| `components/` | UI: `ChatView`, `Sidebar`, `Settings`, `ModelPicker`, `ChangesPanel` (file review), `GitCommitDialog` (commit accepted files: file picker, generated/edited message, optional branch), `CanvasPanel`/`CanvasWorkspace`, `ToolCard`, `ImportPanel`, `Onboarding`, `SearchPalette` (Cmd+K full-text search over all chats, opened from `App.tsx` and the `Sidebar` button) |
| `lib/api.ts` | Typed wrappers over Tauri `invoke` |
| `lib/exportChats.ts` | Pure chat export/import: whitelisted, secret-scrubbed JSON bundle (`mcode-chats` v1), Markdown renderer, JSON parser/sanitizer and `importBundle` over an injected `ChatStore`; UI glue (save dialog, file input, SQLite store) is in `components/ImportPanel.tsx` |
| `lib/data.ts` | Persistence helpers over SQLite (projects, chats, messages, settings, composer drafts via `loadDraft` and the shared `draftSaver`) |
| `lib/chatSessions.ts` | Open chat sessions (which chats are mounted, busy flags) plus the pure draft logic: scopes (`chat:<id>` / `new:<projectId>`), persistence bounds (`DRAFT_LIMITS`), (de)serialization of text and image attachments, and `createDraftSaver` (debounced, ordered, best-effort writes that skip no-ops and omit unchanged attachments). Session state itself is in memory; drafts are persisted in SQLite |
| `lib/useComposerDraft.ts` | Hook used by `ChatView`: restores the stored draft when a chat opens, saves edits debounced, moves a new-chat draft to the chat's scope on first send, and clears it once the message is stored |
| `lib/searchUtil.ts` | Pure helpers for the search palette: snippet parsing (`parseSnippet` splits the backend's marker characters into plain/highlighted runs), query gate (`searchableQuery`), arrow-key wrap-around, `nearestMessageId` (target when the matched message is gone), the Cmd+K check (layout independent) |
| `lib/useMessageJump.ts` | Hook used by `ChatView`: when `app.jump` (set by `openChatAt` in `state.tsx`) names this chat, scrolls the feed to the message (`data-msg-id` attributes), expands the collapsed steps that contain it and highlights it for a moment |
| `lib/context.ts` | Token estimate, context compression |
| `lib/gitCommit.ts`, `lib/commitMessage.ts` | Pure logic of the commit flow (unit-tested in `tests/gitCommit.test.mjs`, `tests/commitMessage.test.mjs`): in-memory store of files accepted in review per project, file candidates and pre-selection, branch-name validation and suggestion, commit-blocking rules; commit-message prompt building (diff passed as JSON data, hostile content cannot break out) and sanitizing of model output |
| `lib/reviewSetup.ts`, `lib/reviewSetupStore.ts`, `lib/commandRules.ts` | Per-project shadow-copy setup (`reviewSetup:<root>` setting): pure normalization of linked directories and commands, output clipping, run summaries (tested in `tests/reviewSetup.test.mjs`); the store loads/saves it and `prepareShadowCopy` creates the copy and runs the setup command through the approval rules. `commandRules.ts` holds the command allowlist/approval rule shared by the agent and the review panel. UI: `ReviewSetupPanel` (settings form, test run result), `HunkDiff` (per-hunk accept/reject) |
| `lib/checkpoints.ts` | Shadow checkpoints / rollback |
| `providers/` | One module per backend: `anthropic`, `openaiCompatible`, `openaiResponses`, CLI bridges (`cli`, `claudeCli`, `cursor`), plus `usage`, `limits`, `activities`, `computerBridge`. API providers share `retry.ts` (pure: error classification, `Retry-After`, abortable exponential backoff with jitter, retries only before any output reached `onText`), `sse.ts` (stream parser) and `http.ts` (Tauri fetch glue) |
| `agent/` | `agent.ts` runs the tool-calling loop for API providers; `tools.ts` declares the tools |
| `canvas/` | Sandboxed TSX preview runtime (generated bundle in `canvas/generated`, git-ignored) |
| `i18n/` | Translations, validated by `scripts/check-i18n.mjs` |

### Backend (`src-tauri/src/`)
| File | Commands / role |
| --- | --- |
| `db.rs` | SQLite (rusqlite, WAL). Tables: `projects`, `chats`, `messages`, `settings`, `models_seen`, `drafts` (composer text and attachments per chat or unsent new chat; removed with their chat or project) and the FTS5 index `messages_fts` (below). The schema is all `create ... if not exists`, so opening an older database migrates it. A poisoned connection mutex is recovered instead of failing every later command. Commands: `db_select`, `db_execute`, `search_messages`, `search_models` |
| `tools.rs` | Filesystem and shell: `fs_read`, `fs_list`, `fs_files`, `fs_search`, `fs_edit`, `fs_write`, `run_command`, `read_rules`, `read_home_file` |
| `review.rs` | Shadow-copy review: `review_prepare` (optionally symlinks validated project-relative `linked` directories into the copy; they are skipped when copying, listing changes and deciding, so nothing is ever written back through them), `review_list`, `review_diff`, `review_decide`, `review_run` (runs a setup/test command with the copy as cwd via `tools::run_command`; approval is decided in the UI), `review_hunks`, `review_decide_hunks`, `review_finish` |
| `hunks.rs` | Pure hunk logic (no I/O, unit-tested): Myers line diff keeping line terminators, grouping into `-U3`-style hunks with content-derived ids, rebuilding a text from a chosen subset of hunks. Used by `review_hunks` / `review_decide_hunks`: accepting applies the chosen hunks to the project after the baseline check and advances the baseline by the same text; rejecting rewrites the copy only |
| `git.rs` | `git`: generic wrapper, also drives the app-managed shadow checkpoint repo. Project-repo commands for the commit flow (argument arrays only, no shell; paths validated with `resolve_in_root` and passed as literal pathspecs; repo-configured fsmonitor/textconv/external-diff commands disabled; hooks and signing never bypassed; no push/amend/force): `git_status` (branch, HEAD, changed files under the project root, unfinished merge/rebase), `git_commit_context` (bounded, fairly budgeted diff + stat + recent subjects of the selected files, for message generation), `git_commit` (commits exactly the given paths via `commit --only`, optional new branch from HEAD, rolls the branch and staging back if the commit fails). Multi-step operations are serialized per repository |
| `secrets.rs` | `secret_set/get/delete` (API keys) |
| `computer.rs` | Computer Use: `cu_execute`, `cu_screen_size`, `cu_permissions`, `cu_save_shot` |
| `cursor_import.rs` | Import history from Cursor: `cursor_scan`, `cursor_messages` |

#### Full-text search (`db.rs`)
`messages_fts` is an FTS5 table (`unicode61`, case and accent insensitive, prefix indexes) whose rowid is `messages.id`; it stores the readable text of a message plus unindexed `chat_id`, `role` and `model`. FTS5 and the JSON functions come with the bundled SQLite of rusqlite (`features = ["bundled"]`), so Cargo.toml needs no extra feature.
- **What is indexed:** only `text` parts of the stored JSON, joined by newlines; never images, tool calls/results or activities. User text is cleaned like `userText()` in `ChatView` (`<system_notification>` messages skipped, imported Cursor `<user_query>` unwrapped, the `<file path=...>` blocks appended for `@file` mentions cut). Compaction summaries are skipped. At most 100,000 characters per message. Malformed JSON is skipped, never an error.
- **Sync:** AFTER INSERT / UPDATE (`id, chat_id, role, content`) / DELETE triggers on `messages`, built from plain SQL functions only, so every writer keeps the index current: the JS `db_execute` bridge, imports, `ON DELETE CASCADE` from chats and projects, and older app builds that do not know about search.
- **Migration:** `init_search` runs on every start. It stores `SEARCH_VERSION` in `settings` (`searchIndexVersion`); if the table or a trigger is missing or the version differs it drops and recreates table and triggers and backfills from `messages` in one transaction, otherwise it does nothing. Bump `SEARCH_VERSION` when the extraction rules change. A failure here is logged and does not stop the app (search then reports an error).
- **Queries:** `fts_match` turns user input into FTS5 syntax by quoting every term, so operators and punctuation are plain text and cannot cause syntax errors (`"..."` is an exact phrase; other terms also match as prefixes; terms and length are capped). `search_messages(query, projectId?, model?, limit?)` returns hits ranked by bm25 (newest first on ties) with a snippet whose matches are wrapped in `\u0001`/`\u0002`, plus chat title, project, archived flag, role and model. The model filter keeps messages recorded with that model (assistant replies; user messages carry none). `search_models` lists the models for the filter. Both commands run on a worker thread.
- `ё` and `е` are not folded together by the tokenizer.

### Sidecar (`sidecar/`)
Node scripts launched by the app: `codex-limits.mjs` (Codex quota via app-server) and `cursor-agent.mjs`.

## Key flows
- **Chat request:** `ChatView` → `providers/index.ts` picks a backend → API providers go through `agent/agent.ts` (tool loop calling Tauri commands); CLI providers stream via the shell plugin.
- **Writable project:** `review_prepare` copies sources to an app-managed directory; the agent edits the copy; `ChangesPanel` shows diffs; `review_decide` applies files after a baseline check; checkpoints allow rollback.
- **Commit accepted changes:** `ChangesPanel` records each accepted file (`acceptedFiles`) and offers `GitCommitDialog` while any of them is still dirty in git. The dialog loads `git_status`, pre-selects the accepted files, optionally generates a message through `getAdapter(selected provider).turn` (read-only, no tools, usage recorded like other turns) from `git_commit_context`, and calls `git_commit` with only the ticked paths.
- **Search:** Cmd+K (`App.tsx`) or the sidebar button opens `SearchPalette`; typing is debounced, only the newest request updates the list, a hit calls `openChatAt(chatId, projectId, messageId)`, and `useMessageJump` in the chat view scrolls to the message (or the nearest one if it was removed).
- **Canvas:** assistant messages with a `tsx-canvas` fence become cards; revisions are derived from stored messages; code runs in an opaque-origin iframe.

## Conventions
- Validation: `npm run check` (i18n, `tsc`, node tests, `cargo test`). CI (`.github/workflows`) runs it on macOS.
- Tests live in `tests/*.test.mjs` (Node test runner); `tests/canvas.html` is a dev-only fixture.
- All user-visible strings go through `src/i18n`.
- Node version: see `.nvmrc`.
