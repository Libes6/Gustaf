import { createWorkspaceChat } from "./data";
import { prepareWorkspaceSetup, type SetupOptions } from "./reviewSetupStore";
import type { Key } from "../i18n";
import { newTaskId, joinCheckout, slugFromText } from "./workspaces";
import { forgetRepoInfo, refreshWorkspaces, repoPrefix } from "./workspaceStore";
import { needsShadowCopyFallback, parseWorktreeError, worktrees, type WorktreeInfo } from "./worktrees";

export type WorkspaceCreated = {
  ok: true;
  chatId: number;
  info: WorktreeInfo;
  /** Where the agent works: the checkout, at the project's subfolder when the project is not the repository root. */
  root: string;
};
export type WorkspaceFailed = {
  ok: false;
  /** No usable git repository: the caller explains and continues with the normal flow. */
  fallback: boolean;
  message: string;
};

/**
 * Makes the worktree for a new task (branch from the project's HEAD, slug from the first words of `title`, a task id
 * that no existing workspace uses) and a new chat linked to it. A failed chat insert removes the worktree again so
 * nothing is left behind. Setup (dependency links, setup command) is a separate step: `setupWorkspace`.
 */
export async function createWorkspace(o: { projectId: number; root: string; title: string; slugSource?: string; provider?: string | null; model?: string | null }): Promise<WorkspaceCreated | WorkspaceFailed> {
  let info: WorktreeInfo;
  try {
    const taken = await worktrees.list(o.root).then((l) => l.map((w) => w.taskId), () => []);
    info = await worktrees.create({ root: o.root, taskId: newTaskId(taken), slug: slugFromText(o.slugSource ?? o.title), provider: o.provider, model: o.model });
  } catch (e) {
    const err = parseWorktreeError(e);
    return { ok: false, fallback: needsShadowCopyFallback(err), message: err.message };
  }
  try {
    const chatId = await createWorkspaceChat(o.projectId, o.title, { taskId: info.taskId, branch: info.branch, base: info.baseCommit });
    const root = joinCheckout(info.path, await repoPrefix(o.root));
    void refreshWorkspaces(o.root, { force: true });
    return { ok: true, chatId, info, root };
  } catch (e) {
    await worktrees.remove({ root: o.root, taskId: info.taskId, force: true, deleteBranch: true }).catch(() => {});
    forgetRepoInfo(o.root);
    return { ok: false, fallback: false, message: String((e as Error)?.message ?? e) };
  }
}

type T = (key: Key, vars?: Record<string, string | number>) => string;

/**
 * Dependency links and the project's setup command in the new checkout (same approval rules as the shadow copy).
 * Never throws: the workspace is usable without its setup, so a problem comes back as the notice text ("" when fine).
 */
export async function setupWorkspace(projectRoot: string, created: WorkspaceCreated, o: SetupOptions, t: T): Promise<string> {
  try {
    const setup = await prepareWorkspaceSetup(projectRoot, created.info.taskId, created.root, o);
    if (setup === "declined") return t("workspaceSetupDeclined");
    if (setup && !setup.ok) return t("workspaceSetupFailed", { code: setup.timedOut ? t("reviewTimedOut") : String(setup.code ?? "?"), output: setup.output.slice(-600) });
    return "";
  } catch (e) {
    return t("workspaceSetupFailedOpen", { message: String((e as Error)?.message ?? e) });
  }
}
