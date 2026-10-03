import { act, screen, waitFor, within } from "@testing-library/react";
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
const chip = () => screen.findByRole("button", { name: /Review copy:/ });
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
  it("off (default): the run edits the project folder, no copy, and the chip says edits are direct", async () => {
    answer();
    backend();
    view({ reviewCopy: false });
    const c = await chip();
    expect(c).toHaveTextContent("Review copy: off");
    expect(c).toHaveAttribute("title", expect.stringContaining("edits are applied directly"));
    await flush();
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
    expect(await chip()).toHaveTextContent("Review copy: on");
    await flush();
    await send();
    expect(callsOf("review_prepare")).toHaveLength(1);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/shadow/work");
  });

  it("the chip menu sets a per-chat override that wins over the global setting and is stored", async () => {
    answer();
    const stored = backend();
    view({ reviewCopy: false });
    await userEvent.click(await chip());
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Default \(off\)/ })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^on/ }));
    await waitFor(() => expect(stored.chatReviewOverrides).toEqual({ 6: "on" }));
    expect(await chip()).toHaveTextContent("Review copy: on");
    await flush();
    await send();
    expect(callsOf("review_prepare")).toHaveLength(1);
  });

  it("a stored override is applied when the chat opens: off wins over a global on", async () => {
    answer();
    backend({ chatReviewOverrides: { 6: "off" } });
    view({ reviewCopy: true });
    await waitFor(() => expect(screen.getByRole("button", { name: /Review copy:/ })).toHaveTextContent("Review copy: off"));
    await flush();
    await send();
    expect(callsOf("review_prepare")).toEqual([]);
    expect((model.turn as any).mock.calls[0][0].cwd).toBe("/work/alpha");
  });

  it("a draft chat's choice is stored under the new chat id", async () => {
    answer();
    const stored = backend({}, 91);
    const draft = { key: "k", chatId: null, projectId: 1 };
    renderApp(<ChatView session={draft} visible />, makeApp({ projects: [project()], chats: [], providers: [provider()], selection, reviewCopy: false, sessions: { active: "k", items: [draft] } }));
    await userEvent.click(await chip());
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^on/ }));
    await send();
    expect(stored.chatReviewOverrides).toEqual({ 91: "on" });
    expect(callsOf("review_prepare")).toHaveLength(1);
  });
});
