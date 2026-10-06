// Pure logic behind the "commit accepted changes" flow (no Tauri, no React), unit-tested in tests/gitCommit.test.mjs.
// Only `import type` is allowed here because Node runs this file directly.
import type { GitFile, GitStatus } from "./api";

const MAX_TRACKED_PER_ROOT = 5000;

/**
 * Files accepted from review, per project root. Kept in memory (module level) so the commit offer survives the
 * panel being re-mounted when chats are switched, but not an app restart: after a restart the dialog still lists
 * every changed file, just without the "accepted" pre-selection.
 */
export type AcceptedStore = {
  add(root: string, path: string): void;
  list(root: string): string[];
  forget(root: string, paths: string[]): void;
};

const normalize = (path: string) => path.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");

export function createAcceptedStore(): AcceptedStore {
  const byRoot = new Map<string, Set<string>>();
  return {
    add(root, path) {
      const p = normalize(path);
      if (!root || !p) return;
      const set = byRoot.get(root) ?? new Set<string>();
      set.delete(p); // keep the most recent last
      set.add(p);
      while (set.size > MAX_TRACKED_PER_ROOT) set.delete(set.values().next().value as string);
      byRoot.set(root, set);
    },
    list: (root) => [...(byRoot.get(root) ?? [])],
    forget(root, paths) {
      const set = byRoot.get(root);
      if (!set) return;
      for (const p of paths) set.delete(normalize(p));
      if (!set.size) byRoot.delete(root);
    },
  };
}

export const acceptedFiles = createAcceptedStore();

const committable = (f: GitFile) => f.kind !== "conflicted";

/** Accepted files that are still changed in git (committed, reverted or ignored ones drop out), in git's order. */
export function offeredFiles(status: GitStatus | null | undefined, accepted: string[]): GitFile[] {
  if (!status?.repo) return [];
  const wanted = new Set(accepted.map(normalize));
  return status.files.filter((f) => wanted.has(f.path) && committable(f));
}

export type Candidate = GitFile & { accepted: boolean };

/** Every changed file, accepted ones first; each group keeps git's order. */
export function candidates(status: GitStatus | null | undefined, accepted: string[]): Candidate[] {
  if (!status?.repo) return [];
  const wanted = new Set(accepted.map(normalize));
  const all = status.files.map((f) => ({ ...f, accepted: wanted.has(f.path) }));
  return [...all.filter((f) => f.accepted), ...all.filter((f) => !f.accepted)];
}

/** Only accepted, committable files start selected; the user's other changes are opt-in. */
export const initialSelection = (list: Candidate[]): Set<string> => new Set(list.filter((f) => f.accepted && committable(f)).map((f) => f.path));

/** `null` when fine, otherwise why `raw` cannot be a branch name (mirrors `git check-ref-format`; git has the last word). */
export function branchNameProblem(raw: string): "empty" | "invalid" | null {
  const name = raw.trim();
  if (!name) return "empty";
  if (name.length > 200) return "invalid";
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return "invalid";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return "invalid";
  if (name.includes("..") || name.includes("@{") || name.includes("//") || name === "@" || name === "HEAD") return "invalid";
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return "invalid";
  return null;
}

/** A starting point for the branch-name field: `gustaf/` plus an ASCII slug of the commit subject. */
export function suggestBranchName(message: string): string {
  const subject = message.trim().split("\n")[0] ?? "";
  const slug = subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `gustaf/${slug || "changes"}`;
}

export type CommitProblem = "notRepo" | "inProgress" | "noFiles" | "noMessage" | "badBranch" | null;

/** Why the Commit button must stay disabled, or `null` when committing is possible. */
export function commitProblem(status: GitStatus | null | undefined, selected: Iterable<string>, message: string, branch: { create: boolean; name: string }): CommitProblem {
  if (!status?.repo) return "notRepo";
  if (status.inProgress) return "inProgress";
  const chosen = new Set(selected);
  if (!status.files.some((f) => chosen.has(f.path) && committable(f))) return "noFiles";
  if (!message.trim()) return "noMessage";
  if (branch.create && branchNameProblem(branch.name)) return "badBranch";
  return null;
}
