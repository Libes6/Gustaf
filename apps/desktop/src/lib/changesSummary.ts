import type { GitStatus, Review, ReviewChange } from "./api";
import type { FileChange } from "./checkpoints";

/**
 * The one answer to "what changed?" behind the changes panel header: the file count and the +/- numbers always describe the
 * same set of files. Sources, in order:
 *  - `review`: files proposed in pending review copies (nothing is in the project yet), counted from the copies;
 *  - `checkpoint`: this chat's direct edits since its checkpoint (the shadow repo diff, untracked files included);
 *  - `tree`: no checkpoint yet, so the project's uncommitted changes. Line counts are only known for tracked files,
 *    so with untracked files (or a capped file list) they are `null` instead of a misleading "+0 −0".
 */
export type ChangesSummary = { source: "review" | "checkpoint" | "tree" | "none"; files: number; added: number | null; removed: number | null };
export const NO_CHANGES: ChangesSummary = { source: "none", files: 0, added: 0, removed: 0 };

/** Added/removed lines of one unified diff; header lines before the first hunk are not content. */
export function countDiffLines(diff: string) {
  let added = 0, removed = 0, inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export type ReviewStat = { files: number; added: number | null; removed: number | null };

/** File count and line totals over every pending review copy; line totals are `null` if a diff cannot be read or there are too many files. */
export async function reviewChangeStats(reviews: [Review, ReviewChange[]][], diff: (id: string, path: string) => Promise<string>, cap = 200): Promise<ReviewStat> {
  const all = reviews.flatMap(([r, list]) => list.map(f => ({ id: r.id, path: f.path, binary: f.binary })));
  if (!all.length) return { files: 0, added: 0, removed: 0 };
  if (all.length > cap) return { files: all.length, added: null, removed: null };
  try {
    const counts = await Promise.all(all.map(f => f.binary ? { added: 0, removed: 0 } : diff(f.id, f.path).then(countDiffLines)));
    return { files: all.length, added: counts.reduce((n, c) => n + c.added, 0), removed: counts.reduce((n, c) => n + c.removed, 0) };
  } catch {
    return { files: all.length, added: null, removed: null };
  }
}

export type TreeState = Pick<GitStatus, "repo" | "files" | "total"> & { added: number; removed: number };

export function summarizeChanges(input: { review: ReviewStat | null; checkpoint: FileChange[] | null; tree: TreeState | null }): ChangesSummary {
  const { review, checkpoint, tree } = input;
  if (review && review.files > 0) return { source: "review", ...review };
  if (checkpoint) {
    if (!checkpoint.length) return NO_CHANGES;
    return { source: "checkpoint", files: checkpoint.length, added: checkpoint.reduce((n, f) => n + f.added, 0), removed: checkpoint.reduce((n, f) => n + f.removed, 0) };
  }
  if (tree?.repo && tree.total > 0) {
    const exact = tree.files.length >= tree.total && !tree.files.some(f => f.kind === "untracked");
    return { source: "tree", files: tree.total, added: exact ? tree.added : null, removed: exact ? tree.removed : null };
  }
  return NO_CHANGES;
}
