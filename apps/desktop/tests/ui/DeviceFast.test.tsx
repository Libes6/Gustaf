import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePanel } from "../../src/components/device/DevicePanel";
import { createFakeDriver } from "../../src/device/fakeDriver";
import type { ActionResult, HumanInput } from "../../src/device/types";
import { fitScreen, parseSnapshot } from "../../src/device/uiMap";
import snapshot from "../fixtures/device-ios-settings-snapshot.json";
import { renderApp } from "./render";

const real = parseSnapshot(snapshot);
const BOX = { width: 400, height: 800 };
const SHOWN = fitScreen({ width: 402, height: 874 }, BOX);
const FAST = { active: 20, idle: 40, activeWindowMs: 1000 };
const view = (x: number, y: number) => ({
  clientX: SHOWN.x + (x * SHOWN.width) / 402,
  clientY: SHOWN.y + (y * SHOWN.height) / 874,
});
const done = (message: string): ActionResult => ({ message, diff: "", settled: true });

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const on = this.classList?.contains("dev-screen");
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: on ? 400 : 0,
      bottom: on ? 800 : 0,
      width: on ? 400 : 0,
      height: on ? 800 : 0,
      toJSON() {},
    };
  });
});

/** The fake driver with fast human input; every human call is recorded in the same call log. */
function setup(o: { touch?: (phase: string) => boolean; tapMs?: number } = {}) {
  const f = createFakeDriver({ map: real });
  const rec = (method: string, args: unknown[]) => f.calls.push({ method: `human.${method}`, args });
  const human: HumanInput = {
    tap: async (id, t) => (
      rec("tap", [id, t]),
      o.tapMs ? await new Promise((r) => setTimeout(r, o.tapMs)) : undefined,
      done("tap")
    ),
    longPress: async (id, t, ms) => (rec("longPress", [id, t, ms]), done("lp")),
    swipe: async (id, a, b, ms) => (rec("swipe", [id, a, b, ms]), done("swipe")),
    type: async (id, text) => (rec("type", [id, text]), done("type")),
    fill: async () => done("fill"),
    press: async (id, k) => (rec("press", [id, k]), done("press")),
    scroll: async () => done("scroll"),
    touch: o.touch ? (_id, phase, at) => (rec("touch", [phase, at]), o.touch!(phase)) : undefined,
  };
  f.driver.human = human;
  return f;
}

async function openLive(f: ReturnType<typeof setup>) {
  renderApp(<DevicePanel driver={f.driver} intervals={FAST} />);
  await userEvent.click(await screen.findByRole("button", { name: "Open iPhone 17 Pro" }));
  const box = await screen.findByRole("group", { name: "Device screen" });
  await waitFor(() => expect(box.querySelector("img")).not.toBeNull());
  await screen.findByText("Settings");
  return box;
}
const count = (f: ReturnType<typeof setup>, method: string) => f.calls.filter((c) => c.method === method).length;

describe("fast human input", () => {
  it("sends clicks through the driver's human calls, not the verified ones", async () => {
    const f = setup();
    const box = await openLive(f);
    fireEvent.mouseDown(box, { ...view(201, 355), button: 0 });
    fireEvent.mouseUp(window, view(201, 355));
    await waitFor(() => expect(count(f, "human.tap")).toBe(1));
    expect(count(f, "tap")).toBe(0);
  });

  it("does not block the next click on the picture or the map: a second tap goes out while frames are still being fetched", async () => {
    const f = setup();
    const box = await openLive(f);
    for (let i = 0; i < 3; i++) {
      fireEvent.mouseDown(box, { ...view(100 + i, 355), button: 0 });
      fireEvent.mouseUp(window, view(100 + i, 355));
    }
    await waitFor(() => expect(count(f, "human.tap")).toBe(3));
  });

  it("reads the interface map once after a burst of taps, as a background snapshot, a moment after the last one", async () => {
    const f = setup();
    const box = await openLive(f);
    await waitFor(() => expect(count(f, "snapshot")).toBeGreaterThan(0));
    const before = count(f, "snapshot");
    for (let i = 0; i < 4; i++) {
      fireEvent.mouseDown(box, { ...view(100, 355 + i), button: 0 });
      fireEvent.mouseUp(window, view(100, 355 + i));
    }
    await waitFor(() => expect(count(f, "human.tap")).toBe(4));
    expect(count(f, "snapshot")).toBe(before); // not yet: the wait restarts with every tap
    await waitFor(() => expect(count(f, "snapshot")).toBe(before + 1), { timeout: 2500 });
    const snaps = f.calls.filter((c) => c.method === "snapshot");
    expect(snaps[snaps.length - 1].args[1]).toEqual({ background: true });
  });

  it("keeps fetching frames while an action is still running", async () => {
    const f = setup({ tapMs: 400 });
    const box = await openLive(f);
    fireEvent.mouseDown(box, { ...view(100, 355), button: 0 });
    fireEvent.mouseUp(window, view(100, 355));
    await waitFor(() => expect(count(f, "human.tap")).toBe(1));
    const frames = count(f, "frame");
    await new Promise((r) => setTimeout(r, 200)); // the tap is still in flight (400 ms)
    expect(count(f, "frame")).toBeGreaterThan(frames);
  });
});

describe("raw touch tracking", () => {
  it("streams down, move and up to the driver and does not also send a swipe", async () => {
    const f = setup({ touch: () => true });
    const box = await openLive(f);
    fireEvent.mouseDown(box, { ...view(200, 700), button: 0 });
    fireEvent.mouseMove(window, view(200, 600));
    fireEvent.mouseMove(window, view(200, 400));
    fireEvent.mouseUp(window, view(200, 300));
    const touches = f.calls.filter((c) => c.method === "human.touch").map((c) => (c.args as [string])[0]);
    expect(touches).toEqual(["down", "move", "move", "up"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(count(f, "human.swipe") + count(f, "human.tap") + count(f, "swipe") + count(f, "tap")).toBe(0);
  });

  it("falls back to the classified gesture when the driver says it cannot track the touch", async () => {
    const f = setup({ touch: () => false });
    const box = await openLive(f);
    fireEvent.mouseDown(box, { ...view(200, 700), button: 0 });
    fireEvent.mouseMove(window, view(200, 400));
    fireEvent.mouseUp(window, view(200, 300));
    await waitFor(() => expect(count(f, "human.swipe")).toBe(1));
    expect(f.calls.filter((c) => c.method === "human.touch").map((c) => (c.args as [string])[0])).toEqual(["down"]);
  });
});
