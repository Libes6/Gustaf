import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/components/ModelPicker";
import { fanOutCore, FAN_OUT_MAX } from "../../src/lib/fanOut";
import type { Model } from "../../src/state";
import { makeApp, provider, renderApp } from "./render";

const target = (model: string) => ({ providerId: "p1", model, name: model.toUpperCase() });

describe("fanOutCore", () => {
  it("creates workspaces one by one, runs them in parallel and reports each result", async () => {
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const results = await fanOutCore([target("a"), target("b"), target("c")], {
      create: async (t) => (
        order.push(`create ${t.model}`),
        t.model === "b"
          ? { ok: false, message: "no git" }
          : { ok: true, chatId: t.model === "a" ? 1 : 3, root: `/ws/${t.model}` }
      ),
      run: async (t, chatId, root) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        order.push(`run ${t.model} ${chatId} ${root}`);
        return { status: t.model === "c" ? "failed" : "success", chatId, error: t.model === "c" ? "quota" : undefined };
      },
    });
    expect(order.slice(0, 3)).toEqual(["create a", "create b", "create c"]);
    expect(peak).toBe(2);
    expect(results.map((r) => [r.target.model, r.status, r.chatId, r.error])).toEqual([
      ["a", "success", 1, undefined],
      ["b", "not-created", null, "no git"],
      ["c", "failed", 3, "quota"],
    ]);
  });

  it("never starts more than the limit", async () => {
    const create = vi.fn(async () => ({ ok: true as const, chatId: 1, root: "/ws" }));
    await fanOutCore(
      Array.from({ length: 6 }, (_, i) => target(`m${i}`)),
      { create, run: async () => ({ status: "success", chatId: 1 }) },
    );
    expect(create).toHaveBeenCalledTimes(FAN_OUT_MAX);
  });
});

describe("ModelPicker multi-pick", () => {
  const models: Model[] = ["a", "b", "c"].map((id) => ({
    id,
    name: `Model ${id}`,
    providerId: "p1",
    created: 0,
    firstSeen: 0,
  }));
  const app = () =>
    makeApp({
      providers: [provider()],
      models,
      selection: { providerId: "p1", model: "a" },
      favorites: [],
      hiddenModels: [],
      modelErrors: {},
    });

  it("shift-click toggles a model for the fan-out; a plain click still picks one", () => {
    const toggle = vi.fn();
    const a = app();
    renderApp(<ModelPicker onClose={() => {}} multi={{ keys: ["p1\na", "p1\nc"], toggle, max: 4 }} />, a);
    const rows = screen.getAllByRole("option");
    expect(within(rows[0]).getByRole("img", { name: "Picked for this prompt" })).toHaveTextContent("1");
    expect(within(rows[2]).getByRole("img", { name: "Picked for this prompt" })).toHaveTextContent("2");
    expect(screen.getByText(/2 of up to 4 models/)).toBeInTheDocument();
    fireEvent.click(rows[1], { shiftKey: true });
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(a.setSelection).not.toHaveBeenCalled();
    fireEvent.click(rows[1]);
    expect(a.setSelection).toHaveBeenCalledWith({ providerId: "p1", model: "b" });
  });

  it("without fan-out support shift-click is an ordinary pick and no hint is shown", () => {
    const a = app();
    renderApp(<ModelPicker onClose={() => {}} />, a);
    fireEvent.click(screen.getAllByRole("option")[1], { shiftKey: true });
    expect(a.setSelection).toHaveBeenCalledWith({ providerId: "p1", model: "b" });
    expect(screen.queryByText(/Shift-click/)).not.toBeInTheDocument();
  });
});
