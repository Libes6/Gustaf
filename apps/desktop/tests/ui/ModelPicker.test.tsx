import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, contextLabel, newModelKeys } from "../../src/components/ModelPicker";
import type { Model } from "../../src/state";
import { makeApp, provider, renderApp } from "./render";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const m = (id: string, over: Partial<Model> = {}): Model => ({
  id,
  name: id,
  providerId: "p1",
  created: 0,
  firstSeen: 0,
  ...over,
});

describe("newModelKeys", () => {
  it("does not mark a whole list as new when the provider first answered with only `default`", () => {
    const codex = [
      m("default", { providerId: "codex", firstSeen: 0 }),
      ...["gpt-6-sol", "gpt-6-luna"].map((id) => m(id, { providerId: "codex", firstSeen: NOW - 2 * DAY })),
    ];
    expect(newModelKeys(codex, NOW).size).toBe(0);
  });

  it("marks models that appeared after the first listing, for two weeks", () => {
    const list = [
      m("old", { firstSeen: 0 }),
      m("recent", { firstSeen: NOW - 3 * DAY }),
      m("stale", { firstSeen: NOW - 20 * DAY }),
    ];
    expect([...newModelKeys(list, NOW)]).toEqual(["p1\nrecent"]);
  });
});

it("contextLabel shortens token counts", () => {
  expect([contextLabel(undefined), contextLabel(200_000), contextLabel(1_000_000), contextLabel(1_500_000)]).toEqual([
    "",
    "200K",
    "1M",
    "1.5M",
  ]);
});

describe("ModelPicker", () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    scroll.mockClear();
    Element.prototype.scrollIntoView = scroll;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  const providers = [
    provider({ id: "p1", name: "Anthropic" }),
    provider({ id: "p2", name: "Codex", kind: "cli", cli: "codex" }),
  ];
  const models = [
    ...Array.from({ length: 12 }, (_, i) =>
      m(`a${i}`, {
        providerId: "p1",
        name: `Alpha ${i}`,
        created: 100 - i,
        contextWindow: i === 0 ? 200_000 : undefined,
      }),
    ),
    m("default", { providerId: "p2", name: "Default" }),
    m("gpt-6", { providerId: "p2", name: "GPT-6" }),
  ];
  const app = (over: Record<string, unknown> = {}) =>
    makeApp({ providers, models, favorites: [], hiddenModels: [], modelErrors: {}, ...over });

  it("opens on the current model's tab with that model checked and highlighted, expanding the list if needed", () => {
    renderApp(
      <ModelPicker onClose={() => {}} />,
      app({ selection: { providerId: "p1", model: "a10" }, favorites: ["p2\ngpt-6"] }),
    );
    const selected = screen.getByRole("option", { selected: true });
    expect(selected).toHaveTextContent("Alpha 10");
    expect(selected.className).toContain("hl");
    expect(selected.querySelector(".sel-check")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Anthropic" })).toHaveAttribute("aria-pressed", "true");
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("hovering never scrolls the list; arrow keys do", () => {
    renderApp(<ModelPicker onClose={() => {}} />, app({ selection: { providerId: "p1", model: "a0" } }));
    scroll.mockClear();
    const rows = screen.getAllByRole("option");
    fireEvent.mouseMove(rows[5]);
    expect(rows[5].className).toContain("hl");
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(rows[6].className).toContain("hl");
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("a picker closed right after opening leaves no listener that closes the next one", async () => {
    const first = vi.fn();
    const { unmount } = renderApp(
      <ModelPicker onClose={first} />,
      app({ selection: { providerId: "p1", model: "a0" } }),
    );
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    const second = vi.fn();
    renderApp(<ModelPicker onClose={second} />, app({ selection: { providerId: "p1", model: "a0" } }));
    await new Promise((r) => setTimeout(r, 10));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Codex" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("shows the context window on the row", () => {
    renderApp(<ModelPicker onClose={() => {}} />, app({ selection: { providerId: "p1", model: "a0" } }));
    expect(within(screen.getAllByRole("option")[0]).getByText("200K")).toBeInTheDocument();
  });

  it("a provider whose list failed shows the error with Retry, which refreshes only that provider", async () => {
    const a = app({
      selection: { providerId: "p2", model: "gpt-6" },
      models: models.filter((x) => x.providerId === "p1"),
      modelErrors: { p2: "codex: not logged in" },
    });
    renderApp(<ModelPicker onClose={() => {}} />, a);
    expect(screen.getByRole("alert")).toHaveTextContent("codex: not logged in");
    const retry = within(screen.getByRole("alert")).getByRole("button", { name: /Retry/ });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(a.refreshModels).toHaveBeenCalledWith({ only: ["p2"] });
  });

  it("a saved list with a failed refresh stays usable and says so", () => {
    renderApp(
      <ModelPicker onClose={() => {}} />,
      app({ selection: { providerId: "p2", model: "gpt-6" }, modelErrors: { p2: "timeout" } }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh this list");
  });
});
