import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPalette } from "../../src/components/SearchPalette";
import type { SearchHit } from "../../src/lib/api";
import { makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const hit = (id: number, over: Partial<SearchHit> = {}): SearchHit => ({
  messageId: id, chatId: id * 10, chatTitle: `Chat ${id}`, projectId: 1, projectName: "Alpha", archived: false,
  role: "assistant", model: "m1", createdAt: 1_700_000_000_000, snippet: `about \u0001parser\u0002 number ${id}`, ...over,
});

/** Let the debounce timer fire and the resulting (mocked) invoke promises settle, all under fake timers. */
const settle = async (ms = 200) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const input = () => screen.getByPlaceholderText(/Search messages in all chats/);
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const rows = () => within(screen.getByRole("listbox")).queryAllByRole("option");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SearchPalette", () => {
  it("starts with the hint and does not search for a too-short query", async () => {
    mockInvoke({ search_messages: [hit(1)] });
    renderApp(<SearchPalette onClose={() => {}} />);
    expect(screen.getByText(/Search the text of every message/)).toBeInTheDocument();
    type("a");
    await settle();
    expect(callsOf("search_messages")).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("debounces typing: one request for the last text, none before the delay", async () => {
    mockInvoke({ search_messages: [hit(1)] });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("par");
    await settle(100);
    type("pars");
    await settle(100);
    expect(callsOf("search_messages")).toHaveLength(0);
    await settle(100);
    expect(callsOf("search_messages")).toHaveLength(1);
    expect(callsOf("search_messages")[0]).toMatchObject({ query: "pars", projectId: null, model: null });
    expect(rows()).toHaveLength(1);
  });

  it("renders hits with the matched words highlighted and the result count", async () => {
    mockInvoke({ search_messages: [hit(1), hit(2)] });
    const { container } = renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    expect(rows()).toHaveLength(2);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelector("mark")).toHaveTextContent("parser");
    expect(screen.getByRole("status")).toHaveTextContent("2");
  });

  it("highlights the first hit; arrows move and wrap around", async () => {
    mockInvoke({ search_messages: [hit(1), hit(2), hit(3)] });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    const selected = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    expect(input()).toHaveAttribute("aria-activedescendant", "search-hit-0");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toBe(0);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selected()).toBe(2);
    expect(input()).toHaveAttribute("aria-activedescendant", "search-hit-2");
  });

  it("Enter opens the highlighted hit at its message and closes the palette", async () => {
    mockInvoke({ search_messages: [hit(1), hit(2)] });
    const onClose = vi.fn();
    const { app } = renderApp(<SearchPalette onClose={onClose} />);
    type("parser");
    await settle();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(app.openChatAt).toHaveBeenCalledWith(20, 1, 2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking a hit opens it too", async () => {
    mockInvoke({ search_messages: [hit(1), hit(2)] });
    const { app } = renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    fireEvent.click(rows()[1]);
    expect(app.openChatAt).toHaveBeenCalledWith(20, 1, 2);
  });

  it("Enter with no results does nothing", async () => {
    mockInvoke({ search_messages: [] });
    const { app } = renderApp(<SearchPalette onClose={() => {}} />);
    type("nothing");
    await settle();
    expect(screen.getByText(/Nothing found for/)).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(app.openChatAt).not.toHaveBeenCalled();
  });

  it("Escape closes, and keys do not leak to handlers outside the palette", () => {
    const onClose = vi.fn();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    renderApp(<SearchPalette onClose={onClose} />);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  it("a click on the backdrop closes it, a click inside does not", () => {
    const onClose = vi.fn();
    const { container } = renderApp(<SearchPalette onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector(".search-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("changing the project filter searches again immediately with that project", async () => {
    mockInvoke({ search_messages: [hit(1)] });
    renderApp(<SearchPalette onClose={() => {}} />, makeApp({ projects: [project({ id: 7, name: "Gamma" })] }));
    type("parser");
    await settle();
    expect(callsOf("search_messages")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "7" } });
    await settle(0);
    expect(callsOf("search_messages")).toHaveLength(2);
    expect(callsOf("search_messages")[1]).toMatchObject({ query: "parser", projectId: 7 });
  });

  it("only the newest request updates the list when answers arrive out of order", async () => {
    const pending: Record<string, (v: SearchHit[]) => void> = {};
    mockInvoke({ search_messages: ({ query }: { query: string }) => new Promise((res) => { pending[query] = res; }) });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("first");
    await settle();
    type("second");
    await settle();
    await act(async () => { pending.second([hit(2, { chatTitle: "Newest answer" })]); });
    await act(async () => { pending.first([hit(1, { chatTitle: "Stale answer" })]); });
    expect(screen.getByText("Newest answer")).toBeInTheDocument();
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
  });

  it("shows the backend error", async () => {
    mockInvoke({ search_messages: () => Promise.reject(new Error("index broken")) });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("index broken");
  });
});
