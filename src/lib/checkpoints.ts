import { git } from "./api";

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
