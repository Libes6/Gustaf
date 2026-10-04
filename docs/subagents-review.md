# Subagents and orchestration review (hardening pass)

Scope: `spawn_agent` / `delegate_tasks` runtime after the merges that added CLI providers as subagents, verification gates
for `general` subagents, the merge resolution in `subagents.ts`, and the `stopped` state of Codex-native subagents. Code
read: `src/agent/subagents.ts`, `cliSubagentCore.ts`, `subagentCore.ts`, `orchestrator.ts`, `scheduler.ts`,
`agentRuns*.ts`, `agent.ts` (gate and hook part), `lib/subagentWorktrees.ts`, `lib/worktrees.ts`, `src-tauri/src/worktree.rs`
(create), `src-tauri/src/proc_tree.rs`, `providers/cli.ts` (`spawnLines`, read only), `agent/cliAgents.ts`,
`lib/chatRunCore.ts`, `lib/useBackgroundTasks.ts`, `components/AgentsPanel.tsx`, `SubagentsCard.tsx`. See also the earlier
`docs/subagents-audit.md` (Codex rollout view).

Legend: **Confirmed** (reproduced by a test that failed before the fix), **Risk** (read from code, plausible, not fixed),
**Fine** (checked, no change needed). Line numbers are for this branch.

## Confirmed bugs, fixed on this branch

1. **A task stopped after it got its slot still prepared its directory and could start the CLI.**
   `subagents.ts` `execute()` awaited the budget check and then went straight to `updateRun(running)`, the shadow copy or
   worktree, and the CLI. Scenario: Scheduler(1), the user presses Stop (or the parent stops) while a queued task's turn
   comes up and its `checkBudget` is pending: a `gustaf/…` worktree is created (and its setup command offered) for a
   cancelled task. Fix: `subagents.ts:262` ends such a run as `cancelled` before anything is prepared.
   Test: `cliSubagent.test.mjs` "a parent stop that lands after the slot was granted…".

2. **A CLI task stopped while its worktree was being created left an empty worktree and branch behind.**
   `executeCli()` always called the adapter after `worktreeHost.create`; the abort was seen only there, and the untouched
   worktree stayed (the cleanup setting is off by default). Fix: `subagents.ts:488` skips the CLI when already aborted
   and removes the untouched worktree of a task that never launched (non-forced remove; a touched or unreadable one
   still stays). Test: "stopped while its worktree is being created…".

3. **Unknown worktree state counted as untouched.** `lib/subagentWorktrees.ts` `inspect`: when `worktrees.list` failed
   (or the checkout was missing from it) `committed` and `dirty` were false, so a checkout with commits but no diff
   could be offered for removal. Now a checkout without status counts as touched. Test: "gitSubagentWorktrees.inspect…".
   (The Rust remove is non-forced, so this was a second line of defence, not data loss on its own.)

4. **A general API subagent that ran out of steps right after verification-gate feedback was reported `completed`.**
   The step-limit detection (`subagents.ts:375`) only looked for a trailing tool result; gate feedback is a user
   message. Scenario: `maxSteps: 2`, edit, stop, gate fails, feedback, loop ends: the run said "finished" with a
   "Failed verification" warning instead of "stopped at its step limit". Fix: any trailing non-assistant message at the
   step limit is a `steps` breach. Tests: "a general subagent runs the project gate…" (also covers the merged end-of-run
   block: the API path still runs gates and records the warning on the run and in the report) and "a subagent that runs
   out of steps right after gate feedback…".

5. **Process-tree kill could miss a respawned child** (`proc_tree.rs`). The tree was killed deepest first while the
   parents were still running, so a shell loop or a CLI restarting its tool could start a new child between `ps` and
   the parent's SIGKILL; that child was reparented to launchd and survived. Now the tree is frozen with SIGSTOP
   (parents first, re-reading the table up to 5 times) and then SIGKILLed. Test:
   `a_parent_that_restarts_its_child_leaves_nothing_behind` (the race window is small, so this is a regression guard
   rather than a reliable reproduction of the old failure).

6. **CLI-native agents cut off by the user's Stop showed as "ended"** (`cliAgents.ts` `finishCliAgents`, called from
   `chatRunCore.ts`). "Ended" means the CLI never reported a result; for a user stop the honest state is "stopped",
   which Codex rollouts already use. Now `finishCliAgents(chatId, now, stopped)` gets `signal.aborted`. Test in
   `cliAgents.test.mjs`.

## Checked and fine

- **End-of-run block in `subagents.ts`**: `finish` runs exactly once on every path: queued-cancel and unexpected throws in
  `runTask`'s catch; budget-not-started, cancelled-before-start, prepare failure and the normal end inside `execute` /
  `executeCli`, each followed by `return`. The CLI path returns from `executeCli` before the API block, so it never
  double-finishes. `updateRun` drops the stopper on the first terminal status.
