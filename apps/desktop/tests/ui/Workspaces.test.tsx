import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../../src/components/ChatView";
import { Sidebar } from "../../src/components/Sidebar";
import { takeTerminalOpen } from "../../src/lib/terminalBridge";
import { resetWorkspaceStore } from "../../src/lib/workspaceStore";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

// The project panels have their own backends; they are not under test here.
vi.mock("../../src/components/ChangesPanel", () => ({ ChangesPanel: () => null }));
vi.mock("../../src/components/AgentsPanel", () => ({ AgentsColumn: () => null, AgentsToggle: () => null }));
const model = vi.hoisted(() => ({ turn: undefined as undefined | ((input: any) => Promise<any>) }));
vi.mock("../../src/providers", async (orig) => ({
  ...(await orig<typeof import("../../src/providers")>()),
  getAdapter: async () => ({ supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: (input: any) => model.turn!(input) }),
}));

const noop = () => {};
const info = (over: Record<string, unknown> = {}) => ({
  taskId: "t1", path: "/store/abc/t1", branch: "gustaf/fix-login", baseCommit: "deadbeef", baseBranch: "main", createdAt: 1,
  provider: null, model: null, headSha: "cafe", changedFiles: 3, ahead: 2, behind: 1, dirty: false, existsOnDisk: true, ...over,
});
const gitStatus = (over: Record<string, unknown> = {}) => ({ repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", files: [], total: 0, inProgress: null, ...over });
const wsChat = (over: Record<string, unknown> = {}) => chat({ id: 5, project_id: 1, title: "Fix login", workspace_task_id: "t1", workspace_branch: "gustaf/fix-login", workspace_base: "deadbeef", ...over });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const sidebar = (over: Record<string, unknown> = {}) =>
  renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ projects: [project()], chats: [chat({ id: 1, title: "Plain chat" }), wsChat()], ...over }));
const workspaceRow = () => screen.getByRole("group", { name: "Workspaces of Alpha" }).querySelector(".row.workspace") as HTMLElement;

beforeEach(() => resetWorkspaceStore());

