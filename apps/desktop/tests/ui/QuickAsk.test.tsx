import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n";
import { QuickAskView } from "../../src/quick-ask/QuickAsk";
import type { ModelInfo, ProviderConfig } from "../../src/providers/types";
import { callsOf, mockSettings } from "./tauri";

// The model, the quick-ask Tauri bridge, the chat store and the budget check are replaced; everything else is the real view.
const h = vi.hoisted(() => ({
  turn: undefined as undefined | ((req: any) => Promise<unknown>),
  requests: [] as any[],
  providers: [] as any[],
  models: [] as any[],
  budget: null as null | "day" | "chat",
}));
vi.mock("../../src/providers", () => ({
  loadProviders: async () => h.providers,
  listAllModels: async () => ({ models: h.models, errors: {} }),
  getAdapter: async () => ({ turn: (req: any) => (h.requests.push(req), h.turn!(req)) }),
}));
vi.mock("../../src/lib/budgetUsage", () => ({ currentBudgetStop: async () => h.budget }));
vi.mock("../../src/lib/data", () => ({ createChat: vi.fn(async () => 42), addMessage: vi.fn(async () => 1) }));
vi.mock("../../src/lib/quickAskApi", () => ({
  quickAskApi: {
    hide: vi.fn(async () => {}), resize: vi.fn(async () => {}), openMain: vi.fn(async () => {}), ready: vi.fn(async () => {}),
    emitUsage: vi.fn(async () => {}), emitOpenChat: vi.fn(async () => {}), onShown: vi.fn(async () => () => {}),
  },
}));
import { quickAskApi } from "../../src/lib/quickAskApi";
import { addMessage, createChat } from "../../src/lib/data";

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "p1", kind: "anthropic", name: "Anthropic", baseUrl: "", ...over });
const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({ id: "m1", name: "Model One", providerId: "p1", created: 1, ...over });
const usage = { input: 7, output: 3, cached: 0, cacheWrite: 0, reasoning: 0 };

/** A turn that streams the given chunks, then waits for `release` (or the abort signal) before it ends. */
function gatedTurn(chunks: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.turn = async (req) => {
    for (const c of chunks) req.onText(c);
    await Promise.race([gate, new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new Error("aborted"))))]);
    return { parts: [{ type: "text", text: chunks.join("") }], usage };
  };
  return release;
}
const instantTurn = (...chunks: string[]) => { h.turn = async (req) => (chunks.forEach((c) => req.onText(c)), { parts: [], usage }); };

function open(settings: Record<string, unknown> = { selection: { providerId: "p1", model: "m1" } }) {
  mockSettings(settings);
  const ui = (session: number) => <I18nProvider locale="en"><QuickAskView session={session} /></I18nProvider>;
  const view = render(ui(0));
  return { ...view, reshow: (session: number) => view.rerender(ui(session)) };
}
const input = () => screen.getByLabelText("Question") as HTMLTextAreaElement;
const modelSelect = () => screen.getByLabelText("Model") as HTMLSelectElement;
const ready = () => waitFor(() => expect(modelSelect()).toBeInTheDocument());
async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(input(), text);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  h.providers = [provider()];
  h.models = [model(), model({ id: "m2", name: "Model Two" })];
  h.requests.length = 0;
  h.budget = null;
  instantTurn("ok");
});

