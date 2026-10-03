# Export and import

Part of the [M Code documentation](../README.md). Moving chats in and out of M Code.

## Export and import chats

Right-click a chat in the sidebar and choose Export as Markdown or JSON; Settings, Import has "Export all chats" (archived chats included) and "Import chats from a JSON file". Files are written through the native save dialog.

- **Markdown** is for reading: one document per export, `User` / `Assistant (model)` headings, and tool calls as readable blocks (a `sh` block for commands, a `diff` for edits, a list for Computer Use actions, then the result, marked as failed on errors). Tool output and arguments are clipped to 4000 characters per block; the labels follow the UI language.
- **JSON** is the lossless, versioned format (`"format": "mcode-chats"`, `"version": 1`; a newer version is refused on import). It keeps messages, parts, timestamps, token usage, the archived flag and the project name and path. `responseId` and shadow-copy checkpoint ids are machine-local and are not exported.
- Images and Computer Use screenshots are left out unless "Include images and screenshots" is ticked (they can make files very large).
- API keys live in the Keychain and are never read by the exporter. Free-form text, tool arguments and tool output are also scrubbed (best effort) for common key formats, `Bearer` tokens, private keys, passwords in URLs and `KEY=value` or `"apiKey": "value"` assignments, which become `[REDACTED]`. Review a file before sharing it.
- Import validates and sanitizes the file, then adds its chats through the normal data helpers. A chat whose title and creation time already exist is skipped, so importing the same file twice is safe. Chats attach to a project with the same path, then the same name; otherwise a project without a folder is created. A path from a file is never registered as a new project folder.

Logic lives in `src/lib/exportChats.ts` (pure, no Tauri); `npm test` covers it in `tests/exportChats.test.mjs`.

## Share a chat as HTML

Right-click a chat and choose Share as HTML (Settings, Import has the same for any chat, next to the export buttons). The result is one self-contained `.html` file: no scripts, no network (a strict CSP meta tag with `default-src 'none'`, images only as `data:` URIs), light/dark through `prefers-color-scheme`, and a print stylesheet. Hosted links are out of scope.

- The page has a header (title, project, dates, model) and the conversation: messages rendered with the app's own Markdown pipeline (react-markdown, GFM, highlight classes inlined as CSS; raw HTML in a message stays text, `javascript:` links are dropped and remote images become their alt text), tool cards that merge a call with its result (command, clipped output, status, failed marked), diffs for file edits, written files with their path, and canvas artifacts as source blocks (never run).
- Secrets go through the same scrubbing as the Markdown/JSON export (`redactSecrets`/`redactValue`). Before saving, the dialog shows how many secrets were replaced (or that none were found, with a reminder that paths and project names stay in), a preview toggle (a sandboxed frame without scripts) and "Include images and screenshots" (off by default; images are embedded as `data:` URIs, so files can get large). Saving uses the native save dialog.
- Limits: one message is clipped at 200,000 characters, one tool output at 6,000 and one tool argument block at 4,000, each with a "more characters not shown" note; a long diff is shown up to 400 lines.

Logic lives in `src/lib/shareHtml.ts` (pure; tested in `tests/shareHtml.test.mjs`: escaping, redaction count, no external URLs, CSP, tool cards, unicode, clipping); the dialog is `components/ShareHtmlDialog.tsx` (`tests/ui/ShareHtmlDialog.test.tsx`).

## Import from Claude Code, Codex and ChatGPT

Settings, Import (and onboarding) list the conversations of other assistants with checkboxes, a search box (title, folder, id) and "Select shown"; sessions that are already in M Code are marked and cannot be ticked again. Sources:

- **Claude Code**: `~/.claude/projects/<project>/*.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`). User and assistant text, `tool_use` and `tool_result` blocks become messages with tool calls and results; thinking blocks, sub-agent (`isSidechain`), `isMeta` and compaction-summary lines, hooks, snapshots and attachments are skipped. A rewound session keeps its file order (abandoned branches included). The title is the session's custom or AI title, else the first prompt.
- **Codex CLI**: `~/.codex/sessions/**/rollout-*.jsonl` (or `$CODEX_HOME/sessions`). `response_item` messages, function / custom / shell tool calls and their outputs; reasoning, developer prompts and injected context (`<environment_context>`, AGENTS.md text) are skipped, and so are sub-agent threads. The older rollout layout is accepted.
- **ChatGPT**: choose `conversations.json` from the data export (ChatGPT: Settings, Data controls, Export data). Each conversation's `mapping` tree is flattened to the thread that ends at `current_node` (without it, the newest branch); other branches are not imported. Code sent to a tool and its output become a tool call and result; system prompts, hidden messages, reasoning and citation markers are dropped, images become `[image omitted]`.

Safety and bounds: only the session or conversation files themselves are read (never `settings.json`, `config.toml`, `auth.json`, `.env` or other config); all text, tool arguments and tool outputs pass through the same secret scrubber as chat export. A project folder named in a session only matches an existing project by path, then by name; otherwise a project without a folder is created, so an imported file can never grant access to a directory (ChatGPT chats get no project). Duplicates are detected by source session id (`chats.source_id`, e.g. `claude-code:<id>`) and by title plus creation time. Original timestamps are kept. Lines over 4 MB are skipped, a session file is read up to 64 MB, one ChatGPT conversation up to 24 MB, texts and tool outputs are clipped with a visible marker, at most 10,000 messages per chat; malformed lines are skipped. Every tool call gets a result (a placeholder when the session recorded none) so imported chats can be continued with any provider. Settings shows each import as "Imported from Claude Code / Codex / ChatGPT".

Rust (`src-tauri/src/import_sources.rs`) scans the folders and streams the ChatGPT file off the UI thread and returns bounded summaries; the parsers are pure TypeScript in `src/lib/importers/`, covered by `tests/importers.test.mjs` (synthetic fixtures only).
