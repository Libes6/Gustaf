# Chat

Part of the [M Code documentation](../README.md). Chat sessions, streaming, message actions, model comparison and appearance.

## Chat state and window controls

Visited chats keep separate messages, drafts, attachments, pending approvals and canvas state for the current app session. A new chat during generation opens its own empty draft; background requests continue in their original chat. Each composer's unsent text and attached images are also saved to the local database (debounced, a fraction of a second after you stop typing) and come back when you reopen the chat after a restart; sending a message clears the saved draft. A draft in a new chat that has not been sent yet is kept too (one per project, plus one without a project). Saved drafts are bounded: text is cut at 200,000 characters and at most 8 images are kept, each up to about 2.2 MB and about 6 MB in total; larger images stay attached in the open composer but are not restored after a restart. Recent chats appear first, with an expandable list.

Provider sign-in is verified by a small test request or a successful chat response, not by listing models. HTTP 401 marks the provider as requiring sign-in. Failed requests can be retried without duplicating the user message; a retry can use another provider. Completed steps are retained when continuing an interrupted request.

Canvas supports dragging the divider (or focusing it and pressing arrow keys) and exporting the selected revision as TSX through the native save dialog. The dedicated window header reserves space for macOS controls and supports dragging and double-clicking to toggle maximization.

Validation: `npm run check`, `npm run test:chat`, `npm run test:canvas`, `npm run tauri build -- --debug --bundles app`.

## Streaming robustness

The API providers (Anthropic, OpenAI Responses, OpenAI-compatible: OpenRouter, Gemini, Ollama, LM Studio, custom) retry transient failures with exponential backoff and jitter: HTTP 408/429/5xx, dropped connections, and error events inside a stream (for example Anthropic `overloaded_error`). Up to 4 attempts and 30 seconds of total waiting per request; `Retry-After` is honoured, and a longer one is shown to you instead of waited out. Stop cancels a pending wait immediately. A request is **never** retried once any text has been streamed to the chat: the error is shown and Retry continues the interrupted request from the completed steps, so nothing is duplicated. Errors are classified in the message: rate limit, quota or credits exhausted, authentication (401/403, not retried), network, provider server error. A refused connection (e.g. Ollama not running) is reported at once. The logic is in `src/providers/retry.ts` (pure, injectable fetch/sleep/clock) and `src/providers/sse.ts`; `TurnInput.onRetry` (also `RunOptions.onRetry`) reports each wait; the chat view shows "Retrying in 5s (attempt 2 of 4)…" in place of "Thinking…" while waiting. `tests/retry.test.mjs` covers the logic and `tests/providerRetry.test.mjs` runs the three adapters against a scripted fetch.

## Message actions and branching

Hover a message for its actions (all but copy are disabled while a reply is running):
- **Edit and resend** (your messages): edit the text inline and send again. The message and everything after it are replaced, and the project goes back to the checkpoint taken before that message when one exists (the same rollback as "Return to this point").
- **Regenerate** (last reply): re-runs the last request the same way.
- **Delete**: removes the message together with its reply (click twice to confirm); project files are not touched.
- **Branch from here**: creates a new chat, titled "<title> (branch)", with the history up to and including that message, and opens it. The original chat is unchanged.

## Model comparison

The rail menu (the "..." button), Compare models, opens a view that sends one prompt to 2 to 4 models at once. Pick models from the normal model list (any API provider or CLI provider such as Codex, Claude Code or Cursor Agent), write the prompt and press Run (Cmd+Enter). Every model answers in its own column, streamed as Markdown, with the elapsed time and a live token estimate that is replaced by the provider-reported counts when the answer finishes (the estimate stays if the provider reports none). Each column has its own Stop; a failed or stopped column can be run again, and errors use the same classification as the chat (rate limit, quota, authentication, network, server, with a note on whether running it again can help). Column order is the order you picked the models.

- Comparison runs are read-only: no tools, no file changes, no computer use (CLI providers are started with read-only access). Requests and provider-reported tokens are added to the Usage statistics like any other request.
- Nothing is saved. Answers exist only while the view is open; closing it cancels running requests and discards the text. "Continue in chat with this answer" on a finished column creates a normal chat (in the active project) containing your prompt and that answer, selects its model and opens it; this is the only thing stored.
- Budgets read provider usage from stored chat messages, so tokens of comparison answers that are not continued in a chat show in Usage but not in the budget gauge.

## Theme and keyboard shortcuts

Settings > General has an Appearance section: Light, Dark or System (follows the OS live) and an accent color (presets or any hex). Colors are CSS variables in `src/styles/theme.css`; `src/lib/theme.ts` sets `data-theme` and the accent variables on the root, and the choice is stored in the app settings (`theme`, `accent`). Pure logic (mode resolution, hex validation, contrast checks) is in `src/lib/themeUtil.ts`. Canvas artifacts are always rendered as a light document.

All shortcuts are defined in `src/lib/shortcuts.ts` and listed read-only under Settings > General: Cmd+, settings, Cmd+N new chat, Cmd+K search, Esc closes settings, Cmd+Shift+Esc stops the agent (global). App-level shortcuts always need Cmd so they never take text-editing keys from the composer. `npm test` covers both modules in `tests/theme.test.mjs`.
