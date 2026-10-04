import { fsx, git } from "./api";
import { stripLineNumbers } from "./autoReview";
import { relativeToProject, untrackedDiffText } from "./workspaceDiff";
import type { WorktreeDiffFile } from "./worktrees";

/**
 * The diff text of one file of a workspace's net change against its base commit, for the AI review (the panel's own diff
 * view uses WorkspaceChanges). `path` is repository-relative as `worktrees.diff` reports it; `root` is the checkout folder
 * the chat works in and `prefix` where the project sits in the repository.
 */
export async function workspaceFileDiff(root: string, base: string, prefix: string, f: Pick<WorktreeDiffFile, "path" | "status">): Promise<string> {
  if (f.status === "untracked") {
    const rel = relativeToProject(f.path, prefix);
    return rel === null ? "" : untrackedDiffText(stripLineNumbers(await fsx.read(root, rel)));
  }
  // `:(top)` makes the path relative to the repository, as the list reports it, whatever folder `root` is.
  return git(root, ["diff", "--no-color", "--no-ext-diff", base, "--", `:(top)${f.path}`]);
}
