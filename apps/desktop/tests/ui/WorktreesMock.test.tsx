import { describe, expect, it } from "vitest";
import { worktrees } from "../../src/lib/worktrees";
import { callsOf, mockInvoke } from "./tauri";

describe("worktrees through the global Tauri mock", () => {
  it("every call, not only the first, goes through the mock", async () => {
    mockInvoke({ worktree_remove: { removed: true, branchDeleted: true, branchKeptReason: null } });
    await worktrees.remove({ root: "/p", taskId: "t1", force: true });
    await worktrees.remove({ root: "/p", taskId: "t2", force: true });
    expect(callsOf("worktree_remove")).toEqual([
      { root: "/p", taskId: "t1", force: true, deleteBranch: false },
      { root: "/p", taskId: "t2", force: true, deleteBranch: false },
    ]);
  });
});
