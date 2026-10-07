import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BranchSwitcher } from "../../src/components/chat/BranchSwitcher";
import { branchErrorCode, canCreateBranch, filterBranches, lockReason } from "../../src/lib/branchSwitch";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const status = (over: Record<string, unknown> = {}) => ({ repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", files: [], total: 0, inProgress: null, ...over });
const entry = (name: string, over: Record<string, unknown> = {}) => ({ name, remote: false, current: false, checkedOutAt: null, ...over });
const branches = (list = [entry("main", { current: true }), entry("feature/x"), entry("origin/remote-only", { remote: true }), entry("wt-branch", { checkedOutAt: "/wt/1" })]) => ({ repo: true, current: "main", detached: false, head: "abc1234", branches: list, truncated: false });

function backend(over: Record<string, unknown> = {}) {
  mockInvoke({ git_status: status(), review_list: [], git_branches: branches(), git_switch_branch: { branch: "feature/x", stashed: false, restored: false }, git_create_branch: (a: { name: string }) => a.name, ...over });
}
const show = (props: Partial<Parameters<typeof BranchSwitcher>[0]> = {}) => renderApp(<BranchSwitcher root="/work/alpha" running={false} worktree={false} {...props} />);
const chip = () => screen.findByRole("button", { name: /main|feature|Detached/ });

describe("BranchSwitcher", () => {
  it("shows the location and the current branch, and nothing outside a git repository", async () => {
    backend();
    show();
    expect(await chip()).toHaveTextContent("main");
    expect(screen.getByText("Local checkout")).toBeInTheDocument();
  });

  it("renders nothing without a repository", async () => {
    backend({ git_status: status({ repo: false }) });
    const { container } = show();
    await waitFor(() => expect(callsOf("git_status").length).toBeGreaterThan(0));
    expect(container.querySelector(".branch-switch")).toBeNull();
  });

  it("shows a detached HEAD", async () => {
    backend({ git_status: status({ branch: null, detached: true }) });
    show();
    expect(await screen.findByText("Detached at abc1234")).toBeInTheDocument();
  });

  it("lists local and remote branches, filters them and switches a clean tree", async () => {
    backend();
    show();
    await userEvent.click(await chip());
    expect(await screen.findByRole("button", { name: /feature\/x/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /origin\/remote-only/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "feat");
    expect(screen.queryByRole("button", { name: /origin\/remote-only/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /feature\/x/ }));
    expect(callsOf("git_switch_branch")).toEqual([{ root: "/work/alpha", name: "feature/x", remote: false, stash: false }]);
    expect(await screen.findByRole("status")).toHaveTextContent("Switched to feature/x.");
  });

  it("switches to a remote branch as remote", async () => {
    backend({ git_switch_branch: { branch: "remote-only", stashed: false, restored: false } });
    show();
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: /origin\/remote-only/ }));
    expect(callsOf("git_switch_branch")[0]).toMatchObject({ name: "origin/remote-only", remote: true, stash: false });
  });

  it("a branch checked out in another worktree cannot be picked", async () => {
    backend();
    show();
    await userEvent.click(await chip());
    expect(await screen.findByRole("button", { name: /wt-branch/ })).toBeDisabled();
  });

  it("a dirty tree asks first; cancel keeps everything, stash retries with stash", async () => {
    let calls = 0;
    backend({ git_status: status({ total: 2 }), git_switch_branch: (a: { stash: boolean }) => { calls++; if (!a.stash) throw "dirty: 2"; return { branch: "feature/x", stashed: true, restored: true }; } });
    show();
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: /feature\/x/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("2 uncommitted changes");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(callsOf("git_switch_branch")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /feature\/x/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Stash and switch" }));
    expect(callsOf("git_switch_branch")[2]).toMatchObject({ name: "feature/x", stash: true });
    expect(calls).toBe(3);
    expect(await screen.findByRole("status")).toHaveTextContent("stashed and restored");
  });

  it("says where the work is when the stash could not be applied", async () => {
    backend({ git_switch_branch: { branch: "feature/x", stashed: true, restored: false } });
    show();
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: /feature\/x/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("stay in the stash");
  });

  it("shows git's refusal and leaves the picker open", async () => {
    backend({ git_switch_branch: () => { throw "git_error: error: Your local changes would be overwritten"; } });
    show();
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: /feature\/x/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not switch: error: Your local changes would be overwritten");
  });

  it("creates a branch from the current one", async () => {
    backend();
    show();
    await userEvent.click(await chip());
    await userEvent.type(await screen.findByRole("textbox"), "gustaf/new-thing");
    await userEvent.click(screen.getByRole("button", { name: /Create branch "gustaf\/new-thing" from main/ }));
    expect(callsOf("git_create_branch")).toEqual([{ root: "/work/alpha", name: "gustaf/new-thing" }]);
    expect(await screen.findByRole("status")).toHaveTextContent("Created and switched to gustaf/new-thing.");
  });

  it("does not offer to create an existing or invalid name", async () => {
    backend();
    show();
    await userEvent.click(await chip());
    const box = await screen.findByRole("textbox");
    await userEvent.type(box, "feature/x");
    expect(screen.queryByRole("button", { name: /Create branch/ })).toBeNull();
    await userEvent.clear(box);
    await userEvent.type(box, "a..b");
    expect(screen.queryByRole("button", { name: /Create branch/ })).toBeNull();
  });

  it("is locked while a run is active", async () => {
    backend();
    show({ running: true });
    const c = await chip();
    expect(c).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(c);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsOf("git_branches")).toHaveLength(0);
    expect(screen.getByText("Wait for the run to finish before switching branches.")).toBeInTheDocument();
  });

  it("is locked while review changes are pending", async () => {
    backend({ review_list: [[{ id: "r1", root: "/work/alpha", workspace: "/tmp/r1" }, [{ path: "a.ts", kind: "modified" }]]] });
    show();
    await screen.findByText(/pending review changes/);
    await userEvent.click(await chip());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is locked during a merge", async () => {
    backend({ git_status: status({ inProgress: "merge" }) });
    show();
    expect(await screen.findByText(/A merge is in progress/)).toBeInTheDocument();
  });

  it("a worktree chat shows its worktree branch and cannot switch", async () => {
    backend({ git_status: status({ branch: "gustaf/task-1" }) });
    show({ worktree: true });
    const c = await screen.findByRole("button", { name: /gustaf\/task-1/ });
    expect(screen.getByText("Worktree")).toBeInTheDocument();
    await userEvent.click(c);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsOf("git_switch_branch")).toHaveLength(0);
  });

  it("picks up a branch changed outside the app when the window is focused", async () => {
    let branch = "main";
    backend({ git_status: () => status({ branch }) });
    show();
    expect(await chip()).toHaveTextContent("main");
    branch = "elsewhere";
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByRole("button", { name: /elsewhere/ })).toBeInTheDocument();
  });
});

