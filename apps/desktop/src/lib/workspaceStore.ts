import { useEffect, useState, useSyncExternalStore } from "react";
import { gitRepo } from "./api";
import { WORKSPACE_POLL_MS, WORKSPACE_REFRESH_MS } from "./workspaces";
import { parseWorktreeError, worktrees, type WorktreeInfo } from "./worktrees";

// A small external store with the workspaces (git worktrees) of every project root the UI has asked about, so the
// sidebar rows and the chat view share one `worktrees.list` result. Reads are throttled (WORKSPACE_REFRESH_MS) and
// de-duplicated while in flight; a write path (create, archive, a finished run) passes `force`.

export type WorkspaceEntry = {
  /** `undefined` until the first list arrived. */
  list: WorktreeInfo[] | undefined;
  /** Error code of the last failed read (for example `not_a_git_repo`); null after a good one. */
  error: string | null;
  at: number;
};

const empty: WorkspaceEntry = { list: undefined, error: null, at: 0 };
const entries = new Map<string, WorkspaceEntry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Re-renders the caller whenever any root's list changes (read the data with `workspaceEntry`). */
export const useWorkspaceVersion = () => useSyncExternalStore(subscribe, () => version);

/** Re-reads the workspaces of a project root. Skipped while the last read is younger than the throttle unless `force`. */
export function refreshWorkspaces(root: string, o: { force?: boolean } = {}): Promise<void> {
  const known = entries.get(root);
  if (!o.force && known && Date.now() - known.at < WORKSPACE_REFRESH_MS) return Promise.resolve();
  const running = inflight.get(root);
  if (running) return running;
  const p = worktrees.list(root).then(
    (list) => { entries.set(root, { list: Array.isArray(list) ? list : [], error: null, at: Date.now() }); },
    (e) => { entries.set(root, { list: entries.get(root)?.list ?? [], error: parseWorktreeError(e).code, at: Date.now() }); },
  ).finally(() => { inflight.delete(root); emit(); });
  inflight.set(root, p);
  return p;
}

export const workspaceEntry = (root: string | null | undefined): WorkspaceEntry => (root ? entries.get(root) ?? empty : empty);

/** Live workspaces of a project root; `enabled` false leaves the store alone (a project without workspace chats). */
export function useWorkspaces(root: string | null | undefined, enabled = true): WorkspaceEntry {
  const entry = useSyncExternalStore(subscribe, () => workspaceEntry(root));
  useEffect(() => {
    if (root && enabled) void refreshWorkspaces(root);
  }, [root, enabled]);
  return entry;
}

/** Polls `refreshWorkspaces` for the given roots while mounted (the sidebar passes the expanded projects that have workspaces). */
export function useWorkspacePolling(roots: readonly string[], refreshKey: string) {
  const key = roots.join("\n");
  useEffect(() => {
    if (!roots.length) return;
    const tick = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") roots.forEach((r) => void refreshWorkspaces(r)); };
    tick();
    const timer = setInterval(tick, WORKSPACE_POLL_MS);
    return () => clearInterval(timer);
  }, [key]);
  // A run started or finished somewhere: the changed-file counts moved.
  useEffect(() => { roots.forEach((r) => void refreshWorkspaces(r)); }, [refreshKey]);
}

// Where the project sits inside its repository (`""` or `sub/dir/`): a project in a subfolder works in the same subfolder of a checkout.
const prefixes = new Map<string, Promise<string>>();
export function repoPrefix(root: string): Promise<string> {
  let p = prefixes.get(root);
  if (!p) {
    p = gitRepo.status(root).then((s) => (s?.repo ? s.prefix ?? "" : ""), () => "");
    prefixes.set(root, p);
  }
  return p;
}

/** True when `root` is inside a git work tree with at least one commit (cached per root; re-asked after `forgetRepoInfo`). */
const repos = new Map<string, Promise<boolean>>();
export function isGitProject(root: string): Promise<boolean> {
  let p = repos.get(root);
  if (!p) {
    p = gitRepo.status(root).then((s) => !!s?.repo && !!s.head, () => false);
    repos.set(root, p);
  }
  return p;
}
export const forgetRepoInfo = (root: string) => { repos.delete(root); prefixes.delete(root); };

/** Test hook. */
export function resetWorkspaceStore() {
  entries.clear(); inflight.clear(); prefixes.clear(); repos.clear(); emit();
}

/** `repoPrefix` as a hook; null while loading or when `enabled` is false. */
export function usePrefix(root: string | null | undefined, enabled: boolean): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setValue(null);
    if (root && enabled) repoPrefix(root).then((p) => { if (!cancelled) setValue(p); });
    return () => { cancelled = true; };
  }, [root, enabled]);
  return value;
}

/** Whether `root` is a git project, as a hook (false while unknown). */
export function useIsGitProject(root: string | null | undefined): boolean {
  const [value, setValue] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setValue(false);
    if (root) isGitProject(root).then((v) => { if (!cancelled) setValue(v); });
    return () => { cancelled = true; };
  }, [root]);
  return value;
}
