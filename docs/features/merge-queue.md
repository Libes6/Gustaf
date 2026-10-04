# Conflict detection and merge queue

Backend for integrating several Gustaf workspaces (one git worktree per task, see [workspaces.md](workspaces.md)) into the project's main checkout. The sidebar and a project dialog drive it (see [UI](#ui)); the commands and the typed wrapper are also usable by the agent loop later.

Code: `src-tauri/src/merge_queue.rs` (commands registered in `src-tauri/src/lib.rs`), `src/lib/mergeQueue.ts` (typed wrapper), tests in the Rust module and `tests/mergeQueue.test.mjs`.

## Conflict check

`conflicts_check(root, taskId, against?)` runs `git merge-tree --write-tree` for the workspace branch and returns one check per comparison: first against the target branch (the recorded base branch if it is a local branch, otherwise the branch checked out in the main checkout), then against the branch of each task id in `against`. Each check has `clean`, `conflicts: [{path, kind}]` (`content`, `add_add`, `modify_delete`, `other`), `truncated` and `againstTaskId` (null for the target).

- Read-only: it creates loose objects in the object database and never touches an index or a working tree (a test compares status, index and HEAD before and after). Git's gc removes the unreferenced objects eventually.
- Needs git 2.38 or newer for `--write-tree`; older versions reject with `git_too_old`.
- Output is capped at 1 MiB, at most 200 conflicts are listed, and git is killed after 60 seconds.

## Merge queue

State is persisted per repository next to the worktree store (`<app data>/worktrees/<hash>/.merge-queue.json`, written atomically) and survives restarts. A lock file (`.merge-queue.lock`, holder pid and time) allows one mutating call at a time; a lock whose process is dead or that is older than 15 minutes is recovered, otherwise calls reject with `queue_busy`. `queue_status` never takes the lock.

Commands:

| Command | What it does |
| --- | --- |
| `queue_enqueue(root, taskIds, strategy, testCommand?)` | Queues workspaces, all or none. Refuses unknown tasks (`not_found`), workspaces with uncommitted changes (`dirty`), tasks already in the queue (`already_queued`), bad strategies (`invalid_strategy`). A finished entry for the same task is replaced. |
| `queue_status(root)` | Current state. |
| `queue_run_next(root)` | Processes exactly one item and returns `{outcome, taskId, needsTest, state}`. |
| `queue_report_test(root, taskId, ok, output?)` | Result of the test command for an item in `testing`. |
| `queue_cancel(root)` | Marks every unfinished item `skipped` ("cancelled") and clears the halt. |
| `queue_resume(root)` | Clears the halt after a failure so remaining items can run. |

Strategies: `fast_forward` (rebase the branch onto the target in its worktree, then `merge --ff-only`), `squash` (rebase, then `merge --squash` and one commit), `merge` (merge the target into the branch in its worktree, then `merge --no-ff` into the target). Statuses: `queued`, `rebasing`, `testing`, `merging`, `merged`, `failed`, `skipped`.

`queue_run_next` for the first unfinished item:

1. The main checkout must be on the item's target branch and clean, otherwise it rejects with `target_not_checked_out` or `target_dirty` and leaves the item untouched; fix the checkout and call again.
2. The branch is integrated with the target inside its own worktree. On a conflict the rebase or merge is aborted, the item becomes `failed` with its `conflicts` list, and the queue halts: later items stay `queued` and `run_next` answers `halted` until `queue_resume` or `queue_cancel`.
3. With a `testCommand` the outcome is `needs_test` with the worktree path and command. The Rust side never executes it: the caller runs it through the normal command-approval path and calls `queue_report_test`. A failure marks the item `failed` and halts; a pass moves it to `merging`, and the next `run_next` merges it (calling `run_next` while the item waits returns `needs_test` again). If the target moved after the test, the item is integrated and tested again.
4. The merge into the target uses the chosen strategy, never forces and never pushes. If it fails it is aborted and the item fails. After `merged`, the next `run_next` rebases the following item on the new target.

A branch that is already contained in the target (or a squash with no net change) is `skipped`. Merged workspaces and their branches are not removed; use the worktree commands for that. Finished history is capped at 50 items.

