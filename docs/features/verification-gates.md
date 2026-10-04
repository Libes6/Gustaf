# Verification gates

A verification gate runs a project's required checks (a "definition of done") when an agent finishes a task in which it edited files. A failing check sends its output back to the agent to fix, a bounded number of times; the run only counts as done when the checks pass.

Scope: **API-provider agent runs** (the loop in `src/agent/agent.ts`: main chat, `general` subagents and scheduled prompts). CLI providers (Claude Code, Codex, Cursor) have their own loops and are out of scope: no gate runs for them.

## Where the checks come from

| Source | Location | Trusted |
| --- | --- | --- |
| Project settings | app settings, key `verification:<project path>`, edited in Settings > Git and commands > Definition of done | always |
| Project file | `<project>/.mcode/done.json`, read-only for the app | only after the user turns on "Also run the checks from this project's .mcode/done.json" for that project (default **off**, shown with a warning that the checks run shell commands) |

The effective list is the settings checks first, then the project file's when its switch is on (at most 10 in total). The switch is stored in the project's settings entry (`useProjectFile`). Scheduled runs follow the same rule. For a workspace (git worktree) chat the settings belong to the project, not to the worktree folder: the chat passes its project root to the run (`RunOptions.project`).

```json
{
  "checks": [
    { "name": "types", "command": "npx tsc --noEmit", "timeoutMs": 120000 },
    { "name": "tests", "command": "npm test", "timeoutMs": 300000 }
  ],
  "maxFixAttempts": 2
}
```

| Field | Rules |
| --- | --- |
| `command` | required, non-empty, at most 2000 characters |
| `name` | optional string, at most 60 characters; default is the start of the command |
| `timeoutMs` | optional whole number from 1000 to 600000, default 120000 |
| `maxFixAttempts` | optional whole number from 0 to 5, default 2. In the project file it counts only while the file's switch is on |

Validation never throws: an invalid entry is skipped and listed in the editor, and the run goes on without it. A file over 64 KB, invalid JSON or a file that is not `{ "checks": [...] }` is ignored as a whole and listed.

The editor's "Suggest checks" button pre-fills rows from the diagnostics auto-detect (an installed `typecheck` / `check:types` / `lint` npm script, else the installed TypeScript binary) plus the project's own `lint` and `test` scripts. It only fills the form; nothing is run until you save and an agent finishes a task.

## When a gate runs

- When the model stops calling tools (a turn ends) and the run **edited files** since the last passing gate (a successful `edit_file` / `write_file`; a command is not an edit). Runs that did not edit files skip the gate. One gate cycle per stop, not per tool call.
- Never in Plan or Ask mode, with read-only access, for models without tools, or for subagent types that cannot edit (`explore`, `plan`, `review`). A `general` subagent runs its own gate with the same limits, in its private copy.
- Order at a stop: queued clarifications first, then the `stop` hooks (see [hooks](hooks.md); a stop hook that asks the agent to continue wins and the gate waits for the next stop), then the gate.

## Execution

- Checks run **sequentially** in the run's folder (the review copy or workspace worktree the run uses) and stop at the first one that does not pass.
- Every check command goes through the same command rules and approvals as `run_command` (`decideCommand`, built-in protections and the access mode included). A **deny** means the check is not run and is reported ("blocked"); a command that rules say to **ask** about shows the normal approval card (reason mentions the verification check). A blocked or declined check cannot be fixed by editing code, so it is not sent to the agent: the run ends as failed verification and the gate is not attempted again in that run.
- Each check has a timeout; a timeout counts as a failure. Output is stripped of escape codes, secrets are redacted and it is clipped (6 KB per check in the card, 3.5 KB in the message to the agent, keeping the start and more of the end).
- **No hooks recursion:** gate commands run directly and never fire `pre_tool` / `post_tool` / `post_edit` hooks. (An approval card shown for a check is a normal approval card and fires `approval_request` hooks like any other.)

## Fix loop and stop conditions

1. A check fails: the agent gets a user message "Verification failed: the required check ... exited with code N ... Output: ... Fix the problem and re-run the check yourself" and the loop continues. After it stops again the gate runs again (if files were edited, or the last gate failed).
2. At most `maxFixAttempts` such fix attempts (default 2, so at most 3 gate runs). After the last failure the run ends as **failed verification** with the last output: no further turns.
3. **Kill criteria:** if the same failure signature (check name plus the first failing line, lower-cased with numbers, timings and hex values flattened) occurs 3 times in a row, the run stops early even if attempts remain, and the card shows "Try another model": text plus a button that opens the model picker. Nothing is re-run automatically.
4. All checks pass: the run finishes normally and the turn shows "Checks passed (N)".

`runAgent` returns `{ verification?: { outcome, reason?, summary } }`; `runChatCore` passes it on, and a failed verification of a `general` subagent is added to the subagent run's warnings.

## Visibility

- **Action log:** every check run is an entry with `source: "gate"`, `tool: "gate"`, the check name, command, exit code (or timeout), attempt, duration and clipped output (`detail`), shown in Settings > Action log. Status: `success` (exit 0), `error` (failed, timed out), `blocked` (rules), `declined`, `cancelled`.
- **Verification card:** the gate result is stored as an `activity` part (`name: "verification"`, `args.report`) appended to the agent's last message of the cycle, so it is persisted with the turn and the final text stays the last message. `src/components/VerificationCard.tsx` renders it like a tool card (per check: name, passed or failed, duration, expandable command and output) and the live card while the gate runs. `TurnView.tsx` and `LiveStatus.tsx` have one render hook each. Providers ignore the part when the history is replayed.

## Code and tests

- `src/agent/verificationCore.ts`: schema, effective list, failure signature, clipping, feedback text (pure).
- `src/agent/verificationStore.ts`: per-project settings, the read-only file, suggestions.
- `src/agent/verification.ts`: the gate (rules, approval, execution, action log, fix loop state); wired into `runLoop` in `src/agent/agent.ts`.
- `src/components/VerificationSettings.tsx`, `src/components/VerificationCard.tsx`, `src/styles/verification.css`.
- Tests: `tests/verification.test.mjs` (node:test; the command runner is faked in `tests/helpers/apiStub.mjs`), `tests/ui/Verification.test.tsx` (vitest).

Not covered: nothing has been exercised in the real app against real check commands or a real model; the project-root plumbing for workspace chats (`useChatRun`) is covered only by type checking.