describe("Sidebar workspaces", () => {
  it("groups workspace chats under their project with branch, sync and changed-file count", async () => {
    mockInvoke({ worktree_list: [info()] });
    sidebar();
    const group = screen.getByRole("group", { name: "Workspaces of Alpha" });
    expect(within(group).getByText("Fix login")).toBeInTheDocument();
    await waitFor(() => expect(within(group).getByText("3 changed")).toBeInTheDocument());
    expect(within(group).getByText("gustaf/fix-login")).toBeInTheDocument();
    expect(within(group).getByText("↑2 ↓1")).toBeInTheDocument();
    expect(callsOf("worktree_list")[0]).toEqual({ root: "/work/alpha" });
    // The plain chat is an ordinary row, not part of the group.
    expect(within(group).queryByText("Plain chat")).not.toBeInTheDocument();
  });

  it("reuses the chat status badge", async () => {
    mockInvoke({ worktree_list: [info()] });
    sidebar({ sessions: { active: "k", items: [{ key: "k", chatId: 5, projectId: 1, busy: true }] } });
    expect(within(workspaceRow()).getByRole("img", { name: "Thinking…" })).toBeInTheDocument();
  });

  it("shows an archived workspace without status and without the workspace actions", async () => {
    mockInvoke({ worktree_list: [] });
    sidebar();
    await waitFor(() => expect(within(workspaceRow()).getByText("archived")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Archive workspace" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Open in terminal" })).not.toBeInTheDocument();
  });

  it("does not poll projects without workspace chats", async () => {
    mockInvoke({ worktree_list: [info()] });
    sidebar({ chats: [chat({ id: 1, title: "Plain chat" })] });
    await flush();
    expect(callsOf("worktree_list")).toEqual([]);
  });

  it("Open in terminal opens the chat and asks for the terminal in the workspace folder", async () => {
    mockInvoke({ worktree_list: [info()], git_status: gitStatus() });
    const { app } = sidebar();
    await waitFor(() => expect(within(workspaceRow()).getByText("3 changed")).toBeInTheDocument());
    await userEvent.click(within(workspaceRow()).getByRole("button", { name: "Workspace actions: Fix login" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open in terminal" }));
    expect(app.openChat).toHaveBeenCalledWith(5, 1);
    await waitFor(() => expect(takeTerminalOpen("/store/abc/t1")).toBe(true));
  });

  it("Reveal shows the workspace folder, not the project folder", async () => {
    mockInvoke({ worktree_list: [info()] });
    sidebar();
    await waitFor(() => expect(within(workspaceRow()).getByText("3 changed")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Show in / }));
    expect(revealItemInDir).toHaveBeenCalledWith("/store/abc/t1");
  });

  it("Archive removes the workspace (branch kept) and re-reads the list", async () => {
    mockInvoke({ worktree_list: [info({ ahead: 2 })], worktree_remove: { removed: true, branchDeleted: false, branchKeptReason: null } });
    sidebar();
    await waitFor(() => expect(within(workspaceRow()).getByText("3 changed")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    const menu = screen.getByRole("menu");
    // Ahead of the base: deleting the branch would lose commits, so it is not offered.
    expect(within(menu).queryByRole("menuitem", { name: "Archive and delete branch" })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive workspace" }));
    await waitFor(() => expect(callsOf("worktree_remove")).toEqual([{ root: "/work/alpha", taskId: "t1", force: false, deleteBranch: false }]));
    await waitFor(() => expect(callsOf("worktree_list").length).toBeGreaterThan(1));
  });

  it("offers Archive and delete branch only when the branch is level with its base", async () => {
    mockInvoke({ worktree_list: [info({ ahead: 0, behind: 0, changedFiles: 0 })], worktree_remove: { removed: true, branchDeleted: true, branchKeptReason: null } });
    sidebar();
    await waitFor(() => expect(callsOf("worktree_list").length).toBeGreaterThan(0));
    await flush();
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Archive and delete branch" }));
    await waitFor(() => expect(callsOf("worktree_remove")).toEqual([{ root: "/work/alpha", taskId: "t1", force: false, deleteBranch: true }]));
  });

  it("a dirty workspace asks first; Archive anyway forces, Cancel does not remove", async () => {
    const remove = vi.fn(({ force }: { force: boolean }) => {
      if (!force) throw "dirty: 2 uncommitted changes";
      return { removed: true, branchDeleted: false, branchKeptReason: null };
    });
    mockInvoke({ worktree_list: [info({ dirty: true })], worktree_remove: remove });
    sidebar();
    await waitFor(() => expect(within(workspaceRow()).getByText("3 changed")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Archive workspace" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive a workspace with changes?" });
    expect(within(dialog).getByText(/has uncommitted changes/)).toBeInTheDocument();
    // Cancel: nothing more is called.
    await userEvent.click(within(dialog).getAllByRole("button", { name: "Cancel" }).slice(-1)[0]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText("Fix login", { selector: ".row.workspace .label" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Archive workspace" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive anyway" }));
    await waitFor(() => expect(callsOf("worktree_remove").map((a) => a.force)).toEqual([false, false, true]));
    expect(callsOf("worktree_remove")[2]).toEqual({ root: "/work/alpha", taskId: "t1", force: true, deleteBranch: false });
  });

  it("New workspace… is offered for git projects and creates the workspace and a linked chat", async () => {
    mockInvoke({
      git_status: gitStatus(),
      worktree_list: [],
      worktree_create: info({ taskId: "w1", path: "/store/abc/w1", branch: "gustaf/fix-login-flow", changedFiles: 0 }),
      db_execute: [1, 42],
    });
    const { app } = sidebar({ chats: [] });
    await flush();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "New workspace…" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await userEvent.type(within(dialog).getByLabelText("What is the task?"), "Fix login flow please{Enter}");
    await waitFor(() => expect(app.openChat).toHaveBeenCalledWith(42, 1));
    const [create] = callsOf("worktree_create");
    expect(create).toMatchObject({ root: "/work/alpha", slug: "fix-login-flow-please", provider: null, model: null });
    expect(create.taskId).toMatch(/^w[a-z0-9]+-[a-z0-9]{4}$/);
    const insert = callsOf("db_execute").find((a) => /insert into chats/.test(a.sql));
    expect(insert.sql).toMatch(/workspace_task_id, workspace_branch, workspace_base/);
    expect(insert.params).toEqual([1, "Fix login flow please", expect.any(Number), expect.any(Number), "w1", "gustaf/fix-login-flow", "deadbeef"]);
  });

  it("New workspace… explains a missing repository instead of creating anything", async () => {
    mockInvoke({ git_status: gitStatus(), worktree_list: [], worktree_create: () => { throw "no_commits: the repository has no commits yet"; } });
    sidebar({ chats: [] });
    await flush();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a git repository with at least one commit/);
    expect(callsOf("db_execute").some((a) => /insert into chats/.test(a.sql))).toBe(false);
  });

  it("hides New workspace… for a project that is not a git repository", async () => {
    mockInvoke({ git_status: gitStatus({ repo: false, head: null }) });
    sidebar({ chats: [] });
    await flush();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "New workspace…" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Pin/ })).toBeInTheDocument();
  });
});

