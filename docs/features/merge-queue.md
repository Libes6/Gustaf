# Conflict detection and merge queue

Backend for integrating several Gustaf workspaces (one git worktree per task, see [workspaces.md](workspaces.md)) into the project's main checkout. There is no UI yet; the commands and a typed wrapper exist so the UI and the agent loop can drive them later.

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

## Not built yet

- UI: no queue panel, conflict badges or buttons.
- An agent that resolves conflicts (today a conflict fails the item and halts the queue; the conflict list is there for a resolver to use).
- File claims or locks between running workspaces (conflicts are only detected, not prevented).
- Pushing, pull requests or removing merged workspaces from the queue.
- Windows is untested; liveness of a lock holder falls back to the 15 minute age check there.
