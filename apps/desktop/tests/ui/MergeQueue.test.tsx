import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { clearComposerDrafts, takeComposerDraft } from "../../src/lib/composerBridge";
import { resetMergeQueueStore } from "../../src/lib/mergeQueueStore";
import { resetWorkspaceStore } from "../../src/lib/workspaceStore";
import { chat, makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";

const noop = () => {};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const info = (over: Record<string, unknown> = {}) => ({
  taskId: "t1", path: "/store/abc/t1", branch: "gustaf/fix-login", baseCommit: "deadbeef", baseBranch: "main", createdAt: 1,
  provider: null, model: null, headSha: "cafe", changedFiles: 0, ahead: 2, behind: 0, dirty: false, existsOnDisk: true, ...over,
});
const gitStatus = { repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", files: [], total: 0, inProgress: null };
const wsChat = (id: number, taskId: string, title: string) => chat({ id, project_id: 1, title, workspace_task_id: taskId, workspace_branch: `gustaf/${taskId}`, workspace_base: "deadbeef" });
const report = (over: Record<string, unknown> = {}) => ({ taskId: "t1", branch: "gustaf/fix-login", target: "main", clean: true, checks: [{ againstTaskId: null, against: "main", clean: true, conflicts: [], truncated: false }], ...over });
const conflicted = report({
  clean: false,
  checks: [
    { againstTaskId: null, against: "main", clean: false, conflicts: [{ path: "src/a.ts", kind: "content" }, { path: "docs/b.md", kind: "modify_delete" }], truncated: false },
    { againstTaskId: "t2", against: "gustaf/add-search", clean: false, conflicts: [{ path: "src/c.ts", kind: "add_add" }], truncated: false },
  ],
});

const item = (taskId: string, status: string, over: Record<string, unknown> = {}) => ({
  taskId, branch: `gustaf/${taskId}`, status, error: null, conflicts: [], strategy: "merge", testCommand: null, targetBranch: "main",
  enqueuedAt: 1, startedAt: null, finishedAt: null, ...over,
});

/** A tiny stand-in for the backend queue: `script` decides what each `queue_run_next` does to the state. */
function fakeQueue(script: ((s: { halted: boolean; items: any[] }) => { outcome: string; taskId?: string | null; needsTest?: unknown }) []) {
  const state = { version: 1, halted: false, items: [] as any[], updatedAt: 1 };
  const snap = () => JSON.parse(JSON.stringify(state));
  let step = 0;
  return {
    state,
    handlers: {
      queue_status: () => snap(),
      queue_enqueue: (a: { taskIds: string[]; strategy: string; testCommand: string | null }) => {
        state.items = state.items.filter((i) => !a.taskIds.includes(i.taskId));
        state.items.push(...a.taskIds.map((id, n) => item(id, "queued", { strategy: a.strategy, testCommand: a.testCommand, enqueuedAt: 10 + n })));
        return snap();
      },
      queue_run_next: () => {
        const r = (script[step++] ?? (() => ({ outcome: "idle" })))(state);
        return { outcome: r.outcome, taskId: r.taskId ?? null, needsTest: r.needsTest ?? null, state: snap() };
      },
      queue_report_test: (a: { taskId: string; ok: boolean; output: string }) => {
        const it = state.items.find((i) => i.taskId === a.taskId);
        it.status = a.ok ? "merging" : "failed";
        if (!a.ok) { it.error = a.output; state.halted = true; }
        return snap();
      },
      queue_resume: () => { state.halted = false; return snap(); },
      queue_cancel: () => { state.items.forEach((i) => { if (!["merged", "failed", "skipped"].includes(i.status)) { i.status = "skipped"; i.error = "cancelled"; } }); state.halted = false; return snap(); },
    },
  };
}

const sidebar = (over: Record<string, unknown> = {}) =>
  renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ projects: [project()], chats: [wsChat(5, "t1", "Fix login"), wsChat(6, "t2", "Add search")], ...over }));
