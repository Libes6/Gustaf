# Subagents audit (Codex rollout view, Claude Code Task view, our own subagents)

Trigger: the "Background tasks" column during a Codex chat showed six cards under "Running" (`/root/context_resume`,
`/root/branching_resume`, `/root/queue_resume` and the originals `/root/context`, `/root/branching`, `/root/queue`), ticking
for 15 to 17 minutes with a Stop button each, while the assistant itself said the first three had been stopped.

Method: read the code, read the real Codex rollout files of that chat (structure only, nothing copied into the repo), and
ran the scanner (`codex_agents::scan_in`) read-only against the real parent file with the start time and "now" of each of
the three parent turns. Synthetic fixtures for the tests carry only ids, event types and timestamps.

Status legend: **Confirmed** (reproduced with real data or by a test), **Suspected** (read from code, not reproduced),
**Not a bug**. "Fixed" means fixed on this branch with tests; "Proposed" means a task with acceptance criteria below.

## What the real rollouts show

One parent thread (`...e13d06`) with three turns (Gustaf runs `codex exec resume` per chat message, the thread id stays):

| Turn | Parent events | What happened |
|---|---|---|
| 1 | `task_started` 17:04:36, `task_complete` 17:06:04 | spawned `queue`, `branching`, `context` (each `spawn_agent` call is answered by a `function_call_output` whose `task_name` is the full path, e.g. `/root/queue`). The turn ended after 88 s with the children still working. |
| (children) | | each child file: two `task_started` (the first is copied parent history, below `subagent_history_start_ordinal`), then `turn_aborted` with `reason: "interrupted"` at 17:06:05, one second after the parent's `task_complete`. |
| 2 | `task_started` 17:06:33, **no terminal event** | spawned `queue_resume`, `branching_resume`, `context_resume` (new threads, `fork_turns` set, new `agent_path`s: these are new agents, not resumes of the old threads). The turn was cut (Gustaf run stopped); neither the parent nor any child wrote an end for it. |
| 3 | `task_started` 17:21:54, `task_complete` 17:23:15 | `list_agents` returned only `/root`. The screenshot was taken during this turn. |

Control tools in all 63 rollout files of 2026-10-03/04: `spawn_agent`, `wait_agent`, `send_message`, `followup_task`,
`list_agents` occur; `close_agent`, `interrupt_agent` and `resume_agent` never occur, so their argument and output shape
could not be verified.

Scanner output on the real files before the fix (start = turn start, now = shortly after):

- turn 1, final scan: the three originals `failed` (from `turn_aborted`), the three `*_resume` threads already visible.
- turn 2, mid-turn: the three originals as **`starting` cards without a thread** (no nickname, no end), the three `*_resume` fine.
- turn 3, mid-turn: **all six as `starting` cards without a thread**, started at the spawn call times (17:05:28 ... 17:07:24).
  This is exactly the screenshot (six "running" cards, titles = task paths like `/root/queue`, times counting from the spawn call).

After the fix: turn 1 shows the originals as `stopped`, turn 2 shows only the live `*_resume` cards, turn 3 shows no ghosts.

## Findings

### (a) Why interrupted or closed agents stay "running"

1. **Ghost "starting" cards from earlier turns. Confirmed, fixed.** `scan_in` reads the parent rollout from byte 0 on
   every scan, so every `spawn_agent` call of the whole thread is in `spawns`. A child file that is older than this run
   (`mtime < start - 5 s`) is filtered out of the candidate list, so its spawn is never "claimed" and the leftover loop
   emits it as a pending agent (`state: "starting"`, `startedAtMs` = the spawn call time). The TS side maps `starting`
   to `running`, the card id is the same as the finished card of the earlier turn, so the finished/ended card was
   overwritten by a running one that ticks from the spawn time and never ends (no file will ever give it an end).
   Fix: a spawn whose call time is before `start - 5 s` and has no claiming child is dropped.