Errors are strings `<code>: <message>`; `MergeQueueErrorCode` in `src/lib/mergeQueue.ts` lists the codes.

## UI

Code: `src/lib/mergeQueueView.ts` (pure view model: labels, ordering, error mapping, badge text, resolver draft; `tests/mergeQueueView.test.mjs`), `src/lib/mergeQueueStore.ts` (conflict-check cache and the queue loop), `components/ConflictBadge.tsx`, `components/MergeQueueDialog.tsx`, sidebar wiring in `components/Sidebar.tsx`, `lib/composerBridge.ts`. UI tests: `tests/ui/MergeQueue.test.tsx`, `tests/ui/ComposerDraftBridge.test.tsx`, `tests/e2e/mergeQueue.test.mjs`.

- **Conflict badge.** Every workspace row of an expanded project whose branch has commits beyond its base is checked with `conflicts_check` against the target and against the other such workspaces (one call after the other, never awaited by the render). A check runs when the project opens, when the set of workspaces changes and when a run starts or ends, and not more than once per 30 s per workspace. On `git_too_old` the project is never asked again this session and nothing is shown. A conflicting workspace shows "Conflicts with main (3 files)" (+N when other comparisons conflict too); a click opens a popover listing the files and the kind of conflict for each comparison.
- **Merge.** The workspace row menu has "Merge into <target>…" (opens the dialog with that workspace checked); the project menu has "Merge queue…". The dialog lists the active workspaces (checkbox, drag or up/down to order; workspaces with uncommitted changes or without new commits cannot be checked), the strategy (default: the project's `mergeStrategy:<root>` setting, else `merge`; the choice is saved as the new default on Start) and an optional test command (prefilled from the project's review-setup test command, else its diagnostics command). Start calls `queue_enqueue`, then loops `queue_run_next`.
- **Tests go through the approval path.** On `needs_test` the store evaluates the command with `commandVerdict` (the same rules and allowlist as the setup command and the agent): `run` executes it with `run_command` in the workspace folder, `ask` shows an approval card in the dialog (Allow / Deny; the command has not run yet), `block` refuses. A declined or blocked command is reported with `queue_report_test(ok: false)`, which fails the item and halts the queue. The result goes to `queue_report_test`.
- **Live status.** Per item: queued, rebasing, testing, merging, merged, failed (with the conflict list or the test output), skipped. While a step runs the store polls `queue_status` (which takes no lock) every second.
- **Halt.** After a failure the dialog offers Resume (queues the failed item again after the others, clears the halt, continues; re-queueing is refused with `dirty` while the workspace has uncommitted changes), "Skip it and continue" (clears the halt only) and Cancel queue.
- **Survives closing.** The loop lives in the store, not the dialog, so closing it does not stop the queue; an approval that is waiting stays pending and the project row shows "Merge queue: 1 of 3 merged" (click to reopen). After a restart the dialog reads `queue_status` and offers Continue for unfinished items; nothing runs by itself.
- **Typed errors** (`target_dirty`, `target_not_checked_out`, `dirty`, `queue_busy`, `already_queued`, `not_found`, `git_too_old`, ...) show a plain message with the fix, in English and Russian; the retryable ones (`target_*`, `queue_busy`) offer Try again and leave the item queued.
- **Resolve with agent.** A failed item with conflicts has "Resolve with agent": it opens the workspace's chat and puts a drafted instruction into its message box (conflicts with the target in these files, keep both intents, run the tests, commit, do not push). The draft is only placed in the composer (`composerBridge`, applied by `ChatView` once it is visible, appended to existing text); the user edits and sends it. After the agent has committed, press Resume in the dialog.
- **Archive after merge.** A merged item shows "Archive this workspace" (one click, never automatic); it uses the normal archive flow, including the question for uncommitted changes.

## Not built yet

- An agent that resolves conflicts on its own: the UI only drafts the instruction for the workspace chat; the user sends it.
- File claims or locks between running workspaces (conflicts are only detected, not prevented).
- Pushing, pull requests or removing merged workspaces from the queue.
- Windows is untested; liveness of a lock holder falls back to the 15 minute age check there.
- Not verified in the real app: the UI was tested with the mocked backend and a fake queue only.
