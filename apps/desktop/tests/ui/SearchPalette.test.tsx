import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPalette } from "../../src/components/SearchPalette";
import type { SearchHit, SearchPage } from "../../src/lib/api";
import { chat, makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const hit = (id: number, over: Partial<SearchHit> = {}): SearchHit => ({
  messageId: id, chatId: id * 10, chatTitle: `Chat ${id}`, projectId: 1, projectName: "Alpha", archived: false,
  role: "assistant", model: "m1", createdAt: 1_700_000_000_000, snippet: `about \u0001parser\u0002 number ${id}`, ...over,
});

const page = (hits: SearchHit[], over: Partial<SearchPage> = {}): SearchPage => ({
  hits, total: hits.length, totalCapped: false, byRecency: false, hasMore: false, ...over,
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
    mockInvoke({ search_messages: page([hit(1)]) });
    renderApp(<SearchPalette onClose={() => {}} />);
    expect(screen.getByText(/Search the text of every message/)).toBeInTheDocument();
    type("a");
    await settle();
    expect(callsOf("search_messages")).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("debounces typing: one request for the last text, none before the delay", async () => {
    mockInvoke({ search_messages: page([hit(1)]) });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("par");
    await settle(100);
    type("pars");
    await settle(100);
    expect(callsOf("search_messages")).toHaveLength(0);
    await settle(100);
    expect(callsOf("search_messages")).toHaveLength(1);
    expect(callsOf("search_messages")[0]).toMatchObject({ query: "pars", projectId: null, model: null, offset: 0 });
    expect(rows()).toHaveLength(1);
  });

  it("renders hits with the matched words highlighted and the result count", async () => {
    mockInvoke({ search_messages: page([hit(1), hit(2)]) });
    const { container } = renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    expect(rows()).toHaveLength(2);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelector("mark")).toHaveTextContent("parser");
    expect(screen.getByRole("status")).toHaveTextContent("2");
  });

  it("highlights the first hit; arrows move and wrap around", async () => {
    mockInvoke({ search_messages: page([hit(1), hit(2), hit(3)]) });
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
    mockInvoke({ search_messages: page([hit(1), hit(2)]) });
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
    mockInvoke({ search_messages: page([hit(1), hit(2)]) });
    const { app } = renderApp(<SearchPalette onClose={() => {}} />);
    type("parser");
    await settle();
    fireEvent.click(rows()[1]);
    expect(app.openChatAt).toHaveBeenCalledWith(20, 1, 2);
  });

  it("Enter with no results does nothing", async () => {
    mockInvoke({ search_messages: page([]) });
    const { app } = renderApp(<SearchPalette onClose={() => {}} />);
    type("qzxwvk");
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
    mockInvoke({ search_messages: page([hit(1)]) });
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
    const pending: Record<string, (v: SearchPage) => void> = {};
    mockInvoke({ search_messages: ({ query }: { query: string }) => new Promise((res) => { pending[query] = res; }) });
    renderApp(<SearchPalette onClose={() => {}} />);
    type("first");
    await settle();
    type("second");
    await settle();
    await act(async () => { pending.second(page([hit(2, { chatTitle: "Newest answer" })])); });
    await act(async () => { pending.first(page([hit(1, { chatTitle: "Stale answer" })])); });
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
  describe("paging", () => {
    const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => hit(from + i));
    /** A backend with `count` hits that answers by offset/limit like search_messages. */
    const backend = (count: number, calls: { offset: number }[] = []) =>
      mockInvoke({
        search_messages: ({ offset, limit }: { offset: number; limit: number }) => {
          calls.push({ offset });
          const hits = ids(offset + 1, Math.min(count, offset + limit));
          return page(hits, { total: count, hasMore: offset + hits.length < count });
        },
      });

    it("shows the first page with a Load more button and the total", async () => {
      backend(100);
      renderApp(<SearchPalette onClose={() => {}} />);
      type("parser");
      await settle();
      expect(rows()).toHaveLength(40);
      expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("40 of 100");
    });

    it("Load more appends the next page after the existing rows, then disappears at the end", async () => {
      const calls: { offset: number }[] = [];
      backend(70, calls);
      renderApp(<SearchPalette onClose={() => {}} />);
      type("parser");
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      await settle(0);
      expect(calls.map((c) => c.offset)).toEqual([0, 40]);
      expect(rows()).toHaveLength(70);
      expect(rows()[0]).toHaveTextContent("Chat 1");
      expect(rows()[69]).toHaveTextContent("Chat 70");
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("70 results");
    });

    it("Arrow Down on the last row loads the next page and moves onto its first new row", async () => {
      const calls: { offset: number }[] = [];
      backend(60, calls);
      renderApp(<SearchPalette onClose={() => {}} />);
      type("parser");
      await settle();
      const selected = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
      fireEvent.keyDown(input(), { key: "ArrowUp" }); // wraps to the last row of the loaded page
      expect(selected()).toBe(39);
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await settle(0);
      expect(calls.map((c) => c.offset)).toEqual([0, 40]);
      expect(rows()).toHaveLength(60);
      expect(selected()).toBe(40);
      // Everything is loaded now, so the end wraps again and no further page is requested.
      fireEvent.keyDown(input(), { key: "ArrowUp" });
      expect(selected()).toBe(39);
      for (let i = 0; i < 20; i++) fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(selected()).toBe(59);
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(selected()).toBe(0);
      expect(calls).toHaveLength(2);
    });

    it("does not request the same page twice while one is loading", async () => {
      const calls: { offset: number }[] = [];
      let release: (v: SearchPage) => void = () => {};
      mockInvoke({
        search_messages: ({ offset }: { offset: number }) => {
          calls.push({ offset });
          if (offset === 0) return page(ids(1, 40), { total: 80, hasMore: true });
          return new Promise((res) => { release = res; });
        },
      });
      renderApp(<SearchPalette onClose={() => {}} />);
      type("parser");
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      fireEvent.keyDown(input(), { key: "ArrowUp" });
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(calls).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
      await act(async () => { release(page(ids(41, 80), { total: 80 })); });
      expect(rows()).toHaveLength(80);
    });

    it("a page that arrives after the query changed is dropped", async () => {
      let release: (v: SearchPage) => void = () => {};
      mockInvoke({
        search_messages: ({ query, offset }: { query: string; offset: number }) => {
          if (query === "parser" && offset === 0) return page(ids(1, 40), { total: 80, hasMore: true });
          if (query === "parser") return new Promise((res) => { release = res; });
          return page([hit(500, { chatTitle: "Other query" })]);
        },
      });
      renderApp(<SearchPalette onClose={() => {}} />);
      type("parser");
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      type("other");
      await settle();
      await act(async () => { release(page(ids(41, 80), { total: 80 })); });
      expect(rows()).toHaveLength(1);
      expect(screen.getByText("Other query")).toBeInTheDocument();
    });

    it("says when the total is capped and when hits are newest first", async () => {
      mockInvoke({ search_messages: page(ids(1, 40), { total: 1000, totalCapped: true, hasMore: true, byRecency: true }) });
      renderApp(<SearchPalette onClose={() => {}} />);
      type("the");
      await settle();
      expect(screen.getByRole("status")).toHaveTextContent("40 of 1000+");
      expect(screen.getByRole("status")).toHaveTextContent("newest first");
    });

    it("offers a current-project toggle that filters by the open project", async () => {
      mockInvoke({ search_messages: page([hit(1)]) });
      renderApp(<SearchPalette onClose={() => {}} />, makeApp({ draftProject: 7, projects: [project({ id: 7, name: "Gamma" })] }));
      type("parser");
      await settle();
      fireEvent.click(screen.getByRole("checkbox", { name: "Only this project" }));
      await settle(0);
      expect(callsOf("search_messages")[1]).toMatchObject({ projectId: 7, offset: 0 });
      fireEvent.click(screen.getByRole("checkbox", { name: "Only this project" }));
      await settle(0);
      expect(callsOf("search_messages")[2]).toMatchObject({ projectId: null });
    });

    it("has no project toggle when no project is open", () => {
      renderApp(<SearchPalette onClose={() => {}} />);
      expect(screen.queryByRole("checkbox", { name: "Only this project" })).not.toBeInTheDocument();
    });
  });
});

describe("SearchPalette jumps", () => {
  it("offers chats by title or #id and settings pages above the message hits", () => {
    const onClose = vi.fn();
    const app = makeApp({ chats: [chat({ id: 12, project_id: null, title: "Release notes draft" })], projects: [] });
    renderApp(<SearchPalette onClose={onClose} />, app);
    const input = document.querySelector<HTMLInputElement>(".search-input input")!;
    fireEvent.change(input, { target: { value: "#12" } });
    expect(screen.getByRole("option", { name: /Release notes draft/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(app.openChat).toHaveBeenCalledWith(12, null);
    expect(onClose).toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "provid" } });
    expect(screen.getByRole("option", { name: /Model providers/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(app.openSettings).toHaveBeenCalledWith("providers");
  });
});

it("Restart agent session is offered for the open chat and asks it to restart", () => {
  const onClose = vi.fn();
  const heard = vi.fn();
  addEventListener("gustaf-restart-session", heard);
  renderApp(<SearchPalette onClose={onClose} />, makeApp({ activeChat: 3, view: "chat", chats: [], projects: [] }));
  const input = document.querySelector<HTMLInputElement>(".search-input input")!;
  fireEvent.change(input, { target: { value: "restart" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(heard).toHaveBeenCalledTimes(1);
  removeEventListener("gustaf-restart-session", heard);
});
