# Memory

Saved facts that Gustaf carries across chats: project conventions, your preferences, decisions that should not be revisited.

## What is stored where

- **Facts** live in the local SQLite database, table `memories` (`project_root`, `text`, optional `source_chat`, timestamps). `project_root` is the normalised project folder; `NULL` means a global fact that applies to every chat. A fact is at most 2,000 characters; each scope holds at most 500.
- **Settings** (same database, `settings` table): `memoryEnabled` (default on: inject facts into prompts and offer the `remember` / `forget` tools), `memoryApproval` (default on: ask before the model changes memory), `memorySuggestAuto` (default **off**: suggest facts at the end of chats, see below).
- **Nothing else is written** unless you export to a project's `AGENTS.md` (below).

## What leaves the machine

- **Every model request** in a chat includes the relevant global and project facts (ranked by word overlap with your message, capped at about 12,000 characters, fenced and marked as untrusted data). They go to the provider you selected, like any other chat context. Turn memory off in Settings -> Memory to stop this.
- **Suggesting memories** makes one more model request that sends the text of the chat (see below). The cost note is shown in the dialog every time.
- **Export to AGENTS.md** writes into the project folder; if the project is a git repository the file may be committed and shared, which is why global facts are opt-in for the export.
- Do not put credentials into facts. Secrets are also scrubbed (best effort) from chat text before suggesting and from facts before exporting, but that is a safety net, not a guarantee.

## Editing memory

- **Settings -> Memory**: pick a scope (all chats or one project) and add, edit or delete facts.
- **Project menu -> Memory…** (sidebar, projects with a folder): the same editor in a dialog, listing the project's facts and the global ones, with a scope choice for new facts. Edit and delete act on the scope the entry is stored in. The dialog also has "Export to AGENTS.md…".
- **The model**: `remember` / `forget` tools in interactive main chats, with approval unless you switched it off.

## Suggest memories from a chat

- **Manually**: chat menu (sidebar) -> "Suggest memories from this chat". The dialog states the cost, then waits for you to press Suggest.
- **Automatically (opt-in)**: Settings -> Memory -> "Suggest memories at the end of chats", off by default. When on, after a run ends in the chat you are looking at, and only once the chat has at least 3 user messages (and again only after 5 more), Gustaf makes the same request and opens the dialog if it found something new. Failures stay silent in this mode; the manual action shows them. It never stores anything by itself.
- **The request** (`lib/memorySuggestRun.ts`, pure parts in `agent/memorySuggest.ts`): one tool-less, read-only turn on the cheap model from the agent settings (model routing, `lib/modelRouting.ts`), else the model selected in the composer; tokens count in usage and budgets. It carries only user and assistant text: tool calls and outputs, activities, images, expanded `@file` contents and attached chat references are left out; secrets are redacted; each message is clipped to 2,000 characters and the total to 30% of the model's context window (4,000 to 24,000 characters), newest messages first. The chat text is passed as JSON data and the system prompt says instructions inside it are data.
- **The answer** must be JSON (`{"facts":[{"text","scope"}]}`); it is parsed tolerantly (fences, reasoning blocks, text around it, a bare array, odd scopes), at most 5 facts of at most 240 characters, secrets re-checked (a fact still containing a redaction marker is dropped), duplicates dropped, and facts already saved are removed using normalised text (case, spacing, bullets and trailing punctuation ignored). A project fact needs a project; without one every fact is global.
- **The dialog** lists the facts with a checkbox, editable text and a scope selector (this project / all chats). Only ticked facts are stored, after you press the save button, with the edited text; each is checked against the saved entries once more at that moment. The source chat is recorded.

## Export to AGENTS.md

"Export to AGENTS.md…" (Settings -> Memory with a project selected, or the project dialog) writes the project's facts into a managed section of `<project>/AGENTS.md`:

```
<!-- gustaf-memory:start -->
## Project memory
...
- a fact
<!-- gustaf-memory:end -->
```

- A missing file is created; a file without markers gets the section appended after a blank line; a file with the markers has only the text between them replaced. Everything else, including line endings (CRLF is kept), is preserved byte for byte, and exporting twice changes nothing.
- Global facts are included only if you tick "Include global facts".
- The dialog shows the full resulting file; nothing is written until you press "Write AGENTS.md". The write goes through the existing project-confined `fs_write` command (paths outside the project are refused). If the file or the facts changed after the preview, nothing is written and the new text must be confirmed again.
- Refused without touching the file: unbalanced or duplicated markers; an `AGENTS.md` that cannot be read back completely (larger than the 64 KiB instruction reader cap, not valid UTF-8, a directory, a link out of the project).
- Facts cannot contain the markers (`<!--` / `-->` are neutralised). The text between the markers is replaced on the next export, so keep hand-written notes outside it.
- Import from `AGENTS.md` into memory does not exist. Gustaf already reads `AGENTS.md` as a project instruction file (see [rules and instructions](rules-and-instructions.md)); an exported section is therefore also read back as instructions, which is intended.

## Limits

Real model answers for suggestions were not evaluated; quality depends on the model. The automatic mode counts attempts per app session only.
