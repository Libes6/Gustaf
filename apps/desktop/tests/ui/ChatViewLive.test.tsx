import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../../src/components/ChatView";
import { beginLiveRun } from "../../src/lib/liveRuns";
import { chat, makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

// The project panels have their own backends; they are not under test here.
vi.mock("../../src/components/ChangesPanel", () => ({ ChangesPanel: () => null }));
vi.mock("../../src/components/AgentsPanel", () => ({ AgentsColumn: () => null, AgentsToggle: () => null }));

// The model of the interactive tests below: a scripted adapter.
const model = vi.hoisted(() => ({ turn: undefined as undefined | ((input: any) => Promise<any>) }));
vi.mock("../../src/providers", async (orig) => ({
  ...(await orig<typeof import("../../src/providers")>()),
  getAdapter: async () => ({ supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: (input: any) => model.turn!(input) }),
}));

// A scheduled run writing to a chat (lib/liveRuns.ts): the open chat shows it like an interactive run.

const row = (id: number, role: "user" | "assistant", text: string) => ({ id, chat_id: 5, created_at: id, content: JSON.stringify({ role, parts: [{ type: "text", text }] }) });
let rows = [row(1, "user", "Check the build")];

const setup = () => {
  rows = [row(1, "user", "Check the build")];
  mockInvoke({ db_select: ({ sql }: { sql: string }) => (/from messages where chat_id/.test(sql) ? rows : []) });
  const session = { key: "k", chatId: 5, projectId: null };
  return renderApp(
    <ChatView session={session} visible />,
    makeApp({ chats: [chat({ id: 5, project_id: null, title: "⏰ Nightly" })], providers: [provider()], selection: { providerId: "p1", model: "m1" }, sessions: { active: "k", items: [session] } }),
  );
};

describe("ChatView with a live scheduled run", () => {
  it("shows streamed text, Stop and the stored messages, blocks sending, and Stop reaches the run", async () => {
    const { app } = setup();
    await screen.findByText("Check the build");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    const abort = vi.fn();
    let handle!: ReturnType<typeof beginLiveRun>;
    act(() => { handle = beginLiveRun(5, "Nightly", abort); });
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getAllByText(/Scheduled run "Nightly" is writing to this chat/).length).toBeGreaterThan(0);
    expect(app.setSessionBusy).toHaveBeenCalledWith("k", true);

    act(() => handle.text("Build is **green**"));
    expect(await screen.findByText("green")).toBeInTheDocument();

    // The run stores its reply: the chat reloads it and the live tail is empty again.
    rows = [...rows, row(2, "assistant", "All checks passed")];
    act(() => handle.message("assistant"));
    expect(await screen.findByText("All checks passed")).toBeInTheDocument();

    // Sending is refused with a clear message (Enter in the composer), nothing is stored or run.
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/scheduled run "Nightly" is writing to this chat/i);
    expect(callsOf("db_execute").filter((a) => /insert into messages/i.test(a.sql))).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(abort).toHaveBeenCalledTimes(1);

    act(() => handle.end());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(app.setSessionBusy).toHaveBeenLastCalledWith("k", false);
  });

  it("a chat opened while the run is already going loads its messages and shows the approval request", async () => {
    const answers: boolean[] = [];
    const handle = beginLiveRun(5, "Nightly", () => {});
    handle.approval({ kind: "command", command: "npm publish" }, (ok) => answers.push(ok));
    setup();
    await screen.findByText("Check the build");
    expect(await screen.findByText("npm publish")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    act(() => handle.end());
    await waitFor(() => expect(screen.queryByText("npm publish")).not.toBeInTheDocument());
  });
});

describe("ChatView interactive send (shared run core)", () => {
  const usage = { input: 3, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 };
  const inserted = () => callsOf("db_execute").filter((a) => /insert into messages/i.test(a.sql)).map((a) => JSON.parse(a.params[2]).role);

  it("stores the user message and the reply, streams, counts tokens, records the result and toggles busy", async () => {
    model.turn = async (input) => (input.onText("Hi there"), { parts: [{ type: "text", text: "Hi there" }], usage });
    const { app } = setup();
    await screen.findByText("Check the build");
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    expect(await screen.findByText("Hi there")).toBeInTheDocument();
    await waitFor(() => expect(app.setSessionBusy).toHaveBeenLastCalledWith("k", false));
    expect(app.setSessionBusy).toHaveBeenCalledWith("k", true);
    expect(inserted()).toEqual(["user", "assistant"]);
    expect(app.recordTokens).toHaveBeenCalledWith("p1", "m1", usage);
    expect(app.bumpUsage).toHaveBeenCalledWith("p1");
    expect(app.recordProviderResult).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a model failure in the chat and records it for the provider", async () => {
    model.turn = async () => { throw new Error("rate limited"); };
    const { app } = setup();
    await screen.findByText("Check the build");
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited");
    expect(app.recordProviderResult).toHaveBeenCalledWith("p1", "rate limited");
    await waitFor(() => expect(app.setSessionBusy).toHaveBeenLastCalledWith("k", false));
  });
});
