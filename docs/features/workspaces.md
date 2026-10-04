# Workspaces (one git worktree per task)

A workspace gives a task its own checkout of the project: a git worktree on a new `gustaf/<slug>` branch, created from the project's current `HEAD`. A chat linked to it works only there, with any provider (API providers, Codex, Claude Code, Cursor Agent), so several tasks can run side by side and your main checkout is never touched.

## Using it

- **From the sidebar:** project menu, "New workspace…". Type what the task is; that text names the chat and the branch. The workspace and its chat are created and the chat opens.
- **From the composer:** in a project that is a git repository, a new chat shows a "New workspace" button next to the access chip. Switch it on and send: the first message creates the workspace and a linked chat and runs in it. The option is for that one message; it is not offered once a chat has messages.
- **Setup:** the project's setup command and linked dependency folders (Settings, review setup; the same ones the shadow copy uses) are applied to the new checkout. Linked folders such as `node_modules` are symlinked into it; the setup command runs inside it after the usual command approval. If you decline or it fails, the workspace stays usable and you are told.
- **Sidebar:** workspaces appear under their project, indented, with the chat title, the branch name, the usual status badge (running, waiting for approval, failed, unread), how far the branch is ahead of or behind its base and how many files changed. The list is read when a project is expanded, every 30 seconds while it is open, and when a run starts or ends (at most every 5 seconds).
- **Row menu:** Rename; Open in terminal (opens the chat with its terminal tab in the workspace folder); Show in Finder / Explorer; Archive workspace; Archive and delete branch (only offered when the branch has no commits beyond its base and no changes, so nothing is lost).
- **Merging and conflicts:** a workspace whose branch would conflict with its base or with another workspace shows a "Conflicts with main (3 files)" badge under its row (click for the files). "Merge into <target>…" on the row and "Merge queue…" on the project open the merge queue dialog: pick and order workspaces, choose merge, fast-forward or squash and an optional test command (it runs through the usual command approval), and Start. A failed merge halts the queue; "Resolve with agent" drafts an instruction in the workspace chat (you send it) and Resume retries. Merged workspaces can be archived with one click. See [merge-queue.md](merge-queue.md).
- **Archive** removes the checkout folder but keeps the chat and the branch. A workspace with uncommitted changes asks first ("Archive anyway" forces it and discards them). The row stays, marked "archived"; a chat whose workspace is gone cannot run anything (it never falls back to the main checkout).
- **Changes panel:** for a workspace chat the panel lists the net change against the base commit (committed and uncommitted work together; click a file for its diff). There is nothing to accept or reject per hunk, because the edits are already on disk in the workspace. The usual commit, push and pull request actions work in the workspace folder on its branch. Per-file "Revert file" and "Revert all" (back to the state before the chat's first message) are the existing checkpoint actions and work here too.
- **Startup:** workspaces whose folder was deleted outside the app are pruned once per start (`worktrees.prune`, errors ignored).

## How it works

- Data: `chats.workspace_task_id`, `workspace_branch`, `workspace_base` (nullable, added by the idempotent migration in `src-tauri/src/db.rs`). A chat without them behaves as before. The checkout path is not stored: it is looked up with `worktree_list` (`src/lib/workspaceStore.ts`), so a moved store directory does not break chats.
- Backend: `src-tauri/src/worktree.rs` (create, list, remove, prune, diff, and `worktree_link_dirs` for the dependency symlinks, validated by the same code as the shadow copy). Typed wrapper `src/lib/worktrees.ts`.
- Working folder: `ChatView` resolves the chat's root with `resolveChatRoot` (`src/lib/workspaces.ts`). For a linked chat it is the checkout (at the project's subfolder when the project is not the repository root); that one value feeds file tools, `run_command`, the CLI providers' working directory, the terminal, `@file` mentions, instruction files (`AGENTS.md`, ...), checkpoints and the action log (undo), and git. While the checkout cannot be resolved there is no root and sending is refused.
- No shadow copy: a workspace is its own isolation, so linked chats run with `review: null` and edits land directly in the checkout.
- Code: `lib/workspaceCreate.ts` (create and set up), `lib/workspaceStore.ts` (cached list, polling), `components/WorkspaceDialogs.tsx`, `components/WorkspaceChanges.tsx`, sidebar rows in `components/Sidebar.tsx`, the toggle in `components/chat/Composer.tsx`.

## Limits

- Needs a git repository with at least one commit. Without one, "New workspace…" is hidden and the composer option is not shown; if creation fails for that reason at send time you are told and the message runs in the project folder as usual.
- Dependency folders are symlinks. If your `.gitignore` lists them with a trailing slash (`node_modules/`), git treats the symlink as an untracked file; ignore them without the slash (`node_modules`) to keep them out of status and commits. Checkpoint repositories created from now on skip `node_modules` even as a symlink.
- Windows is untested (symlinks there need developer mode or elevation).
- A branch of a workspace chat stays in the same workspace; two chats in one workspace share the folder.
- Merging workspaces back into the main checkout is done with the merge queue (row menu "Merge into <target>…", project menu "Merge queue…"; conflict badges on the rows). It never pushes. See [merge-queue.md](merge-queue.md).
- Not verified in the real app: everything was tested with the mocked backend and the Rust tests.