const openProjectQueue = async () => {
  await flush();
  fireEvent.contextMenu(screen.getByText("Alpha"));
  await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Merge queue…" }));
  return screen.getByRole("dialog", { name: "Merge queue" });
};

beforeEach(() => { resetWorkspaceStore(); resetMergeQueueStore(); clearComposerDrafts(); });

describe("conflict badge", () => {
  it("shows 'conflicts with <target> (N files)' and a popover with the files and kinds", async () => {
    mockInvoke({
      git_status: gitStatus,
      worktree_list: [info(), info({ taskId: "t2", branch: "gustaf/add-search", path: "/store/abc/t2" })],
      conflicts_check: ({ taskId }: { taskId: string }) => (taskId === "t1" ? conflicted : report({ taskId })),
    });
    sidebar();
    const badge = await screen.findByRole("button", { name: /Conflicts with main \(2 files\)/ });
    expect(badge).toHaveTextContent("Conflicts with main (2 files) +1");
    // Only workspaces that conflict get one.
    expect(screen.getAllByRole("button", { name: /Conflicts with/ })).toHaveLength(1);
    // Each check compares against the target and the other active workspace.
    expect(callsOf("conflicts_check")).toContainEqual({ root: "/work/alpha", taskId: "t1", against: ["t2"] });
    await userEvent.click(badge);
    const pop = screen.getByRole("dialog", { name: "Conflicts of Fix login" });
    expect(within(pop).getByText("With the target branch main")).toBeInTheDocument();
    expect(within(pop).getByText("With the workspace branch gustaf/add-search")).toBeInTheDocument();
    expect(within(pop).getByText("src/a.ts")).toBeInTheDocument();
    expect(within(pop).getByText("docs/b.md")).toBeInTheDocument();
    expect(within(pop).getByText("changed and deleted")).toBeInTheDocument();
    expect(within(pop).getByText("added on both sides")).toBeInTheDocument();
    fireEvent.keyDown(pop, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conflicts of Fix login" })).not.toBeInTheDocument());
  });

  it("is throttled: a re-render does not ask git again", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report() });
    const { rerenderApp, app } = sidebar();
    await flush();
    await waitFor(() => expect(callsOf("conflicts_check")).toHaveLength(1));
    rerenderApp(<Sidebar onCreateProject={noop} onSearch={noop} />);
    await flush();
    expect(callsOf("conflicts_check")).toHaveLength(1);
    expect(app).toBeTruthy();
  });

  it("shows nothing and stops asking when git is too old", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info(), info({ taskId: "t2", branch: "gustaf/add-search" })], conflicts_check: () => { throw "git_too_old: git 2.30 found, 2.38 needed"; } });
    sidebar();
    await flush();
    await flush();
    expect(screen.queryByRole("button", { name: /Conflicts with/ })).not.toBeInTheDocument();
    expect(callsOf("conflicts_check")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("skips workspaces that have nothing to merge", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info({ ahead: 0 })], conflicts_check: conflicted });
    sidebar();
    await flush();
    expect(callsOf("conflicts_check")).toEqual([]);
  });
});