describe("QuickAskView", () => {
  it("starts with the default model, a question box and the not-saved notice", async () => {
    open();
    await ready();
    expect(modelSelect().value).toBe("p1\nm1");
    expect(input()).toHaveFocus();
    expect(screen.getByText("Not saved unless you open it in Gustaf.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open in Gustaf" })).not.toBeInTheDocument();
  });

  it("streams the answer as Markdown, sends a plain no-tools turn and reports usage", async () => {
    const user = userEvent.setup();
    const release = gatedTurn(["Use **bold** ", "and `code`"]);
    open();
    await ready();
    await ask(user, "What is Rust?");
    expect(await screen.findByText("bold")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Gustaf" })).not.toBeInTheDocument();
    release();
    await screen.findByRole("button", { name: "Open in Gustaf" });
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    const req = h.requests[0];
    expect(req).toMatchObject({ model: "m1", tools: [], access: "readonly", mode: "ask" });
    expect(req.system).toMatch(/quick-ask/);
    expect(req.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "What is Rust?" }] }]);
    expect(quickAskApi.emitUsage).toHaveBeenCalledWith({ providerId: "p1", model: "m1", usage });
  });

  it("switches the model for the question", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.selectOptions(modelSelect(), "p1\nm2");
    await ask(user, "hi");
    await waitFor(() => expect(h.requests[0]?.model).toBe("m2"));
  });

  it("Stop ends the request, keeps the partial answer and ignores what arrives later", async () => {
    const user = userEvent.setup();
    gatedTurn(["partial answer"]);
    open();
    await ready();
    await ask(user, "long one");
    await screen.findByText("partial answer");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("partial answer")).toBeInTheDocument();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Open in Gustaf" })).toBeEnabled();
    expect(quickAskApi.emitUsage).not.toHaveBeenCalled();
  });

  it("shows a failure and offers no Open in Gustaf", async () => {
    const user = userEvent.setup();
    h.turn = async () => { throw new Error("HTTP 401 invalid key"); };
    open();
    await ready();
    await ask(user, "q");
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 401 invalid key");
    expect(screen.queryByRole("button", { name: "Open in Gustaf" })).not.toBeInTheDocument();
    expect(quickAskApi.emitUsage).toHaveBeenCalledWith({ providerId: "p1", model: "m1", error: "HTTP 401 invalid key" });
  });

  it("refuses to ask when the daily token budget is used up", async () => {
    const user = userEvent.setup();
    h.budget = "day";
    open();
    await ready();
    await ask(user, "q");
    expect(await screen.findByRole("alert")).toHaveTextContent("daily token budget");
    expect(h.requests).toHaveLength(0);
  });

  it("Copy puts the answer on the clipboard", async () => {
    const user = userEvent.setup();
    instantTurn("The ", "answer");
    open();
    await ready();
    await ask(user, "q");
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("The answer");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("Open in Gustaf stores a normal chat with the exchange, tells the main window and brings it forward", async () => {
    const user = userEvent.setup();
    instantTurn("Stored answer");
    open();
    await ready();
    await ask(user, "Remember this");
    await user.click(await screen.findByRole("button", { name: "Open in Gustaf" }));
    await waitFor(() => expect(quickAskApi.openMain).toHaveBeenCalled());
    expect(createChat).toHaveBeenCalledWith(null, "Remember this");
    expect(vi.mocked(addMessage).mock.calls.map(([chatId, m]) => [chatId, m.role, (m.parts[0] as any).text])).toEqual([
      [42, "user", "Remember this"],
      [42, "assistant", "Stored answer"],
    ]);
    expect(vi.mocked(addMessage).mock.calls[1][1].meta).toEqual({ provider: "p1", model: "m1", usage });
    expect(quickAskApi.emitOpenChat).toHaveBeenCalledWith({ chatId: 42 });
    expect(vi.mocked(quickAskApi.emitOpenChat).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(quickAskApi.openMain).mock.invocationCallOrder[0]);
    // the window is clean afterwards
    await waitFor(() => expect(input()).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "Open in Gustaf" })).not.toBeInTheDocument();
  });

  it("nothing is stored unless Open in Gustaf is used", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await ask(user, "q");
    await screen.findByRole("button", { name: "Open in Gustaf" });
    expect(createChat).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("a failed save reports it, removes the half-made chat and does not switch windows", async () => {
    const user = userEvent.setup();
    vi.mocked(addMessage).mockRejectedValueOnce(new Error("disk full"));
    open();
    await ready();
    await ask(user, "q");
    await user.click(await screen.findByRole("button", { name: "Open in Gustaf" }));
    expect(await screen.findByText(/Could not open the chat: disk full/)).toBeInTheDocument();
    expect(quickAskApi.openMain).not.toHaveBeenCalled();
    expect(callsOf("db_execute").some((a: any) => /delete from chats/.test(a.sql) && a.params[0] === 42)).toBe(true);
  });

  describe("clipboard text", () => {
    it("is off by default and nothing is read until the switch is turned on", async () => {
      const user = userEvent.setup();
      await navigator.clipboard.writeText("secret from the clipboard");
      open();
      await ready();
      expect(screen.getByRole("switch", { name: "Include clipboard text" })).toHaveAttribute("aria-checked", "false");
      expect(screen.queryByText(/secret from the clipboard/)).not.toBeInTheDocument();
      await ask(user, "plain question");
      await waitFor(() => expect(h.requests).toHaveLength(1));
      expect(h.requests[0].messages[0].parts[0].text).toBe("plain question");
    });

    it("shows what will be sent, sends exactly that, and can be turned off again", async () => {
      const user = userEvent.setup();
      await navigator.clipboard.writeText("line one\nline two");
      open();
      await ready();
      await user.click(screen.getByRole("switch", { name: "Include clipboard text" }));
      const preview = await screen.findByRole("group", { name: "Clipboard text sent with your question" });
      expect(preview).toHaveTextContent("line one");
      expect(preview).toHaveTextContent("17 characters of clipboard text will be sent.");
      await ask(user, "explain");
      await waitFor(() => expect(h.requests).toHaveLength(1));
      expect(h.requests[0].messages[0].parts[0].text).toBe("explain\n\nClipboard text:\n```\nline one\nline two\n```");
      await user.click(screen.getByRole("switch", { name: "Include clipboard text" }));
      expect(screen.queryByRole("group", { name: "Clipboard text sent with your question" })).not.toBeInTheDocument();
    });

    it("reports an empty clipboard and an unreadable one", async () => {
      const user = userEvent.setup();
      open();
      await ready();
      vi.spyOn(navigator.clipboard, "readText").mockResolvedValueOnce("  \n");
      await user.click(screen.getByRole("switch", { name: "Include clipboard text" }));
      expect(await screen.findByText("The clipboard has no text; nothing extra is sent.")).toBeInTheDocument();
      await user.click(screen.getByRole("switch", { name: "Include clipboard text" }));
      vi.spyOn(navigator.clipboard, "readText").mockRejectedValueOnce(new Error("denied"));
      await user.click(screen.getByRole("switch", { name: "Include clipboard text" }));
      expect(await screen.findByText("The clipboard could not be read.")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Include clipboard text" })).toHaveAttribute("aria-checked", "false");
    });
  });

  it("Esc ends a running request and hides the window", async () => {
    const user = userEvent.setup();
    gatedTurn(["working"]);
    open();
    await ready();
    await ask(user, "q");
    await screen.findByText("working");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(quickAskApi.hide).toHaveBeenCalled();
    await waitFor(() => expect(h.requests[0].signal.aborted).toBe(true));
  });

  it("each time the window is shown the previous exchange is dropped", async () => {
    const user = userEvent.setup();
    const { reshow } = open();
    await ready();
    await ask(user, "first question");
    await screen.findByRole("button", { name: "Open in Gustaf" });
    act(() => reshow(1));
    await waitFor(() => expect(input()).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "Open in Gustaf" })).not.toBeInTheDocument();
  });

  it("falls back to another model, with a note, when the default is a CLI provider", async () => {
    h.providers = [provider({ id: "c", kind: "cli", name: "Claude CLI" }), provider()];
    h.models = [model({ providerId: "c", id: "sonnet" }), model()];
    open({ selection: { providerId: "c", model: "sonnet" } });
    await ready();
    expect(modelSelect().value).toBe("p1\nm1");
    expect(screen.getByText(/runs through a CLI/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /sonnet/ })).not.toBeInTheDocument();
  });

  it("explains when there is no usable model", async () => {
    h.providers = [provider({ id: "c", kind: "cli", name: "Claude CLI" })];
    h.models = [model({ providerId: "c", id: "sonnet" })];
    open({ selection: { providerId: "c", model: "sonnet" } });
    expect(await screen.findByText(/No model available/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("asks the window to follow the content height", async () => {
    open();
    await ready();
    expect(quickAskApi.resize).toHaveBeenCalled();
  });
});
