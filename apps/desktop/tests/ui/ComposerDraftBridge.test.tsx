import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../../src/components/ChatView";
import { clearComposerDrafts, requestComposerDraft } from "../../src/lib/composerBridge";
import { resetWorkspaceStore } from "../../src/lib/workspaceStore";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

vi.mock("../../src/components/ChangesPanel", () => ({ ChangesPanel: () => null }));
vi.mock("../../src/components/AgentsPanel", () => ({ AgentsColumn: () => null, AgentsToggle: () => null }));
const model = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock("../../src/providers", async (orig) => ({
  ...(await orig<typeof import("../../src/providers")>()),
  getAdapter: async () => ({
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: model.turn,
  }),
}));

const gitStatus = {
  repo: true,
  toplevel: "/work/alpha",
  prefix: "",
  branch: "main",
  detached: false,
  head: "abc1234",
  files: [],
  total: 0,
  inProgress: null,
};
const info = {
  taskId: "t1",
  path: "/store/abc/t1",
  branch: "gustaf/fix-login",
  baseCommit: "deadbeef",
  baseBranch: "main",
  createdAt: 1,
  provider: null,
  model: null,
  headSha: "cafe",
  changedFiles: 0,
  ahead: 2,
  behind: 0,
  dirty: false,
  existsOnDisk: true,
};
const wsChat = chat({
  id: 5,
  project_id: 1,
  title: "Fix login",
  workspace_task_id: "t1",
  workspace_branch: "gustaf/fix-login",
  workspace_base: "deadbeef",
});
const session = { key: "k", chatId: 5, projectId: 1 };

beforeEach(() => {
  resetWorkspaceStore();
  clearComposerDrafts();
  model.turn.mockReset();
});

describe("composer draft bridge", () => {
  const view = () =>
    renderApp(
      <ChatView session={session} visible />,
      makeApp({
        projects: [project()],
        chats: [wsChat],
        providers: [provider()],
        selection: { providerId: "p1", model: "m1" },
        sessions: { active: "k", items: [session] },
      }),
    );

  it("puts a requested draft into the message box and does not send it", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info], db_select: () => [] });
    view();
    const box = await screen.findByRole("textbox");
    act(() => requestComposerDraft(5, "Resolve the conflicts in src/a.ts"));
    await waitFor(() => expect(box).toHaveValue("Resolve the conflicts in src/a.ts"));
    // A second draft is appended after what is there; the user can edit before sending.
    act(() => requestComposerDraft(5, "Second"));
    await waitFor(() => expect(box).toHaveValue("Resolve the conflicts in src/a.ts\n\nSecond"));
    expect(model.turn).not.toHaveBeenCalled();
    expect(callsOf("db_execute").some((a) => /insert into messages/.test(a.sql))).toBe(false);
  });

  it("a draft requested before the chat is mounted is applied when it opens; drafts for other chats are left alone", async () => {
    mockInvoke({ git_status: gitStatus, worktree_list: [info], db_select: () => [] });
    requestComposerDraft(5, "Waiting draft");
    requestComposerDraft(99, "Other chat");
    view();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Waiting draft"));
  });
});