2. **Children without a terminal event. Confirmed, fixed.** Codex writes `turn_aborted` into the children one second
   after the parent's turn ended, but only if the process is still alive; a killed run (turn 2) writes nothing, and the
   final scan can run before the one-second-later abort lines exist. Fix, Rust: when the parent's own latest turn has a
   terminal event (`task_complete`, `turn_aborted`, `error`, shutdown), every direct child still `starting`/`running`
   and every pending spawn is `stopped` with the end time of the parent's turn; a child whose file has had no event
   since before this run began (an earlier turn's) is `stopped` at its last event. Fix, TS: `RolloutTracker.finish()`
   returns every agent still running as `stopped` (also when the run was stopped and no final scan ran), so the process
   being gone is enough. (`finishCliAgents` already turned leftovers into "ended" at the end of the chat run; the
   screenshot shows what happens before that, during a turn, which is where the ghosts lived.)
3. **`close_agent` / `interrupt_agent` / `resume_agent` / `list_agents` are not interpreted. Confirmed (code), not
   fixed.** They are only in `CONTROL_TOOLS` so they are not counted as the agent's own tool use. The real `list_agents`
   output is `{"agents":[{"agent_name":"/root","agent_status":"running"}]}` (only agents that are live), which would be
   an authoritative "who is running now" signal. Not implemented because there are no real samples of the close and
   interrupt shapes. See proposed task P1.
4. **"Resumed agents create a second card". Not reproducible as stated.** `*_resume` are new threads with new paths
   spawned by the model; they are legitimately separate agents. A real follow-up (`send_message` / `followup_task` to an
   existing agent) appends a new `task_started` to the same child file and already keeps the same card (state goes back
   to `running`; covered by a new test). What can duplicate a card is two thread files with the same parent and
   `agent_path` (a re-spawn after a close): fixed, they are one card (newest thread, keeps the card key of the spawn
   call so the card on screen is the one that goes on).
5. **Stale files matched to the current run. Not reproducible** for child files (they are only matched through the
   parent chain and the mtime window). The inverse case, stale spawns, is (1).

### (b) `turn_aborted: interrupted` as "failed". Confirmed, fixed

A child interrupted because the parent's turn ended is not an error, but the scanner mapped `turn_aborted` to `Life::Error`
and "failed" ("Ошибка", red). Also `CollabAgentStatus: interrupted` from the JSON stream mapped to `failed`. Now both are
the neutral `stopped` state (grey chip "Stopped" / "Остановлен", counted as "N stopped" in the Subagents card head, not in
the running badge, never a red error). `error` events still mean `failed`. The `turn_aborted` end time and duration now come
from the event's own `completed_at` / `duration_ms`.

### (c) Titles. Confirmed, fixed

The function-call output sets `task_name` to the full path (`/root/queue`), and a pending card has no nickname, so the
title was the raw path. Titles are now the task as words (`/root/queue_resume` becomes "queue resume"), the nickname goes to
the secondary (role) line, the short thread id is the last resort. A path never appears as the title.

### (d) Elapsed format and count badge. Suspected (format), Not a bug (badge)

- `elapsed()` prints `m:ss` (`15:27`) and `h:mm:ss`; next to "Agent · Codex" `15:27` reads like a clock time. Nothing is
  wrong in the arithmetic (it counted from the spawn call time, which is the ghost bug). Proposed task P4 for a unit.
- The badge counts `runs + cli agents` in state `running`/`waiting`; ghosts were counted, hence 6. `stopped` and `ended`
  are not active, so the badge now excludes them (UI test added).

### (e) Parent turn end. Confirmed gap, fixed

Rust: all non-terminal children and pending spawns of the parent become `stopped` once the parent's latest turn ended.
TS: `finish()` settles whatever is still running (including after a user stop, where there is no final scan).
Existing safety net kept: `finishCliAgents(chatId)` marks leftovers "ended" when the chat run finishes.

### (f) Claude Code Task card "P1: attach chats as context", 0:07, 2 tool calls. Suspected, not reproduced

The mapping is: `tool_use` named `Task`/`Agent` becomes the card (title = `description`), events carrying
`parent_tool_use_id` add one to the tool-use counter and set the step, the matching `tool_result` completes it. A 7 s
card with 2 tool calls is plausible for a short explore. The one real risk: when the Task is started with
`run_in_background: true` the `tool_result` is only the launch acknowledgement, and today it would complete the card at
once (the real result arrives later as a separate message that is not mapped). No Claude event samples exist on this
machine to confirm either way. Proposed task P2.

### (g) "Ожидают применения · 2" with `+0 −0`. Confirmed (misleading), not fixed

The chip count is the number of files in the pending review copies of this project (`review.list(root)`, files that agents
changed in their shadow copies and that are not applied yet). The `+N −N` in the branch row below is `git diff --shortstat
HEAD` of the project working tree (`projectGit`), which neither includes those unapplied copies nor untracked files.
So "2 pending, +0 −0" is consistent (pending files live in a shadow copy; the real tree is clean), but the two numbers
describe different things and sit together without saying so. Proposed task P5.

### (h) Our own subagents (`spawn_agent`, `delegate_tasks`). Not reproducible

Read: a parent abort aborts every child (`onParentAbort`), a queued run cancelled gets `cancelled`, `finally` paths write a
terminal status, and on startup `loadStoredRuns` marks runs that are `queued`/`running` in SQLite and not live in this
session as `interrupted` (table and memory), with tests in `tests/agentRuns.test.mjs`. No stuck-running path found.

### (i) Stop on a CLI-native card. Confirmed

The square button of a Codex/Claude card calls `i.stop`, which is the abort controller of the whole chat run
(`useChatRun`: `stop: () => ctl.abort()`): it kills the CLI process and so every agent of the run. The promise is only in
the tooltip (`agentsStopCli`: "Stops the whole Codex run, not just this agent."); the accessible name is just "Stop".
A per-agent stop is not possible with `codex exec` (no control channel). Not changed (existing tests pin the label and
tooltip); proposed task P3.

## Fixed on this branch

- Rust `codex_agents.rs`: `Life::Aborted` and state `stopped` (neutral); `error` stays `failed`; parent-turn-ended and
  earlier-turn rules; stale spawns are not pending; one card per `(parent, agent_path)` with the spawn card key.
- TS `codexRollout.ts`: `stopped` mapping, readable titles (`humanTask`), nickname as secondary line, `finish()` settles
  running agents as `stopped`. `activities.ts`: `interrupted` is `stopped`; `stopped` is terminal with activity status
  `unknown`. New `SubagentState` value `stopped` (types.ts), UI label and head count (SubagentsCard, AgentsPanel,
  `.subagent-chip.stopped`), i18n `subagentStopped`, `subagentsStoppedCount` (en, ru).
- Tests: 8 new Rust tests (`codex_agents::tests`), 5 new and 6 adjusted node tests (`tests/codexRollout.test.mjs`),
  2 new UI tests (`AgentsPanel`, `SubagentsCard`) and 1 adjusted.

## Proposed tasks (not done: uncertain or larger)

**P1. Interpret `close_agent`, `interrupt_agent`, `resume_agent`, `list_agents` from the parent rollout.**
Needs a real rollout that contains each call (none on the audited machine; capture one with a prompt that closes and
interrupts an agent). Acceptance: the shapes are written down in `docs/features/agents.md` with the Codex version; a
child that the parent closed or interrupted is `stopped` (or `completed` if it had reported) from the moment the call
is answered, without waiting for the parent's turn to end; `list_agents` output marks agents not listed as live as
`stopped`; synthetic fixtures for each call in `codex_agents::tests`; unknown shapes only add a `notes` entry.

**P2. Claude Code background Task.** Acceptance: capture a real stream-json run with `run_in_background: true`; a launch
acknowledgement does not set `completed`; the card stays running until the real result arrives (or becomes "ended" with
the run); node test with the captured structure; a normal foreground Task is unchanged.

**P3. Honest Stop on CLI-native cards.** Either relabel the button visibly ("Stop run") with the tooltip as is and a
matching `aria-label`, or hide it on cards and keep one run-level stop. Acceptance: the accessible name states that the
whole run stops; updated UI test; no per-agent promise anywhere.

**P4. Elapsed time unit.** Acceptance: `elapsed()` output is unambiguous next to the type line ("15 min 27 s" style or a
tooltip with the start time), both languages, `agentRuns.test.mjs` and UI tests updated.

**P5. Pending-changes chip vs branch totals.** Acceptance: the chip shows the added/removed lines of the pending review
copies (or the branch row says what it counts), `+0 −0` is never shown next to a non-zero pending count without
explanation; test with one pending new file and a clean tree.

## What can only be verified in a real Gustaf + Codex run

- That the last scan of a turn races Codex's one-second-later `turn_aborted` writes as described (the data and the timing
  fit; the fix does not depend on it).
- Whether a killed `codex exec` (Stop) always leaves children without an end event; the stopped-by-parent rule covers it.
- The look of the "Stopped" chips and the new head count in the real window, and the six-card scenario end to end
  (three turns, interrupt, resume) in the Background tasks column.
