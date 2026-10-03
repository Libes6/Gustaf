# Actions, context and file review

Part of the [M Code documentation](../README.md).

Native Codex/Claude/Cursor CLI actions are stored separately from executable API tool calls. Cards show readable names, output and error status; a missing native result is shown as unknown instead of successful. Nonzero API shell exits are tool errors. Existing imported text-only history cannot reconstruct missing tool outputs.

The composer shows an approximate text-token count. Known context windows and image/tool capabilities come from provider model metadata; unavailable values remain unknown. The last reported input usage is displayed separately and is not treated as the full context size. Image attachments work with CLI providers too: on send the images are written to `<app data>/attachments/<chat id>/<n>.<ext>` (PNG, JPEG, GIF or WebP, up to 10 MB each, at most 8; never inside the project folder) and removed when the reply ends or the project is removed. Codex receives them as `--image=<file>` flags; Claude Code and Cursor Agent get an `Attached image: <path>` line appended to the prompt and the attachment folder via `--add-dir`, so their file-reading tool can open it. Only the images of the new turn are sent, also in resumed sessions; images from earlier turns are no longer on disk. Whether the underlying CLI model can actually see images depends on that model. Compress chat summarizes long history in chunks using the selected model, retains original messages, and starts future requests from the summary without reusing an older provider session. Restore full context removes summaries and clears provider session pointers.

Writable project requests run in an app-managed copy of source files; proposed files persist across restarts until accepted or rejected. Diff is available before copying each file into the original project. Applying checks that the original still matches its baseline; a conflict does not overwrite the user's edits. Existing shadow checkpoints provide rollback after acceptance. Empty completed reviews are cleaned up. Copies omit ignored files, symlinks, git history, build outputs and dependencies, so build/test commands may need separate setup (see below). This is a file-review workflow, not an OS security sandbox: native tools, commands using absolute paths and Computer Use retain their own permission boundaries.

## Setup and tests in the shadow copy

The changes panel has an opt-in, per-project "Shadow copy setup" section (stored in the app database, off by default):
- **Linked directories** (for example `node_modules`) are symlinked into each new copy, so builds and tests find their dependencies. They are meant for reading: they are never listed as changes and never applied or restored by review, and the agent is told to treat them as read-only. A command that writes through the link (such as `npm install`) does write to your real directory, so use the setup command below instead if the copy needs its own install.
- **Setup command** (for example `npm ci`) runs once in every new copy before the agent starts.
- **Test command** (for example `npm test`) gets a "Run tests" button above each pending review; the exit code and the tail of the output are shown there before you accept. The result is marked as outdated once the copy changes again.

Both commands run with the shadow copy as working directory (never the original project), with a 5-minute timeout, and follow the normal command approval rules: in "Ask for commands" mode a command outside the always-allowed list asks first. They are not an OS sandbox.

## Partial accept

In a pending file's diff each hunk can be accepted or rejected on its own, or tick several and use "Accept selected" / "Reject selected". Accepting writes only those hunks to the project, after the same baseline conflict check as a whole file; the remaining hunks stay pending. Rejecting reverts them in the copy only. New, deleted and binary files are decided as a whole.

## Committing accepted changes

When the project is inside a git repository, accepting files from review offers to commit them ("N accepted files to commit" in the changes panel, plus a Commit button in its footer). The dialog shows the branch and working-tree state and lists the changed files: the ones accepted in review are ticked, any other changes in your working tree are unticked and only committed if you tick them. Only the ticked files go into the commit; anything else you had staged stays staged. The message can be written by hand or generated with the model currently selected in the composer (from a bounded diff of the ticked files and the repository's recent commit subjects); it is always editable before committing, and the diff is sent to that provider like any other chat context. You can also create a new branch from the current HEAD first, which is suggested when HEAD is detached.

Safeguards: git hooks and signing run as usual (never bypassed), nothing is pushed, amended or forced, paths are validated to stay inside the project, and a failed commit (for example a hook failure) rolls back the new branch and the staging it did. Commits use your own git identity. Committing is blocked during an unfinished merge, rebase, cherry-pick or revert and for files with conflicts. The set of files accepted in review is kept in memory only: after restarting the app the dialog still lists every changed file, just without the pre-selection.
