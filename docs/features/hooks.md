# Hooks

Hooks are user-defined shell commands that run on agent lifecycle events, modelled on Claude Code hooks. They run only for **API-provider agent runs** (the loop in `src/agent/agent.ts`: main chat, subagents and scheduled prompts). CLI providers (Claude Code, Codex, Cursor) keep their own hooks and are not touched.

## Where hooks come from

| Source | Location | Trusted |
| --- | --- | --- |
| Global | app settings (key `hooks`), edited in Settings > Git and commands > Hooks | always |
| Project | `<project>/.gustaf/hooks.json`, read-only for the app | only after the user turns on "Run hooks from this project's .gustaf/hooks.json" for that project (default **off**, shown with a warning that hooks run shell commands) |

A project set up before the rename to Gustaf may keep `.mcode/hooks.json`; it is read when `.gustaf/hooks.json` does not exist.

The effective list is global hooks first, then the project's when enabled. The Settings viewer shows each effective hook with its source and timeout, and lists every skipped entry with the reason. Scheduled runs follow the same rule: project hooks need the per-project switch. The switch is stored per project in the `hooksProjects` setting.

## Schema

```json
{
  "hooks": [
    { "event": "post_edit", "matcher": "edit_file|write_file", "command": "npm test --silent", "timeoutMs": 30000 },
    { "event": "pre_tool", "matcher": "run_command", "command": "./.gustaf/block-rm.sh" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `event` | `pre_tool`, `post_tool`, `post_edit`, `stop`, `approval_request` |
| `matcher` | optional, default `*`. Alternatives separated by `|`; each is a glob (`*`, `?`) that must match the whole tool name, case-sensitive: `edit_file|write_file`, `run_command`, `mcp__*`, `mcp__github__*`. Ignored for `stop`. For `approval_request` the name is `run_command` for command approvals, `mcp__<server>__<tool>` for MCP, `read_terminal`, `remember`, otherwise the request kind |
| `command` | required, non-empty, at most 2000 characters |
| `timeoutMs` | optional whole number from 100 to 60000, default 10000 |

At most 20 hooks per file are used. Validation never throws: an invalid entry (bad event, empty command, timeout out of range, wrong types), entries over the cap, a file that is not `{ "hooks": [...] }`, invalid JSON or a file over 64 KB is skipped and listed in the viewer, and the run goes on without it.

## Execution

- Every hook command is judged by the same command rules as the agent's own `run_command` (`src/agent/rules.ts`, built-in protections included, access mode included). A **deny** (or read-only access) means the hook is not run; it is logged as blocked and, for `post_tool`/`post_edit`, noted in the tool result. A command that rules say to **ask** about asks the user through the normal approval card (reason mentions the hook), so a hook never bypasses approval: add a rule or use "Always allow" for hook commands you trust. An `approval_request` hook that would need approval is skipped instead of stacking a second card.
- The command runs through `run_hook` (`src-tauri/src/hook_exec.rs`): the platform shell in the run's folder, JSON on stdin, hard timeout (at most 60 s) after which the **whole process tree is killed** (process group on Unix, `taskkill /T` on Windows). The environment is scrubbed to a short allowlist (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, ...) plus exactly `GUSTAF_EVENT`, `GUSTAF_TOOL`, `GUSTAF_PROJECT`; no API keys or other secrets are passed (the user's own login-shell profile still runs, as for `run_command`).
- A hook never overlaps with itself: while a run of the same command for the same event and folder is going, another trigger is skipped and logged as such.
- A hook that cannot run, crashes or times out never fails the agent run.

### Input

stdin is one JSON document: `event`, `tool`, `input` (tool input, long strings cut, capped at 4000 characters, otherwise `{ "truncated": true, "preview": "..." }`), `project`, `root` (the run folder, a review copy for writable projects), `chatId`, and for `post_tool`/`post_edit`/`stop` a `result` summary (first 1000 characters of the tool output, or of the last assistant text for `stop`).

### Events and exit codes

| Event | When | Exit 0 | Exit 2 | Other non-zero / timeout |
| --- | --- | --- | --- | --- |
| `pre_tool` | before a tool call (not computer actions) | continue | **blocks** the call; the output is returned to the model as the result: `blocked by hook: ...` | logged as a failure, does not block |
| `post_tool` | after a tool call that succeeded | non-empty output (first 2 KB) is appended to the result | appended as a warning | appended as a warning |
| `post_edit` | after `edit_file` / `write_file` succeeded (after `post_tool` hooks) | as `post_tool` | as `post_tool` | as `post_tool` |
| `stop` | once when the agent finishes a turn (not for subagents) | nothing | the output is sent back as a follow-up user message, **once per turn** (afterwards stop hooks do not run again) | logged only |
| `approval_request` | when an approval card is shown | fire-and-forget (notifications); never waits for the user | logged only | logged only |

## Visibility

Every hook run is an entry in the action log (`src/agent/actionLog.ts`) with `source: "hook"`, the event, command, exit code, duration and truncated output (`detail`, secrets scrubbed), shown in Settings > Action log like other entries. Status: `success` (exit 0, or exit 2 where that is the answer: `pre_tool`, `stop`), `error` (other codes, timeout, runner failure), `blocked` (rules), `declined` (approval refused), `cancelled` (skipped: still running, or needs approval). A tool call stopped by a hook is logged as `blocked` with the hook's message.

## Example

Run the tests after every edit and refuse `rm` through the agent. Save as `<project>/.gustaf/hooks.json` and switch project hooks on in Settings:

```json
{
  "hooks": [
    { "event": "post_edit", "matcher": "edit_file|write_file", "command": "npm test --silent 2>&1 | tail -n 20", "timeoutMs": 60000 },
    { "event": "pre_tool", "matcher": "run_command", "command": "cat | grep -Eq '(^|[^a-z])rm[[:space:]]' && { echo 'rm is not allowed in this project'; exit 2; }; exit 0" }
  ]
}
```

Both commands must also be allowed by your command rules (or approved when asked).

## Code and tests

- `src/agent/hooksCore.ts`: schema, matcher, payload, exit-code interpretation (pure).
- `src/agent/hooksStore.ts`: loading global/project hooks, the per-project switch.
- `src/agent/hooks.ts`: running hooks (rules, approval, locking, action log); wired into `runLoop` in `src/agent/agent.ts`.
- `src-tauri/src/hook_exec.rs`: process execution (stdin, env scrub, timeout, tree kill); Rust unit tests.
- `src/components/HooksSettings.tsx`: viewer, switch, global editor.
- Tests: `tests/hooks.test.mjs` (node:test; the command runner is faked in `tests/helpers/apiStub.mjs`), `tests/ui/Hooks.test.tsx` (vitest).

Not covered: nothing has been exercised in the real app against a real hook command beyond the Rust unit tests.
