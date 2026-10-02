# M Code

Desktop AI chat and coding assistant built with Tauri, React and TypeScript.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — code layout and key flows
- [Tasks](TASKS.md) — roadmap and backlog

## Development

```sh
npm install
npm run tauri dev
```

`npm run dev` serves the frontend; normal chats require the native Tauri backend.
`npm run build` checks TypeScript and builds the frontend. `npm run check` also checks translations and runs Rust tests.

## Interactive canvas

Assistant messages can contain a complete React/TSX module:

````text
```tsx-canvas id="counter" title="Counter"
import { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState<number>(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```
````

A finished block becomes a card. Opening it displays Result and Code tabs, restart, copy, and a version selector. Reuse an `id` and send the full module to create a revision. Versions are derived from stored assistant messages, so no separate artifact database is needed. Unclosed fences cannot be opened. Runtime and syntax errors offer a button that puts a repair request and the source into the composer; the user sends it normally.

Canvas instructions are included in API system prompts and CLI prompts, including resumed sessions. Only `react` imports are supported. Use inline styles, a `<style>` element, and SVG; Tailwind and other packages are not included.

React and Sucrase are bundled locally by `scripts/build-canvas.mjs` during `predev` and `prebuild`. The canvas panel is lazy-loaded. Generated files in `src/canvas/generated` are ignored by Git; no CDN is required.

Preview code is compiled and executed inside an opaque-origin iframe with only `allow-scripts`. CSP blocks fetch, external subresources, nested frames, forms, and objects. There is no application API exposed through messages; the parent only accepts bounded error text from the active iframe. The sandbox is a browser boundary, not a CPU/memory quota: a pathological infinite loop can still make the renderer unresponsive. Native WebView isolation should also be verified on release builds.

### Verification

```sh
npm run test:canvas
node scripts/check-i18n.mjs
npm run build
```

With `npm run dev` running, `/tests/canvas.html` is a development-only integration fixture using the real Markdown, canvas panel and sandbox runtime. It covers hooks and TypeScript, revisions, incomplete streams, runtime/syntax errors, script-tag escaping and parent/storage/fetch isolation. The fixture is not a production entry point.

### Chat state and window controls

Visited chats keep separate messages, drafts, attachments, pending approvals and canvas state for the current app session. A new chat during generation opens its own empty draft; background requests continue in their original chat. Each composer's unsent text and attached images are also saved to the local database (debounced, a fraction of a second after you stop typing) and come back when you reopen the chat after a restart; sending a message clears the saved draft. A draft in a new chat that has not been sent yet is kept too (one per project, plus one without a project). Saved drafts are bounded: text is cut at 200,000 characters and at most 8 images are kept, each up to about 2.2 MB and about 6 MB in total; larger images stay attached in the open composer but are not restored after a restart. Recent chats appear first, with an expandable list.

Provider sign-in is verified by a small test request or a successful chat response, not by listing models. HTTP 401 marks the provider as requiring sign-in. Failed requests can be retried without duplicating the user message; a retry can use another provider. Completed steps are retained when continuing an interrupted request.

Canvas supports dragging the divider (or focusing it and pressing arrow keys) and exporting the selected revision as TSX through the native save dialog. The dedicated window header reserves space for macOS controls and supports dragging and double-clicking to toggle maximization.

Validation: `npm run check`, `npm run test:chat`, `npm run test:canvas`, `npm run tauri build -- --debug --bundles app`.

### Streaming robustness

The API providers (Anthropic, OpenAI Responses, OpenAI-compatible: OpenRouter, Gemini, Ollama, LM Studio, custom) retry transient failures with exponential backoff and jitter: HTTP 408/429/5xx, dropped connections, and error events inside a stream (for example Anthropic `overloaded_error`). Up to 4 attempts and 30 seconds of total waiting per request; `Retry-After` is honoured, and a longer one is shown to you instead of waited out. Stop cancels a pending wait immediately. A request is **never** retried once any text has been streamed to the chat: the error is shown and Retry continues the interrupted request from the completed steps, so nothing is duplicated. Errors are classified in the message: rate limit, quota or credits exhausted, authentication (401/403, not retried), network, provider server error. A refused connection (e.g. Ollama not running) is reported at once. The logic is in `src/providers/retry.ts` (pure, injectable fetch/sleep/clock) and `src/providers/sse.ts`; `TurnInput.onRetry` (also `RunOptions.onRetry`) reports each wait; the `retryingIn` string and `retryNoticeVars` are ready for a "Retrying in 5s…" notice, which the chat view does not show yet. `tests/retry.test.mjs` covers the logic and `tests/providerRetry.test.mjs` runs the three adapters against a scripted fetch.

### Usage telemetry

Usage tracks provider-reported input, output, cache read/write and reasoning tokens by provider/model from the time tracking is enabled. Cached and reasoning counts are subsets, not extra total tokens. Unknown telemetry is displayed as unavailable; older messages and external app usage are not retroactively estimated. Each provider request with counts is counted once.

Codex subscription windows are fetched with the read-only `account/rateLimits/read` app-server method; Claude rate-limit stream events are retained when available. Snapshot timestamps and reset times are displayed. Other providers link to their usage dashboard without inventing quota percentages. The npm Codex installation was missing its executable; the official CLI bundled in the Codex desktop app was verified with ChatGPT login and live account quota retrieval. On macOS it serves as a fallback when the CLI on PATH fails.

