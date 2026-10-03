import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../../src/components/ChatView";
import { Settings } from "../../src/components/Settings";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

vi.mock("../../src/components/ChangesPanel", () => ({ ChangesPanel: () => null }));
vi.mock("../../src/components/AgentsPanel", () => ({ AgentsColumn: () => null, AgentsToggle: () => null }));
const model = vi.hoisted(() => ({ turn: undefined as undefined | ((input: any) => Promise<any>) }));
vi.mock("../../src/providers", async (orig) => ({
  ...(await orig<typeof import("../../src/providers")>()),
  getAdapter: async () => ({ supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: (input: any) => model.turn!(input) }),
}));

const usage = { input: 3, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 };
const selection = { providerId: "p1", model: "m1" };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const repoStatus = { repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", files: [], total: 0, inProgress: null };

/** Backend with an in-memory settings table, so stored overrides really round-trip. `newChatId` is what an insert returns. */
function backend(settings: Record<string, unknown> = {}, newChatId = 1) {
  mockInvoke({
    db_select: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/from settings where key/.test(sql)) return (params[0] as string) in settings ? [{ value: JSON.stringify(settings[params[0] as string]) }] : [];
      return [];
    },
    db_execute: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/into settings/.test(sql)) settings[params[0] as string] = JSON.parse(String(params[1]));
      return [1, newChatId];
    },
    git_status: repoStatus, git: "abc123\n",
    review_prepare: { id: "1-2", root: "/work/alpha", workspace: "/shadow/work", linked: [] },
  });
  return settings;
}

const view = (over: Record<string, unknown> = {}) => {
  const session = { key: "k", chatId: 6, projectId: 1 };
  return renderApp(<ChatView session={session} visible />, makeApp({ projects: [project()], chats: [chat({ id: 6, project_id: 1 })], providers: [provider()], selection, sessions: { active: "k", items: [session] }, ...over }));
};
const send = async () => { await userEvent.type(screen.getByRole("textbox"), "hello{Enter}"); await screen.findByText("done"); };
const answer = () => { model.turn = vi.fn(async () => ({ parts: [{ type: "text", text: "done" }], usage })); };

describe("review copy setting", () => {
  it("the Git page toggles the global setting, off by default", async () => {
    backend();
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "git", reviewCopy: false }));
    const sw = screen.getByRole("switch", { name: "Review copy for chats" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(app.setReviewCopy).toHaveBeenCalledWith(true);
    await flush();
  });

  it("shows the switch on when the setting is on", async () => {
    backend();
    renderApp(<Settings />, makeApp({ settingsPage: "git", reviewCopy: true }));
    expect(screen.getByRole("switch", { name: "Review copy for chats" })).toHaveAttribute("aria-checked", "true");
    await flush();
  });
});

describe("review copy in a chat", () => {
  it("off (default): the run edits the project folder, no copy, and the composer has no review chip", async () => {
    answer();
    backend();
    view({ reviewCopy: false });
    await flush();
    expect(screen.queryByRole("button", { name: /Review copy/ })).not.toBeInTheDocument();
    await send();
    expect(callsOf("review_prepare")).toEqual([]);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/work/alpha");
    // The checkpoint of the project is still taken before the run.
    expect(callsOf("git").some((a) => a.root === "/work/alpha" && a.shadow)).toBe(true);
  });

  it("on globally: the run works in a copy", async () => {
    answer();
    backend();
    view({ reviewCopy: true });
    await flush();
    expect(screen.queryByRole("button", { name: /Review copy/ })).not.toBeInTheDocument();
    await send();
    expect(callsOf("review_prepare")).toHaveLength(1);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/shadow/work");
  });

  it("a stored legacy per-chat override is ignored: global on still uses a copy, global off still edits directly", async () => {
    answer();
    const stored = backend({ chatReviewOverrides: { 6: "off" } });
    const first = view({ reviewCopy: true });
    await flush();
    await send();
    expect(callsOf("review_prepare")).toHaveLength(1);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/shadow/work");
    // The run path never touches the old key.
    expect(stored.chatReviewOverrides).toEqual({ 6: "off" });
    first.unmount();

    answer();
    backend({ chatReviewOverrides: { 6: "on" } });
    view({ reviewCopy: false });
    await flush();
    await send();
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/work/alpha");
  });
});