describe("Composer workspace option and the working folder of a chat", () => {
  const usage = { input: 3, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 };
  const rows = [] as unknown[];
  const selection = { providerId: "p1", model: "m1" };
  const draft = { key: "k", chatId: null, projectId: 1 };
  const view = (session: { key: string; chatId: number | null; projectId: number | null }, chats = [] as ReturnType<typeof chat>[]) =>
    renderApp(<ChatView session={session} visible />, makeApp({ projects: [project()], chats, providers: [provider()], selection, sessions: { active: "k", items: [session] } }));

  it("offers Run in new workspace in a git project", async () => {
    mockInvoke({ git_status: gitStatus(), db_select: () => rows });
    view(draft);
    expect(await screen.findByRole("button", { name: "New workspace" })).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the option for a project that is not a git repository", async () => {
    mockInvoke({ git_status: gitStatus({ repo: false, head: null }), db_select: () => rows });
    view(draft);
    await flush();
    expect(screen.queryByRole("button", { name: "New workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("hides the option when the chat already has messages", async () => {
    const stored = [{ id: 1, chat_id: 6, created_at: 1, content: JSON.stringify({ role: "user", parts: [{ type: "text", text: "hi" }] }) }];
    mockInvoke({ git_status: gitStatus(), db_select: ({ sql }: { sql: string }) => (/from messages where chat_id/.test(sql) ? stored : []) });
    view({ key: "k", chatId: 6, projectId: 1 }, [chat({ id: 6, project_id: 1 })]);
    await screen.findByText("hi");
    await flush();
    expect(screen.queryByRole("button", { name: "New workspace" })).not.toBeInTheDocument();
  });

  it("an ordinary chat still runs in the project folder with a shadow copy", async () => {
    model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage }));
    mockInvoke({
      git_status: gitStatus(), db_select: () => rows,
      review_prepare: { id: "1-2", root: "/work/alpha", workspace: "/shadow/work", linked: [] }, git: "abc123\n",
    });
    view({ key: "k", chatId: 6, projectId: 1 }, [chat({ id: 6, project_id: 1 })]);
    await flush();
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await screen.findByText("done");
    expect(callsOf("review_prepare")).toHaveLength(1);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/shadow/work");
    expect(callsOf("worktree_create")).toEqual([]);
  });

  it("a linked chat runs in its worktree: cwd, checkpoint and no shadow copy; the main checkout is never used", async () => {
    model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage }));
    mockInvoke({ git_status: gitStatus(), db_select: () => rows, worktree_list: [info()], git: "abc123\n" });
    view({ key: "k", chatId: 5, projectId: 1 }, [wsChat()]);
    expect(await screen.findByText("Workspace gustaf/fix-login")).toBeInTheDocument();
    await waitFor(() => expect(callsOf("worktree_list").length).toBeGreaterThan(0));
    await flush();
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await screen.findByText("done");
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/store/abc/t1");
    expect(callsOf("review_prepare")).toEqual([]);
    // Every project command (checkpoint) targets the worktree, never /work/alpha.
    expect(callsOf("git").map((a) => a.root).filter((r) => r !== undefined && r !== "/work/alpha" && r !== "/store/abc/t1")).toEqual([]);
    expect(callsOf("git").some((a) => a.root === "/store/abc/t1" && a.shadow)).toBe(true);
    expect(callsOf("git").some((a) => a.root === "/work/alpha" && a.shadow)).toBe(false);
  });

  it("a linked chat whose workspace was archived refuses to run instead of falling back to the main checkout", async () => {
    model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage }));
    mockInvoke({ git_status: gitStatus(), db_select: () => rows, worktree_list: [] });
    view({ key: "k", chatId: 5, projectId: 1 }, [wsChat()]);
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent(/archived or removed/);
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await flush();
    expect(model.turn).not.toHaveBeenCalled();
    expect(callsOf("db_execute").filter((a) => /insert into messages/.test(a.sql))).toEqual([]);
  });

  it("Run in new workspace creates the worktree and a linked chat, then runs the first message in it", async () => {
    model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage }));
    mockInvoke({
      git_status: gitStatus(), db_select: () => rows, worktree_list: [],
      worktree_create: info({ taskId: "w1", path: "/store/abc/w1", branch: "gustaf/add-a-readme", changedFiles: 0 }),
      db_execute: [1, 77], git: "abc123\n",
    });
    const { app } = view(draft);
    await userEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("button", { name: "New workspace" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(screen.getByRole("textbox"), "Add a README{Enter}");
    await screen.findByText("done");
    expect(callsOf("worktree_create")[0]).toMatchObject({ root: "/work/alpha", slug: "add-a-readme", provider: "p1", model: "m1" });
    expect(app.promoteChat).toHaveBeenCalledWith("k", 77);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/store/abc/w1");
    expect(callsOf("review_prepare")).toEqual([]);
    expect(callsOf("db_execute").some((a) => /insert into chats\(project_id, title, created_at, updated_at, workspace_task_id/.test(a.sql) && a.params[4] === "w1")).toBe(true);
    // The option is for the next message only.
    await waitFor(() => expect(screen.queryByRole("button", { name: "New workspace" })).not.toBeInTheDocument());
  });

  it("without a usable repository the option explains and falls back to the normal flow", async () => {
    model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage }));
    mockInvoke({
      git_status: gitStatus(), db_select: () => rows, worktree_list: [],
      worktree_create: () => { throw "not_a_git_repo: the project folder is not inside a git repository"; },
      review_prepare: { id: "1-2", root: "/work/alpha", workspace: "/shadow/work", linked: [] },
      db_execute: [1, 78], git: "abc123\n",
    });
    view(draft);
    await userEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await screen.findByText("done");
    expect(screen.getByRole("alert")).toHaveTextContent(/needs a git repository with at least one commit/);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/shadow/work");
  });
});