describe("merge queue dialog", () => {
  it("row menu 'Merge into main…' opens the dialog with that workspace checked", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info(), info({ taskId: "t2", branch: "gustaf/add-search", path: "/store/abc/t2" })], conflicts_check: report(), queue_status: { version: 1, halted: false, items: [], updatedAt: 1 } });
    sidebar();
    await waitFor(() => expect(callsOf("worktree_list").length).toBeGreaterThan(0));
    await flush();
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Merge into main…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge queue" });
    expect(within(dialog).getByRole("checkbox", { name: /Fix login/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Add search/ })).not.toBeChecked();
  });

  it("runs enqueue, needs_test through the approval path, report_test and merged; offers archive", async () => {
    const q = fakeQueue([
      (s) => { s.items[0].status = "testing"; return { outcome: "needs_test", taskId: "t1", needsTest: { taskId: "t1", worktreePath: "/store/abc/t1", command: "npm test" } }; },
      (s) => { s.items[0].status = "merged"; s.items[0].finishedAt = 5; return { outcome: "merged", taskId: "t1" }; },
    ]);
    mockSettings({ "mergeStrategy:/work/alpha": "squash", "reviewSetup:/work/alpha": { linkDirs: [], setupCommand: "", testCommand: "npm test" } });
    mockInvoke({
      git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers,
      run_command: { code: 0, output: "all green\n", timed_out: false },
      worktree_remove: { removed: true, branchDeleted: false, branchKeptReason: null },
    });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    // Strategy and test command come from the project's settings.
    await waitFor(() => expect(within(dialog).getByLabelText("Test command (optional)")).toHaveValue("npm test"));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Squash/ })).toBeChecked());
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));

    // The rules say "ask": the command waits for approval and has not run.
    const approval = await screen.findByRole("alertdialog", { name: /command/i });
    expect(within(approval).getByText("npm test")).toBeInTheDocument();
    expect(within(approval).getByText("Runs in /store/abc/t1")).toBeInTheDocument();
    expect(callsOf("run_command")).toEqual([]);
    expect(callsOf("queue_enqueue")).toEqual([{ root: "/work/alpha", taskIds: ["t1"], strategy: "squash", testCommand: "npm test" }]);
    await userEvent.click(within(approval).getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(within(dialog).getByText("Merged", { selector: ".mq-status" })).toBeInTheDocument());
    expect(callsOf("run_command")).toEqual([{ root: "/store/abc/t1", command: "npm test", timeoutMs: 300000 }]);
    expect(callsOf("queue_report_test")).toEqual([{ root: "/work/alpha", taskId: "t1", ok: true, output: "all green\n" }]);
    expect(within(dialog).getByText("Finished: 1 of 1 merged.")).toBeInTheDocument();
    expect(callsOf("queue_run_next").length).toBeGreaterThanOrEqual(2);
    // The strategy is remembered as the project's default.
    expect(callsOf("db_execute").some((a) => /insert into settings/.test(a.sql) && a.params[0] === "mergeStrategy:/work/alpha")).toBe(true);

    // Archive is one click and not automatic.
    expect(callsOf("worktree_remove")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive this workspace" }));
    await waitFor(() => expect(callsOf("worktree_remove")).toEqual([{ root: "/work/alpha", taskId: "t1", force: false, deleteBranch: false }]));
  });

  it("a command the rules allow runs without a prompt; a declined one fails the item and halts", async () => {
    const q = fakeQueue([
      (s) => { s.items[0].status = "testing"; return { outcome: "needs_test", taskId: "t1", needsTest: { taskId: "t1", worktreePath: "/store/abc/t1", command: "npm test" } }; },
      () => ({ outcome: "halted" }),
    ]);
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers, run_command: { code: 0, output: "", timed_out: false } });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    await userEvent.type(within(dialog).getByLabelText("Test command (optional)"), "npm test");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    const approval = await screen.findByRole("alertdialog", { name: /command/i });
    await userEvent.click(within(approval).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(within(dialog).getByText("Failed", { selector: ".mq-status" })).toBeInTheDocument());
    expect(callsOf("run_command")).toEqual([]);
    expect(callsOf("queue_report_test")[0]).toMatchObject({ taskId: "t1", ok: false, output: "The test command was not approved, so it was not run." });
    expect(within(dialog).getByText(/Stopped after a failure/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("an allowlisted test command runs directly with no approval card", async () => {
    const q = fakeQueue([
      (s) => { s.items[0].status = "testing"; return { outcome: "needs_test", taskId: "t1", needsTest: { taskId: "t1", worktreePath: "/store/abc/t1", command: "npm test" } }; },
      (s) => { s.items[0].status = "merged"; return { outcome: "merged", taskId: "t1" }; },
    ]);
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers, run_command: { code: 1, output: "1 failing\n", timed_out: false } });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")], allowlist: ["npm test"] });
    const dialog = await openProjectQueue();
    await userEvent.type(within(dialog).getByLabelText("Test command (optional)"), "npm test");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsOf("queue_report_test")).toEqual([{ root: "/work/alpha", taskId: "t1", ok: false, output: "1 failing\n" }]));
    expect(screen.queryByRole("alertdialog", { name: /command/i })).not.toBeInTheDocument();
    // The failed test's output is shown with the failed item.
    await waitFor(() => expect(within(dialog).getByText(/1 failing/)).toBeInTheDocument());
  });

  it("a failure with conflicts halts, lists the files and drafts (never sends) a resolve instruction; Resume retries", async () => {
    const q = fakeQueue([
      (s) => { Object.assign(s.items[0], { status: "failed", error: "merge conflict", finishedAt: 3, conflicts: [{ path: "src/a.ts", kind: "content" }, { path: "gone.txt", kind: "modify_delete" }] }); s.halted = true; return { outcome: "failed", taskId: "t1" }; },
      (s) => { s.items[0].status = "merged"; s.items[0].finishedAt = 9; return { outcome: "merged", taskId: "t1" }; },
    ]);
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers });
    const { app } = sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    await userEvent.type(within(dialog).getByLabelText("Test command (optional)"), "npm test");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(dialog).getByText("Failed", { selector: ".mq-status" })).toBeInTheDocument());
    expect(within(dialog).getByText("Conflicts with main in 2 files")).toBeInTheDocument();
    expect(within(dialog).getByText("src/a.ts")).toBeInTheDocument();
    expect(within(dialog).getByText("changed and deleted")).toBeInTheDocument();
    expect(callsOf("queue_run_next")).toHaveLength(1); // halted: the loop stopped

    await userEvent.click(within(dialog).getByRole("button", { name: "Resolve with agent" }));
    expect(app.openChat).toHaveBeenCalledWith(5, 1);
    expect(screen.queryByRole("dialog", { name: "Merge queue" })).not.toBeInTheDocument();
    const draft = takeComposerDraft(5)!;
    expect(draft).toBe(
      "Merging this branch into main failed with conflicts in these files:\n- src/a.ts (content)\n- gone.txt (changed and deleted)\n\n"
      + "Resolve the conflicts keeping both intents (the changes of this branch and the ones already in main), run `npm test` to check the result, and commit the result. Do not push.",
    );
    // Nothing was sent: no message was written.
    expect(callsOf("db_execute").some((a) => /insert into messages/.test(a.sql))).toBe(false);

    // The queue is persisted: reopen it, press Resume: the failed item is queued again and the loop continues.
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Merge queue…" }));
    const again = screen.getByRole("dialog", { name: "Merge queue" });
    await userEvent.click(await within(again).findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(within(again).getByText("Merged", { selector: ".mq-status" })).toBeInTheDocument());
    expect(callsOf("queue_enqueue").slice(-1)[0]).toMatchObject({ taskIds: ["t1"], strategy: "merge", testCommand: "npm test" });
    expect(callsOf("queue_resume")).toHaveLength(1);
  });

  it("Cancel while halted skips the unfinished items", async () => {
    const q = fakeQueue([
      (s) => { Object.assign(s.items[0], { status: "failed", error: "boom", finishedAt: 3 }); s.halted = true; return { outcome: "failed", taskId: "t1" }; },
    ]);
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info(), info({ taskId: "t2", branch: "gustaf/add-search", path: "/store/abc/t2" })], conflicts_check: report(), ...q.handlers });
    sidebar();
    const dialog = await openProjectQueue();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Add search/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel queue" })).toBeInTheDocument());
    expect(callsOf("queue_enqueue")[0].taskIds).toEqual(["t1", "t2"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel queue" }));
    await waitFor(() => expect(callsOf("queue_cancel")).toHaveLength(1));
    await waitFor(() => expect(within(dialog).getByText("Skipped", { selector: ".mq-status" })).toBeInTheDocument());
  });

  it("reordering with the move buttons changes the enqueue order", async () => {
    const q = fakeQueue([() => ({ outcome: "idle" })]);
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info(), info({ taskId: "t2", branch: "gustaf/add-search", path: "/store/abc/t2" })], conflicts_check: report(), ...q.handlers });
    sidebar();
    const dialog = await openProjectQueue();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Add search/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move Add search up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsOf("queue_enqueue")[0].taskIds).toEqual(["t2", "t1"]));
  });

  it("workspaces with uncommitted changes cannot be checked", async () => {
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info({ dirty: true })], conflicts_check: report(), queue_status: { version: 1, halted: false, items: [], updatedAt: 1 } });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    expect(within(dialog).getByRole("checkbox", { name: /Fix login/ })).toBeDisabled();
    expect(within(dialog).getByText("uncommitted changes: commit them first")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("shows the persisted queue when the dialog is reopened (after a restart) and continues it", async () => {
    const q = fakeQueue([(s) => { s.items[0].status = "merged"; s.items[0].finishedAt = 4; return { outcome: "merged", taskId: "t1" }; }]);
    q.state.items.push(item("t1", "merging", { enqueuedAt: 3 }));
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    expect(await within(dialog).findByText("Merging", { selector: ".mq-status" })).toBeInTheDocument();
    expect(callsOf("queue_run_next")).toEqual([]); // nothing runs by itself
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(within(dialog).getByText("Merged", { selector: ".mq-status" })).toBeInTheDocument());
  });

  it.each([
    ["target_dirty: main has 2 uncommitted change(s)", /main checkout has uncommitted changes.*Commit or stash them there, then press Try again/],
    ["target_not_checked_out: main checkout is on dev", /not on the branch this workspace merges into.*Switch it to that branch/],
    ["queue_busy: another run is active", /Another merge step is still running/],
  ])("run_next error %s is explained with the fix, and Try again continues", async (raw, message) => {
    let calls = 0;
    const q = fakeQueue([]);
    mockSettings({});
    mockInvoke({
      git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), ...q.handlers,
      queue_run_next: () => {
        if (calls++ === 0) throw raw;
        q.state.items[0].status = "merged";
        return { outcome: "merged", taskId: "t1", needsTest: null, state: JSON.parse(JSON.stringify(q.state)) };
      },
    });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    // The item stays queued: fix the checkout, then try again.
    expect(within(dialog).getByText("Queued", { selector: ".mq-status" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(dialog).getByText("Merged", { selector: ".mq-status" })).toBeInTheDocument());
  });

  it("enqueue errors (a workspace with uncommitted changes) show a plain message", async () => {
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), queue_status: { version: 1, halted: false, items: [], updatedAt: 1 }, queue_enqueue: () => { throw "dirty: task t1 has 3 uncommitted change(s); commit them first"; } });
    sidebar({ chats: [wsChat(5, "t1", "Fix login")] });
    const dialog = await openProjectQueue();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/A workspace has uncommitted changes\. Commit them in that workspace first/);
    expect(callsOf("queue_run_next")).toEqual([]);
    // Back on the form, nothing running.
    expect(within(dialog).getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("shows messages in Russian", async () => {
    mockSettings({});
    mockInvoke({ git_status: gitStatus, worktree_list: [info()], conflicts_check: report(), queue_status: { version: 1, halted: false, items: [], updatedAt: 1 }, queue_enqueue: () => { throw "target_dirty: x"; } });
    renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ projects: [project()], chats: [wsChat(5, "t1", "Fix login")] }), "ru");
    await flush();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Очередь слияния…" }));
    const dialog = screen.getByRole("dialog", { name: "Очередь слияния" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Fix login/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Запустить" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/основной рабочей папке есть незафиксированные изменения/);
  });
});