- **Cancellation**: parent abort reaches each child through its own controller (`runTask`), queued children are removed
  by the scheduler (AbortError → `cancelled`), `runPlan` marks unstarted tasks `cancelled` and waits for running ones,
  retry backoff wakes on abort. `spawnLines` throws on a pre-aborted signal and kills on a late one (`killTree` →
  `process_kill_tree` then `child.kill()`).
- **Concurrency**: one global `Scheduler`; `runPlan` additionally limits to `scheduler.concurrency` and to ownership
  conflicts; retries go through the scheduler again. Mixed providers share the same slots.
- **Dependencies and retries**: `runPlan` stores a task's outcome only after `runWithRetries` returns, so dependants wait
  for the retry, not the first failure; `cancelDependents` (setting or argument) skips transitively; quota / rate limit
  / sign-in failures move along `fallbackProviders` (`chainIndex`). Limit, budget and cancel are not retried.
- **Budgets**: per-run time / steps / tool calls / tokens; day/chat budget at every API step and at most every 5 s of CLI
  activity; CLI tokens checked after the run (`limit`). No path leaves a run `running` once `execute` returns.
- **Persistence**: active rows from an earlier session load as `interrupted` and are marked so in SQLite; messages per
  run are capped (`MAX_MESSAGES_PER_RUN`), in-memory steps bounded (`appendStep`), runs bounded to 200.
- **Worktrees**: created only for writing types on a CLI runner; branch names unique under parallel tasks
  (`STORE_LOCK` in `worktree.rs` serializes `unique_branch` + `worktree add`; task ids are random); a failure after
  `git worktree add` (meta write) is rolled back in Rust; setup failures are best effort; removal is non-forced and only
  for untouched checkouts (setting, replaced failed attempt, or never launched).
- **Read-only types**: API path passes `toolNames` (read_file, list_dir, search) and `access: "readonly"`; the tool
  call is refused in `agent.ts` even if a model calls another tool. CLI path: `cliAccess` gives `readonly` for read-only
  types or a read-only parent, otherwise at most `auto`, never `full`. Subagents never get `spawn_agent` (no `subagents`
  host passed to the child loop).
- **Background tasks panel**: badge counts own `queued`/`running` runs plus CLI-native `running`/`waiting`; Stop on an
  own card stops that run only (`stopRun`), on a CLI-native card it stops the whole chat run (the label says so).

## Risks (not fixed; proposed tasks)

R1. **Setup approval can block a task with no timeout.** `prepare` / `worktreeHost.create` ask `parent.approve` for the
  setup command before the run's time limit starts (`subagents.ts` `execute` / `executeCli`). If the approval card is
  never answered the run stays `running` until the parent is stopped. *Acceptance*: the time budget (or a separate
  setup timeout) covers directory preparation; an unanswered setup approval ends the run as `limit` with a clear reason.

R2. **CLI day/chat budget is only checked on activity.** A CLI that thinks for minutes without tool activity is not
  checked until its time limit. *Acceptance*: a periodic budget check (e.g. every 10 s) while the CLI runs; test with a
  fake CLI that emits no activity.

R3. **API subagents do not get the parent's `chatId`** (`runAgent` call in `subagents.ts`), so hooks see no chat id for
  subagent tool calls. Passing it naively is unsafe: some adapters key sessions or caches on `chatId`, which could make a
  subagent resume the parent's session (provider layer, not changed here). *Acceptance*: hooks receive the chat id of a
  subagent's parent without the adapter seeing it; provider owners confirm `chatId` semantics per adapter.

R4. **A failed `general` CLI attempt with changes keeps its worktree, and the retry makes a new one.** By design (never
  delete work), but a plan with `retries: 2` can leave three branches. *Acceptance*: the merged summary lists every
  kept branch of a task, or the retry reuses the failed attempt's worktree after a user setting allows it.

R5. **The chat's Subagents card still shows "ended" after a user stop** (`SubagentsCard.tsx` `shownState`): the persisted
  activity has no stop marker. Panel cards are fixed (item 6). *Acceptance*: `chatRunCore` stores a stopped subagent
  activity as `subagent.state = "stopped"` on abort; card test.

R6. **SIGSTOP/SIGKILL by pid** can in theory hit a reused pid between `ps` and the signal (pre-existing; window of
  milliseconds, only descendants of the app are considered). No action proposed.

## What still needs a real multi-agent run

- A `delegate_tasks` plan with real Codex / Claude Code / Cursor Agent CLIs: worktree per `general` task, Stop in the
  middle (process tree gone in Activity Monitor, card `cancelled`, no leftover `gustaf/…` branch for tasks that never ran).
- Quota / sign-in failover between real CLI accounts (`classifyCliFailure` patterns against real error text).
- Gate checks of a `general` API subagent in a real shadow copy (the review path layout and `review.json` are faked in tests).
- Codex-native subagents stopped mid-turn: panel shows `stopped` for both rollout-scanned and stream-only agents.
