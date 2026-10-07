import type { SubagentWorktrees } from "../agent/cliSubagentCore";
import { prepareWorkspaceSetup } from "./reviewSetupStore";
import { refreshWorkspaces, repoPrefix } from "./workspaceStore";
import { joinCheckout, newTaskId, slugFromText } from "./workspaces";
import { needsShadowCopyFallback, parseWorktreeError, worktrees } from "./worktrees";

/**
 * Git worktrees for CLI subagents that write: one per task on a `gustaf/<slug>` branch from the project's HEAD (the same
 * backend as workspaces, see docs/features/workspaces.md), with the project's dependency links and setup command applied.
 * No chat is linked: the branch shows up with the workspaces of the project and is left for the user to merge.
 */
export const gitSubagentWorktrees: SubagentWorktrees = {
  async create({ projectRoot, title, providerId, model, setup }) {
    let info;
    try {
      const taken = await worktrees.list(projectRoot).then(
        (l) => l.map((w) => w.taskId),
        () => [],
      );
      info = await worktrees.create({
        root: projectRoot,
        taskId: newTaskId(taken),
        slug: slugFromText(title),
        provider: providerId,
        model,
      });
    } catch (e) {
      if (needsShadowCopyFallback(e)) return null;
      throw parseWorktreeError(e);
    }
    const cwd = joinCheckout(info.path, await repoPrefix(projectRoot).catch(() => ""));
    // The setup is best effort: the checkout is usable without it (same as for a workspace).
    await prepareWorkspaceSetup(projectRoot, info.taskId, cwd, setup).catch(() => null);
    void refreshWorkspaces(projectRoot, { force: true });
    return { taskId: info.taskId, branch: info.branch, cwd, path: info.path, baseCommit: info.baseCommit };
  },

  async inspect(projectRoot, taskId) {
    const [diff, list] = await Promise.all([
      worktrees.diff(projectRoot, taskId),
      worktrees.list(projectRoot).catch(() => []),
    ]);
    const info = list.find((w) => w.taskId === taskId);
    // Without the checkout's status (listing failed or it is missing) its dirty and commit state are unknown: it counts as touched, so it is never removed.
    const committed = !info || (info.headSha != null && info.headSha !== info.baseCommit) || (info.ahead ?? 0) > 0;
    return { files: diff.files.map((f) => f.path), touched: diff.files.length > 0 || !!info?.dirty || committed };
  },

  async remove(projectRoot, taskId) {
    try {
      const r = await worktrees.remove({ root: projectRoot, taskId, force: false, deleteBranch: true });
      void refreshWorkspaces(projectRoot, { force: true });
      return r.removed;
    } catch {
      return false;
    }
  },
};