Model vendor marks use bundled Lobe Icons SVGs, with attribution and license in `public/icons`. `npm run test:usage` verifies token normalization and quota parsing.

### Budgets and alerts

Settings, Usage, Budgets sets optional token limits per local calendar day and per chat, plus a warning threshold (default 80%) stored in the app settings under `budgets`. Limits are tokens only: providers here do not report prices, so no cost is estimated or shown. Usage is summed from the provider-reported counts already stored with each chat message (input plus output; cached and reasoning counts are subsets and are not added again). Every request counts, including history sent again, and the daily total starts from zero at local midnight. A non-blocking, dismissible banner warns at the threshold and shows an exceeded state above the limit; it never prevents sending.

Missing telemetry is not treated as zero. A budget with no counted replies shows as unavailable, a total that skips replies without counts is shown as a lower bound ("at least"), and a limit that is already crossed still shows as exceeded. Not counted: messages removed by retry, provider connection checks, imported history and usage in other apps. The same threshold warns when a Codex or Claude account quota window of the selected provider is nearly or fully used; a snapshot whose reset time has passed (or an old one with no reset time) is treated as stale, not as free quota. `tests/budgets.test.mjs` covers the logic.

### Export and import chats

Right-click a chat in the sidebar and choose Export as Markdown or JSON; Settings, Import has "Export all chats" (archived chats included) and "Import chats from a JSON file". Files are written through the native save dialog.

- **Markdown** is for reading: one document per export, `User` / `Assistant (model)` headings, and tool calls as readable blocks (a `sh` block for commands, a `diff` for edits, a list for Computer Use actions, then the result, marked as failed on errors). Tool output and arguments are clipped to 4000 characters per block; the labels follow the UI language.
- **JSON** is the lossless, versioned format (`"format": "mcode-chats"`, `"version": 1`; a newer version is refused on import). It keeps messages, parts, timestamps, token usage, the archived flag and the project name and path. `responseId` and shadow-copy checkpoint ids are machine-local and are not exported.
- Images and Computer Use screenshots are left out unless "Include images and screenshots" is ticked (they can make files very large).
- API keys live in the Keychain and are never read by the exporter. Free-form text, tool arguments and tool output are also scrubbed (best effort) for common key formats, `Bearer` tokens, private keys, passwords in URLs and `KEY=value` or `"apiKey": "value"` assignments, which become `[REDACTED]`. Review a file before sharing it.
- Import validates and sanitizes the file, then adds its chats through the normal data helpers. A chat whose title and creation time already exist is skipped, so importing the same file twice is safe. Chats attach to a project with the same path, then the same name; otherwise a project without a folder is created. A path from a file is never registered as a new project folder.

Logic lives in `src/lib/exportChats.ts` (pure, no Tauri); `npm test` covers it in `tests/exportChats.test.mjs`. Imports from Claude Code, Codex and ChatGPT exports are not implemented yet.

## Actions, context, and file review

Native Codex/Claude/Cursor CLI actions are stored separately from executable API tool calls. Cards show readable names, output and error status; a missing native result is shown as unknown instead of successful. Nonzero API shell exits are tool errors. Existing imported text-only history cannot reconstruct missing tool outputs.

The composer shows an approximate text-token count. Known context windows and image/tool capabilities come from provider model metadata; unavailable values remain unknown. The last reported input usage is displayed separately and is not treated as the full context size. CLI attachments are marked unsupported because the current prompt bridge does not forward them. Compress chat summarizes long history in chunks using the selected model, retains original messages, and starts future requests from the summary without reusing an older provider session. Restore full context removes summaries and clears provider session pointers.

Writable project requests run in an app-managed copy of source files; proposed files persist across restarts until accepted or rejected. Diff is available before copying each file into the original project. Applying checks that the original still matches its baseline; a conflict does not overwrite the user's edits. Existing shadow checkpoints provide rollback after acceptance. Empty completed reviews are cleaned up. Copies omit ignored files, symlinks, git history, build outputs and dependencies, so build/test commands may need separate setup. This is a file-review workflow, not an OS security sandbox: native tools, commands using absolute paths and Computer Use retain their own permission boundaries.

### Committing accepted changes

When the project is inside a git repository, accepting files from review offers to commit them ("N accepted files to commit" in the changes panel, plus a Commit button in its footer). The dialog shows the branch and working-tree state and lists the changed files: the ones accepted in review are ticked, any other changes in your working tree are unticked and only committed if you tick them. Only the ticked files go into the commit; anything else you had staged stays staged. The message can be written by hand or generated with the model currently selected in the composer (from a bounded diff of the ticked files and the repository's recent commit subjects); it is always editable before committing, and the diff is sent to that provider like any other chat context. You can also create a new branch from the current HEAD first, which is suggested when HEAD is detached.

Safeguards: git hooks and signing run as usual (never bypassed), nothing is pushed, amended or forced, paths are validated to stay inside the project, and a failed commit (for example a hook failure) rolls back the new branch and the staging it did. Commits use your own git identity. Committing is blocked during an unfinished merge, rebase, cherry-pick or revert and for files with conflicts. The set of files accepted in review is kept in memory only: after restarting the app the dialog still lists every changed file, just without the pre-selection.
