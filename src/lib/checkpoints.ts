import { fsx, git, review } from "./api";
import { captureAfter, captureBefore, reviewLocation, undoEdit, type FileSnapshot, type UndoDeps, type UndoRecord, type UndoResult } from "./fileUndo";

export async function checkpoint(root: string) {
  await git(root, ["add", "-A"], true);
  await git(root, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "checkpoint"], true);
  return (await git(root, ["rev-parse", "HEAD"], true)).trim();
}

export type FileChange = { path: string; added: number; removed: number };

export async function changesSince(root: string, sha: string) {
  await git(root, ["add", "-A"], true);
  const stat = await git(root, ["diff", "--cached", "--numstat", "-z", "--no-renames", sha], true);
  const files: FileChange[] = stat
    .split("\0")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
    });
  return files;
}

export const fileDiff = (root: string, sha: string, path: string) =>
  git(root, ["diff", "--cached", sha, "--", path], true);

/** Restores the whole working tree to `sha`, deleting files created after it. */
export async function restoreAll(root: string, sha: string) {
  await git(root, ["add", "-A"], true);
  await git(root, ["read-tree", "-u", "--reset", sha], true);
}

export async function restoreFile(root: string, sha: string, path: string) {
  const exists = await git(root, ["ls-tree", "-z", sha, "--", path], true);
  if (exists) {
    await git(root, ["checkout", sha, "--", path], true);
  } else {
    await git(root, ["rm", "-q", "-f", "--", path], true);
  }
}

export async function projectGit(root: string) {
  try {
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const stat = await git(root, ["diff", "--shortstat", "HEAD"]);
    return {
      branch,
      added: Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0),
      removed: Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0),
    };
  } catch {
    return null;
  }
}

// ---- per-edit undo (the agent action log) ----
// Uses the same shadow repo as the checkpoints above, but only to store the exact bytes of one file before an edit; see fileUndo.ts.

const undoDeps = (root: string): UndoDeps => ({
  git: (args) => git(root, args, true),
  list: async (dir) => (await fsx.list(root, dir)).split("\n").filter(Boolean),
  write: async (path, content) => void (await fsx.write(root, path, content)),
  reviewDiff: (id, path) => review.diff(id, path),
});

/** Stores a file's current bytes before the agent edits it. Resolves to undefined when undo could not be offered; never rejects. */
export function snapshotFile(root: string, path: unknown) {
  return captureBefore(undoDeps(root), path).catch(() => undefined);
}

/**
 * Records the result of an edit as an undo entry. In a review copy the entry also names the review, so undo can check that
 * the change is still pending; if that review cannot be identified there is no undo.
 */
export async function sealSnapshot(root: string, snap: FileSnapshot, reviewMode: boolean): Promise<UndoRecord | undefined> {
  const where = reviewLocation(root);
  if (reviewMode && !where) return undefined;
  return captureAfter(undoDeps(root), snap, root, reviewMode ? where?.id : undefined).catch(() => undefined);
}

export const undoFileEdit = (record: UndoRecord): Promise<UndoResult> => undoEdit(undoDeps(record.root), record);
