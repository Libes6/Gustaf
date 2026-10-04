import { test } from "node:test";
import assert from "node:assert/strict";
import { countDiffLines, reviewChangeStats, summarizeChanges, NO_CHANGES } from "../src/lib/changesSummary.ts";

const tracked = (path) => ({ path, kind: "modified", staged: false });
const untracked = (path) => ({ path, kind: "untracked", staged: false });
const tree = (files, over = {}) => ({ repo: true, files, total: files.length, added: 0, removed: 0, ...over });

test("countDiffLines ignores headers and counts hunk lines, including +++ content", () => {
  const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+++not a header\n@@ -9 +10 @@\n-gone\n";
  assert.deepEqual(countDiffLines(diff), { added: 2, removed: 2 });
  assert.deepEqual(countDiffLines(""), { added: 0, removed: 0 });
  assert.deepEqual(countDiffLines("Binary files differ"), { added: 0, removed: 0 });
});

test("pending review copies: count and +/- both come from the copies", async () => {
  const diffs = { "r1:a.ts": "@@ -1 +1,2 @@\n-a\n+b\n+c", "r1:new.ts": "@@ -0,0 +1 @@\n+x", "r2:b.ts": "@@ -1,3 +0,0 @@\n-1\n-2\n-3" };
  const stat = await reviewChangeStats(
    [[{ id: "r1" }, [{ path: "a.ts", binary: false }, { path: "new.ts", binary: false }, { path: "img.png", binary: true }]], [{ id: "r2" }, [{ path: "b.ts", binary: false }]]],
    async (id, path) => diffs[`${id}:${path}`],
  );
  assert.deepEqual(stat, { files: 4, added: 3, removed: 4 });
  const s = summarizeChanges({ review: stat, checkpoint: null, tree: tree([tracked("zzz")], { added: 99, removed: 99 }) });
  assert.deepEqual(s, { source: "review", files: 4, added: 3, removed: 4 });
});

test("review stats are unknown, not zero, when a diff fails or there are too many files", async () => {
  const one = [[{ id: "r" }, [{ path: "a", binary: false }]]];
  assert.deepEqual(await reviewChangeStats(one, async () => { throw new Error("x"); }), { files: 1, added: null, removed: null });
  const many = [[{ id: "r" }, Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, binary: false }))]];
  let calls = 0;
  assert.deepEqual(await reviewChangeStats(many, async () => (calls++, ""), 4), { files: 5, added: null, removed: null });
  assert.equal(calls, 0);
  assert.deepEqual(await reviewChangeStats([], async () => ""), { files: 0, added: 0, removed: 0 });
});

test("no review copy and a dirty tree (tracked files): counts and lines from the working tree", () => {
  const s = summarizeChanges({ review: null, checkpoint: null, tree: tree([tracked("a"), tracked("b")], { added: 7, removed: 2 }) });
  assert.deepEqual(s, { source: "tree", files: 2, added: 7, removed: 2 });
});

test("untracked-only changes are counted and never shown as +0 -0", () => {
  const s = summarizeChanges({ review: null, checkpoint: null, tree: tree([untracked("new.ts"), untracked("n2.ts")]) });
  assert.deepEqual(s, { source: "tree", files: 2, added: null, removed: null });
});

test("a capped status list does not pretend the lines are exact", () => {
  const s = summarizeChanges({ review: null, checkpoint: null, tree: tree([tracked("a")], { total: 500, added: 5, removed: 5 }) });
  assert.deepEqual(s, { source: "tree", files: 500, added: null, removed: null });
});

test("clean tree and non-repo give no chip", () => {
  assert.deepEqual(summarizeChanges({ review: null, checkpoint: null, tree: tree([]) }), NO_CHANGES);
  assert.deepEqual(summarizeChanges({ review: null, checkpoint: null, tree: null }), NO_CHANGES);
  assert.deepEqual(summarizeChanges({ review: { files: 0, added: 0, removed: 0 }, checkpoint: null, tree: tree([]) }), NO_CHANGES);
  assert.deepEqual(summarizeChanges({ review: null, checkpoint: null, tree: { ...tree([tracked("a")]), repo: false } }), NO_CHANGES);
});

test("direct-edit chat with a checkpoint: counts and lines from the checkpoint diff, untracked files included", () => {
  const checkpoint = [{ path: "new.ts", added: 10, removed: 0 }, { path: "old.ts", added: 1, removed: 4 }];
  assert.deepEqual(summarizeChanges({ review: null, checkpoint, tree: tree([]) }), { source: "checkpoint", files: 2, added: 11, removed: 4 });
  // A dirty tree outside this chat's edits does not leak into the chat's numbers.
  assert.deepEqual(summarizeChanges({ review: null, checkpoint: [], tree: tree([tracked("a")], { added: 3, removed: 3 }) }), NO_CHANGES);
});
