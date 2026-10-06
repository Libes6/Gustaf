# Plan mode (Ask / Plan / Agent)

A segmented control in the composer (`role="radiogroup"`, label "Chat mode", arrow keys move the selection) sets how the main chat's agent behaves. The mode is stored per chat in the `settings` table under `chatModes` (`{ "<chatId>": "ask" | "plan" }`; Agent is the absence of an entry, so existing chats stay in Agent mode and nothing is migrated). A new chat keeps its pick in memory and stores it when the first send creates the chat (`src/lib/useChatMode.ts`, `src/agent/chatModeStore.ts`).

| Mode | Tools | System prompt |
| --- | --- | --- |
| Ask | none | answer from the conversation only |
| Plan | `read_file`, `list_dir`, `search` (the `plan` subagent allowlist, `TYPE_TOOLS.plan`) | research, then END with a plan block |
| Agent | everything (current behaviour) | unchanged |

Enforcement is in `src/agent/agent.ts`, not only in the offered tool list: `runTool` refuses any call outside `modeAllowsTool(mode, name)` with `Blocked: Plan mode is read-only...` (logged as `blocked`), the same way the read-only access mode refuses write tools. In Ask/Plan there is also no MCP toolset, no Computer Use (calls are blocked, the prompt does not advertise it), no `spawn_agent` and no review copy of the project. Subagent runs (`toolNames`) and scheduled runs (`source: "scheduled"`) ignore the mode and keep their own limits.

## Plan block

Pure logic lives in `src/agent/planCore.ts` (tests: `tests/planMode.test.mjs`). The agent ends its reply with one fenced block:

````
```gustaf-plan
{"title":"Short title","steps":[{"id":"1","text":"What to do","files":["src/a.ts"]}],"risks":["optional"],"questions":["optional"]}
```
````

Chats from before the rename to Gustaf contain `mcode-plan` blocks; they are still shown as plan cards.

The last valid block of a reply wins. Steps may also be plain strings; ids are renumbered. A block that is not valid JSON or has no usable step is left as ordinary Markdown.

## Plan card

`TurnView` renders a valid block as a checklist card (`PlanCard`):

- **Approve** switches the chat to Agent mode and sends `planToInstruction(plan)` ("Approved plan: <title>", numbered steps with files, risks) as the next user message.
- **Edit** makes title and steps editable inline (edit, move up/down, remove, add); Approve then sends the edited plan.
- **Reject** keeps Plan mode and focuses the composer so the user can give feedback.

Buttons appear only on the latest turn while no run is active; older plans are shown read-only.

## CLI providers

The mode is passed to the CLI adapters as `TurnInput.mode`; flags are built in `src/providers/cliArgs.ts` / `claudeCli.ts`. Verified against `--help` on this machine (2026-10):

- **cursor-agent**: Plan `--plan` (shorthand for `--mode=plan`), Ask `--mode ask`. They replace `--force`.
- **Claude Code**: Plan and Ask `--permission-mode plan` (Claude has no separate Ask mode; the system prompt adds the Ask wording).
- **Codex**: Plan and Ask `--sandbox read-only` (or `-c sandbox_mode="read-only"` when resuming), even if access is "Full access". Codex has no native plan mode (assumption: the bundled `codex exec --help` lists only the sandbox policies).

The CLIs have their own tools, so the mode prompt (plan block format) travels in the system text that `resumePoint` puts in front of the prompt of every turn. None of this was run against the real CLIs (no model requests were made).
