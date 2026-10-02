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
| `components/` | UI: `CommandRules`/`ActionLog` (settings), `ChatView`, `Sidebar`, `Settings`, `ModelPicker`, `ChangesPanel` (file review), `CanvasPanel`/`CanvasWorkspace`, `ToolCard`, `ImportPanel`, `Onboarding` |
| `lib/api.ts` | Typed wrappers over Tauri `invoke` |
| `lib/exportChats.ts` | Pure chat export/import: whitelisted, secret-scrubbed JSON bundle (`mcode-chats` v1), Markdown renderer, JSON parser/sanitizer and `importBundle` over an injected `ChatStore`; UI glue (save dialog, file input, SQLite store) is in `components/ImportPanel.tsx` |
| `lib/data.ts` | Persistence helpers over SQLite (projects, chats, messages, settings, composer drafts via `loadDraft` and the shared `draftSaver`) |
| `lib/chatSessions.ts` | Open chat sessions (which chats are mounted, busy flags) plus the pure draft logic: scopes (`chat:<id>` / `new:<projectId>`), persistence bounds (`DRAFT_LIMITS`), (de)serialization of text and image attachments, and `createDraftSaver` (debounced, ordered, best-effort writes that skip no-ops and omit unchanged attachments). Session state itself is in memory; drafts are persisted in SQLite |
| `lib/useComposerDraft.ts` | Hook used by `ChatView`: restores the stored draft when a chat opens, saves edits debounced, moves a new-chat draft to the chat's scope on first send, and clears it once the message is stored |
| `lib/context.ts` | Token estimate, context compression |
| `lib/checkpoints.ts` | Shadow checkpoints / rollback |
| `providers/` | One module per backend: `anthropic`, `openaiCompatible`, `openaiResponses`, CLI bridges (`cli`, `claudeCli`, `cursor`), plus `usage`, `limits`, `activities`, `computerBridge` |
| `agent/` | `agent.ts` runs the tool-calling loop for API providers; `tools.ts` declares the tools; `rules.ts` is the pure command parser, allow/ask/deny rules and built-in protections (`rulesStore.ts` persists them under `commandRules`); `actionLog.ts` (pure) and `actionLogStore.ts` keep the action log under `actionLog` |
| `lib/fileUndo.ts` | Pure per-edit undo over injected git/file primitives; `checkpoints.ts` binds it to the shadow repo |
| `canvas/` | Sandboxed TSX preview runtime (generated bundle in `canvas/generated`, git-ignored) |
| `i18n/` | Translations, validated by `scripts/check-i18n.mjs` |

### Backend (`src-tauri/src/`)
| File | Commands / role |
| --- | --- |
| `db.rs` | SQLite (rusqlite, WAL). Tables: `projects`, `chats`, `messages`, `settings`, `models_seen`, `drafts` (composer text and attachments per chat or unsent new chat; removed with their chat or project). The schema is all `create ... if not exists`, so opening an older database migrates it. A poisoned connection mutex is recovered instead of failing every later command. Commands: `db_select`, `db_execute` |
| `tools.rs` | Filesystem and shell: `fs_read`, `fs_list`, `fs_files`, `fs_search`, `fs_edit`, `fs_write`, `run_command`, `read_rules`, `read_home_file` |
| `review.rs` | Shadow-copy review: `review_prepare`, `review_list`, `review_diff`, `review_decide`, `review_finish` |
| `git.rs` | `git` command wrapper |
| `secrets.rs` | `secret_set/get/delete` (API keys) |
| `computer.rs` | Computer Use: `cu_execute`, `cu_screen_size`, `cu_permissions`, `cu_save_shot` |
| `cursor_import.rs` | Import history from Cursor: `cursor_scan`, `cursor_messages` |

### Sidecar (`sidecar/`)
Node scripts launched by the app: `codex-limits.mjs` (Codex quota via app-server) and `cursor-agent.mjs`.

## Key flows
- **Chat request:** `ChatView` → `providers/index.ts` picks a backend → API providers go through `agent/agent.ts` (tool loop calling Tauri commands); CLI providers stream via the shell plugin.
- **Writable project:** `review_prepare` copies sources to an app-managed directory; the agent edits the copy; `ChangesPanel` shows diffs; `review_decide` applies files after a baseline check; checkpoints allow rollback.
- **Canvas:** assistant messages with a `tsx-canvas` fence become cards; revisions are derived from stored messages; code runs in an opaque-origin iframe.

## Conventions
- Validation: `npm run check` (i18n, `tsc`, node tests, `cargo test`). CI (`.github/workflows`) runs it on macOS.
- Tests live in `tests/*.test.mjs` (Node test runner); `tests/canvas.html` is a dev-only fixture.
- All user-visible strings go through `src/i18n`.
- Node version: see `.nvmrc`.
