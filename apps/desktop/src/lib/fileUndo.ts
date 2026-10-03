// Per-edit undo for the agent's `edit_file` / `write_file`. Pure orchestration over injected primitives (git in the app's
// shadow repo, folder listing, file write, review diff), so tests/fileUndo.test.mjs can run it against real git.
//
// How it works: before an edit the file's exact bytes are stored as a blob in the shadow repo (`git hash-object -w`,
// the same repo `checkpoints.ts` uses), and its blob id is remembered; after the edit the new blob id is remembered too.
// Undo is offered only while it is provably safe: the file must still be byte-identical to what the agent left (so a
// later edit, a reject in the Changes panel or any other change blocks it), and, for edits made in a review copy, the
// change must still be pending in that review (once it is accepted into the project, undoing the copy would not undo
// the project). Nothing else is touched: no `git add`, no commits, no checkout of other files.

export type ShadowGit = (args: string[]) => Promise<string>;
/** Git blob id of the file's bytes; null = the file did not exist. */
export type FileState = string | null;

export type UndoDeps = {
  git: ShadowGit;
  /** Entries of a folder inside the root, folders with a trailing "/"; rejects when the folder does not exist. */
  list(dir: string): Promise<string[]>;
  /** Writes UTF-8 text through the root-confined file API (keeps the file's permissions). */
  write(path: string, content: string): Promise<void>;
  /** Diff of a review copy's file against its baseline; empty when nothing is pending, rejects when the review is gone. */
  reviewDiff?(reviewId: string, path: string): Promise<string>;
};

export type UndoRecord = { root: string; path: string; before: FileState; after: string; reviewId?: string; undone?: number };
export type FileSnapshot = { path: string; before: FileState };
export type UndoResult = { ok: true } | { ok: false; reason: "changed" | "closed" | "unsupported" | "failed"; message?: string };

export const MAX_UNDO_BYTES = 1_000_000;
const BLOB_ID = /^[0-9a-f]{40,64}$/;
export const isBlobId = (v: unknown): v is string => typeof v === "string" && BLOB_ID.test(v);

/** A normalised root-relative path, or null for anything the tools would not accept anyway (absolute, `..`, empty). */
export function cleanRelPath(path: unknown): string | null {
  if (typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/")) return null;
  const parts = path.split("/").filter((p) => p && p !== ".");
  return parts.length && !parts.includes("..") ? parts.join("/") : null;
}

const REVIEW_PATH = /[\\/]reviews[\\/](\d+-\d+)[\\/]work[\\/]?$/;
/** Review copies live at `<app data>/reviews/<id>/work`; returns the review id and the `reviews` folder, or null. */
export function reviewLocation(root: string): { id: string; dir: string } | null {
  const m = REVIEW_PATH.exec(root);
  return m ? { id: m[1], dir: root.slice(0, m.index + 1 + "reviews".length) } : null;
}

/** Reads the project folder out of `review.json` as returned by `fs_read` (numbered lines). */
export function parseReviewRoot(output: string): string | null {
  try {
    const r = JSON.parse(output.split("\n")[0].replace(/^\s*\d+\|/, ""));
    return typeof r?.root === "string" && r.root ? r.root : null;
  } catch {
    return null;
  }
}

/** Git's blob id of UTF-8 text; equal to the stored id only when the text round-trips byte for byte. */
export async function gitBlobId(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const fileState = async (git: ShadowGit, path: string, store = false): Promise<string> => {
  const id = (await git(["hash-object", ...(store ? ["-w"] : []), "--no-filters", "--", path])).trim();
  if (!isBlobId(id)) throw new Error("unexpected git output");
  return id;
};

/**
 * Call before an edit. Returns undefined when undo cannot be offered; never throws. A missing file counts as "did not
 * exist" only when the folder listing proves it (case-insensitively, as macOS volumes usually are).
 */
export async function captureBefore(d: UndoDeps, pathIn: unknown): Promise<FileSnapshot | undefined> {
  const path = cleanRelPath(pathIn);
  if (!path) return undefined;
  try {
    return { path, before: await fileState(d.git, path, true) };
  } catch {
    // unreadable or missing: decide below
  }
  try {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "." : path.slice(0, slash);
    const name = path.slice(slash + 1).toLowerCase();
    let names: string[] | null = null;
    try {
      names = await d.list(dir);
    } catch (e) {
      // Only a folder that is really missing proves the file is missing; any other failure means "do not know".
      if (!/no such file|os error 2\b/i.test(String((e as Error)?.message ?? e))) return undefined;
    }
    if (names && names.some((n) => n.replace(/\/$/, "").toLowerCase() === name)) return undefined;
    return { path, before: null };
  } catch {
    return undefined;
  }
}

/** Call after a successful edit. Returns undefined when nothing changed or the result cannot be recorded; never throws. */
export async function captureAfter(d: UndoDeps, snap: FileSnapshot, root: string, reviewId?: string): Promise<UndoRecord | undefined> {
  try {
    const after = await fileState(d.git, snap.path);
    if (after === snap.before) return undefined;
    return { root, path: snap.path, before: snap.before, after, ...(reviewId ? { reviewId } : {}) };
  } catch {
    return undefined;
  }
}

/** Restores the file to its state before the edit, if and only if it is still exactly as the edit left it. */
export async function undoEdit(d: UndoDeps, rec: UndoRecord): Promise<UndoResult> {
  const path = cleanRelPath(rec.path);
  if (!path || path !== rec.path || !isBlobId(rec.after) || (rec.before !== null && !isBlobId(rec.before))) return { ok: false, reason: "unsupported" };
  if (rec.reviewId) {
    if (!d.reviewDiff || !/^\d+-\d+$/.test(rec.reviewId)) return { ok: false, reason: "unsupported" };
    let diff = "";
    try {
      diff = await d.reviewDiff(rec.reviewId, path);
    } catch {
      return { ok: false, reason: "closed" };
    }
    if (!diff.trim()) return { ok: false, reason: "closed" };
  }
  try {
    if ((await fileState(d.git, path)) !== rec.after) return { ok: false, reason: "changed" };
  } catch {
    return { ok: false, reason: "changed" };
  }
  try {
    if (rec.before === null) {
      // The agent created this file. `--literal-pathspecs` keeps `*` and `?` in names literal; clean only deletes untracked files.
      await d.git(["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", path]);
      await d.git(["--literal-pathspecs", "clean", "-f", "-x", "--", path]);
      let gone = false;
      try {
        await fileState(d.git, path);
      } catch {
        gone = true;
      }
      return gone ? { ok: true } : { ok: false, reason: "failed", message: "the file could not be removed" };
    }
    const size = Number((await d.git(["cat-file", "-s", rec.before])).trim());
    if (!(size <= MAX_UNDO_BYTES)) return { ok: false, reason: "unsupported" };
    const text = await d.git(["cat-file", "blob", rec.before]);
    if ((await gitBlobId(text)) !== rec.before) return { ok: false, reason: "unsupported" };
    await d.write(path, text);
    return (await fileState(d.git, path)) === rec.before ? { ok: true } : { ok: false, reason: "failed", message: "the restored file does not match" };
  } catch (e) {
    return { ok: false, reason: "failed", message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