describe("branch helpers", () => {
  it("lock reasons are ordered", () => {
    expect(lockReason({ worktree: true, running: true, reviewPending: true, inProgress: "merge" })).toBe("worktree");
    expect(lockReason({ worktree: false, running: true, reviewPending: true, inProgress: null })).toBe("running");
    expect(lockReason({ worktree: false, running: false, reviewPending: true, inProgress: null })).toBe("review");
    expect(lockReason({ worktree: false, running: false, reviewPending: false, inProgress: "rebase" })).toBe("op");
    expect(lockReason({ worktree: false, running: false, reviewPending: false, inProgress: null })).toBeNull();
  });
  it("parses backend error codes", () => {
    expect(branchErrorCode("dirty: 3")).toEqual({ code: "dirty", rest: "3" });
    expect(branchErrorCode("checked_out_elsewhere: /wt")).toEqual({ code: "checked_out_elsewhere", rest: "/wt" });
    expect(branchErrorCode("boom")).toEqual({ code: "", rest: "boom" });
  });
  it("filters and validates names", () => {
    const list = [entry("main"), entry("Feature/X"), entry("origin/y", { remote: true })];
    expect(filterBranches(list, "feat").map((b) => b.name)).toEqual(["Feature/X"]);
    expect(canCreateBranch("main", list)).toBeNull();
    expect(canCreateBranch("y", list)).toBe("y");
    for (const bad of ["", "-x", "a b", "a..b", "a~1", "x/", "x.lock", "/x", "a@{b", "a//b"]) expect(canCreateBranch(bad, list), bad).toBeNull();
  });
});
