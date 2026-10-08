import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePanel } from "../../src/components/device/DevicePanel";
import { DeviceDriverContext } from "../../src/components/device/driverContext";
import { createFakeDriver } from "../../src/device/fakeDriver";
import { DeviceError } from "../../src/device/types";
import { fitScreen, parseSnapshot } from "../../src/device/uiMap";
import snapshot from "../fixtures/device-ios-settings-snapshot.json";
import { renderApp } from "./render";

const real = parseSnapshot(snapshot);
const BOX = { width: 400, height: 800 };
const SHOWN = fitScreen({ width: 402, height: 874 }, BOX); // letterboxed: bars left and right
const FAST = { active: 20, idle: 40, activeWindowMs: 1000 };

/** A point of the device in the screen box's own pixels. */
const view = (x: number, y: number) => ({
  clientX: SHOWN.x + (x * SHOWN.width) / 402,
  clientY: SHOWN.y + (y * SHOWN.height) / 874,
});
const setup = (o: Parameters<typeof createFakeDriver>[0] = {}) => createFakeDriver({ map: real, ...o });

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

async function openLive(f = setup(), props: Partial<React.ComponentProps<typeof DevicePanel>> = {}) {
  const r = renderApp(<DevicePanel driver={f.driver} intervals={FAST} {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "Open iPhone 17 Pro" }));
  const box = await screen.findByRole("group", { name: "Device screen" });
  await waitFor(() => expect(box.querySelector("img")).not.toBeNull());
  await waitFor(() => expect(f.calls.some((c) => c.method === "snapshot")).toBe(true));
  await screen.findByText("Settings");
  return { ...r, f, box };
}
const taps = (f: ReturnType<typeof setup>) => f.calls.filter((c) => c.method === "tap");

describe("setup states", () => {
  it("says so when no driver is wired", () => {
    renderApp(<DevicePanel driver={null} />);
    expect(screen.getByText("Device control is not available")).toBeInTheDocument();
  });

  it("falls back to the driver from the context", async () => {
    const f = setup();
    renderApp(
      <DeviceDriverContext.Provider value={f.driver}>
        <DevicePanel />
      </DeviceDriverContext.Provider>,
    );
    expect(await screen.findByText("iPhone 16e")).toBeInTheDocument();
  });

  it("shows why the toolchain is missing and can check again", async () => {
    const f = setup({
      toolchain: {
        ios: { available: false, reason: "Xcode command line tools are missing" },
        android: { available: false, reason: "adb not found" },
      },
    });
    renderApp(<DevicePanel driver={f.driver} />);
    expect(await screen.findByText(/Xcode command line tools are missing/)).toBeInTheDocument();
    expect(screen.getByText(/adb not found/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(f.calls.filter((c) => c.method === "toolchain")).toHaveLength(2));
  });

  it("installs the helper only after the click, and shows its progress", async () => {
    const f = setup({ toolchain: { helper: { installed: false, pinned: "0.21.23" } } });
    renderApp(<DevicePanel driver={f.driver} />);
    const button = await screen.findByRole("button", { name: "Install helper (agent-device 0.21.23, from npm)" });
    await screen.findByText("iPhone 16e");
    expect(f.calls.some((c) => c.method === "installHelper")).toBe(false);
    await userEvent.click(button);
    expect(await screen.findByText("installed")).toBeInTheDocument();
    expect(f.calls.filter((c) => c.method === "installHelper")).toHaveLength(1);
  });

  it("shows an install failure", async () => {
    const f = setup({ toolchain: { helper: { installed: false, pinned: "0.21.23" } } });
    f.driver.installHelper = () => Promise.reject(new Error("npm exited with 1"));
    renderApp(<DevicePanel driver={f.driver} />);
    await userEvent.click(await screen.findByRole("button", { name: /Install helper/ }));
    expect(await screen.findByText("npm exited with 1")).toBeInTheDocument();
  });
});

describe("device list", () => {
  it("lists devices, boots one and opens it", async () => {
    const f = setup();
    renderApp(<DevicePanel driver={f.driver} intervals={FAST} />);
    expect(await screen.findByText("iPhone 17 Pro")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start iPhone 16e" }));
    expect(f.calls.some((c) => c.method === "boot" && c.args[0] === "SIM-2")).toBe(true);
    expect(await screen.findByRole("group", { name: "Device screen" })).toBeInTheDocument();
    expect(screen.getByText("iPhone 16e")).toBeInTheDocument();
  });

  it("powers a running device off", async () => {
    const f = setup();
    renderApp(<DevicePanel driver={f.driver} />);
    await userEvent.click(await screen.findByRole("button", { name: "Power off iPhone 17 Pro" }));
    await waitFor(() => expect(f.devices[0].state).toBe("shutdown"));
    expect(await screen.findByRole("button", { name: "Start iPhone 17 Pro" })).toBeInTheDocument();
  });

  it("shows a boot error", async () => {
    const f = setup();
    renderApp(<DevicePanel driver={f.driver} />);
    await screen.findByText("iPhone 16e");
    f.state.failNext = "Unable to boot device in current state";
    await userEvent.click(screen.getByRole("button", { name: "Start iPhone 16e" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to boot device in current state");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("interact mode", () => {
  it("maps a click through the letterboxing to the device point", async () => {
    const { f, box } = await openLive();
    // Left bar: outside the drawn screen, nothing is sent.
    fireEvent.mouseDown(box, { clientX: 3, clientY: 400, button: 0 });
    fireEvent.mouseUp(window, { clientX: 3, clientY: 400 });
    expect(taps(f)).toHaveLength(0);

    fireEvent.mouseDown(box, { ...view(201, 355), button: 0 });
    fireEvent.mouseUp(window, view(201, 355));
    await waitFor(() => expect(taps(f)).toHaveLength(1));
    const at = taps(f)[0].args[1] as { x: number; y: number };
    expect(at.x).toBeCloseTo(201, 3);
    expect(at.y).toBeCloseTo(355, 3);
  });

  it("turns a drag into a swipe and a hold into a long press", async () => {
    const { f, box } = await openLive();
    fireEvent.mouseDown(box, { ...view(200, 700), button: 0 });
    fireEvent.mouseUp(window, view(200, 300));
    await waitFor(() => expect(f.calls.some((c) => c.method === "swipe")).toBe(true));
    const [, from, to] = f.calls.find((c) => c.method === "swipe")!.args as [
      string,
      { x: number; y: number },
      { x: number; y: number },
    ];
    expect(from.y).toBeCloseTo(700, 3);
    expect(to.y).toBeCloseTo(300, 3);

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    now.mockReturnValue(1800);
    fireEvent.mouseUp(window, view(100, 100));
    await waitFor(() => expect(f.calls.some((c) => c.method === "longPress")).toBe(true));
  });

  it("batches typed characters into one call and sends Enter as a key", async () => {
    const { f, box } = await openLive();
    box.focus();
    fireEvent.keyDown(box, { key: "h" });
    fireEvent.keyDown(box, { key: "i" });
    await waitFor(() => expect(f.calls.find((c) => c.method === "type")?.args[1]).toBe("hi"));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(f.calls.some((c) => c.method === "press" && c.args[1] === "enter")).toBe(true));
  });

  it("sends the Home and app switcher buttons; Back only exists on Android", async () => {
    const { f } = await openLive();
    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    await userEvent.click(screen.getByRole("button", { name: "App switcher" }));
    await waitFor(() =>
      expect(f.calls.filter((c) => c.method === "press").map((c) => c.args[1])).toEqual(["home", "app-switcher"]),
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("shows a busy state and keeps every click, in order", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tap = f.driver.tap;
    f.driver.tap = async (id, t) => {
      await gate;
      return tap(id, t);
    };
    const { box } = await openLive(f);
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    fireEvent.mouseUp(window, view(100, 100));
    fireEvent.mouseDown(box, { ...view(300, 500), button: 0 });
    fireEvent.mouseUp(window, view(300, 500));
    expect(await within(box).findByText(/Tapping \(\+1\)/)).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-busy", "true");
    release();
    await waitFor(() => expect(taps(f)).toHaveLength(2));
    expect((taps(f)[0].args[1] as { x: number }).x).toBeCloseTo(100, 3);
    expect((taps(f)[1].args[1] as { x: number }).x).toBeCloseTo(300, 3);
    await waitFor(() => expect(box).toHaveAttribute("aria-busy", "false"));
  });

  it("refreshes the map after an action", async () => {
    const { f, box } = await openLive();
    const before = f.calls.filter((c) => c.method === "snapshot").length;
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    fireEvent.mouseUp(window, view(100, 100));
    await waitFor(() => expect(f.calls.filter((c) => c.method === "snapshot").length).toBeGreaterThan(before));
  });

  it("shows a driver error from an action", async () => {
    const { f, box } = await openLive();
    f.state.failNext = "The screen did not respond";
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    fireEvent.mouseUp(window, view(100, 100));
    expect(await screen.findByRole("alert")).toHaveTextContent("The screen did not respond");
  });

  it("points at the helper install when an action needs the missing helper", async () => {
    const f = setup();
    f.driver.tap = () => Promise.reject(new DeviceError("agent-device is not installed", "helper-missing"));
    const { box } = await openLive(f);
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    fireEvent.mouseUp(window, view(100, 100));
    expect(await screen.findByRole("alert")).toHaveTextContent("Install the helper above");
  });
});

describe("inspect mode", () => {
  const generalCell = real.nodes.find((n) => n.id === "com.apple.settings.general")!;

  it("outlines the element under the pointer with a label chip and pins it on click", async () => {
    const { f, box } = await openLive();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.mouseMove(box, view(200, 355));
    const outline = await screen.findByTestId("dev-outline-hover");
    const k = SHOWN.width / 402;
    expect(parseFloat(outline.style.left)).toBeCloseTo(SHOWN.x + generalCell.rect.x * k, 3);
    expect(parseFloat(outline.style.top)).toBeCloseTo(SHOWN.y + generalCell.rect.y * k, 3);
    expect(parseFloat(outline.style.width)).toBeCloseTo(generalCell.rect.width * k, 3);
    expect(box).toHaveTextContent("cell · Основные");

    fireEvent.click(box, view(200, 355));
    const card = await screen.findByRole("region", { name: "Element details" });
    expect(card).toHaveTextContent("com.apple.settings.general");
    expect(card).toHaveTextContent("16, 329 · 370×52");
    expect(card).toHaveTextContent("Parents");
    expect(card).toHaveTextContent("collection");
    expect(card).toHaveTextContent("Hittable");
    expect(card).toHaveTextContent("Covered");
    expect(screen.getByTestId("dev-outline-pinned")).toBeInTheDocument();
    expect(f.calls.some((c) => c.method === "tap")).toBe(false); // inspecting never touches the device
  });

  it("copies the ref and the label, and taps the pinned element by ref", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { f, box } = await openLive();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(box, view(200, 355));
    const card = await screen.findByRole("region", { name: "Element details" });
    await userEvent.click(within(card).getByRole("button", { name: "Copy ref" }));
    expect(writeText).toHaveBeenLastCalledWith(`@${generalCell.ref}`);
    await userEvent.click(within(card).getByRole("button", { name: "Copy label" }));
    expect(writeText).toHaveBeenLastCalledWith("Основные");
    await userEvent.click(within(card).getByRole("button", { name: "Tap this" }));
    await waitFor(() => expect(taps(f)).toHaveLength(1));
    expect(taps(f)[0].args[1]).toEqual({ ref: generalCell.ref });
  });

  it("clicking outside any element unpins", async () => {
    const { box } = await openLive();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(box, view(200, 355));
    await screen.findByRole("region", { name: "Element details" });
    fireEvent.click(box, { clientX: 2, clientY: 2 }); // letterbox bar
    await waitFor(() => expect(screen.queryByRole("region", { name: "Element details" })).toBeNull());
  });
});

describe("interface map", () => {
  it("shows the app, the size and the tree with roles", async () => {
    await openLive();
    const tree = screen.getByRole("list", { name: "Interface map" });
    expect(screen.getByText("com.apple.Preferences")).toBeInTheDocument();
    expect(screen.getByText(/402×874/)).toBeInTheDocument();
    expect(within(tree).getByText("Основные")).toBeInTheDocument();
    expect(within(tree).getAllByText("cell").length).toBeGreaterThan(5);
  });

  it("searches and filters to interactive elements", async () => {
    await openLive();
    const tree = screen.getByRole("list", { name: "Interface map" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search elements" }), "камера");
    expect(within(tree).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "zzz-nothing");
    expect(screen.getByText("No elements match.")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox"));
    const all = within(tree).getAllByRole("listitem").length;
    await userEvent.click(screen.getByRole("checkbox", { name: "Interactive only" }));
    const interactive = within(tree).getAllByRole("listitem");
    expect(interactive.length).toBeLessThan(all);
    expect(within(tree).queryByText("image")).toBeNull();
  });

  it("outlines on the screen the element whose row is hovered", async () => {
    const { box } = await openLive();
    const row = screen.getByRole("button", { name: /^cell Камера$/ });
    await userEvent.hover(row);
    const outline = await screen.findByTestId("dev-outline-hover");
    expect(box).toContainElement(outline);
    expect(box).toHaveTextContent("cell · Камера");
    await userEvent.unhover(row);
    await waitFor(() => expect(screen.queryByTestId("dev-outline-hover")).toBeNull());
  });

  it("selects a row like a pin, and taps an actionable row by ref", async () => {
    const { f } = await openLive();
    await userEvent.click(screen.getByRole("button", { name: /^cell Камера$/ }));
    expect(await screen.findByRole("region", { name: "Element details" })).toHaveTextContent(
      "com.apple.settings.camera",
    );
    await userEvent.click(screen.getByRole("button", { name: "Tap Камера" }));
    await waitFor(() => expect(taps(f)).toHaveLength(1));
    expect(taps(f)[0].args[1]).toEqual({ ref: "e9" });
  });

  it("refreshes on request, shows the truncated note, and can be collapsed", async () => {
    const f = setup({ map: { ...real, truncated: true } });
    await openLive(f);
    expect(screen.getByText(/cut at the helper's element limit/)).toBeInTheDocument();
    const before = f.calls.filter((c) => c.method === "snapshot").length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh map" }));
    await waitFor(() => expect(f.calls.filter((c) => c.method === "snapshot").length).toBe(before + 1));
    await userEvent.click(screen.getByRole("button", { name: "Hide map" }));
    expect(screen.queryByRole("list", { name: "Interface map" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show map" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("agent control", () => {
  it("shows the banner, ignores taps with a visible reason, and Stop works", async () => {
    const onStopAgent = vi.fn();
    const { f, box } = await openLive(setup(), { agentActive: true, agentLabel: "Checkout flow", onStopAgent });
    expect(screen.getByText("Agent is controlling this device: Checkout flow")).toBeInTheDocument();
    fireEvent.mouseDown(box, { ...view(100, 100), button: 0 });
    fireEvent.mouseUp(window, view(100, 100));
    expect(await screen.findByText(/Press Stop to take over/)).toBeInTheDocument();
    expect(taps(f)).toHaveLength(0);
    for (const name of ["Home", "App switcher"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStopAgent).toHaveBeenCalledTimes(1);
  });

  it("disables Tap buttons while the agent is active", async () => {
    await openLive(setup(), { agentActive: true, onStopAgent: vi.fn() });
    expect(screen.getByRole("button", { name: "Tap Камера" })).toBeDisabled();
    expect(screen.getByText("Agent is controlling this device")).toBeInTheDocument();
  });
});

describe("frame loop", () => {
  const frames = (f: ReturnType<typeof setup>) => f.calls.filter((c) => c.method === "frame").length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("polls while visible, pauses when hidden or the window loses focus, and resumes", async () => {
    const f = setup();
    const { rerenderApp } = await openLive(f);
    await waitFor(() => expect(frames(f)).toBeGreaterThan(3));

    rerenderApp(<DevicePanel driver={f.driver} intervals={FAST} visible={false} />);
    await pause(60); // let a request in flight finish
    const paused = frames(f);
    await pause(200);
    expect(frames(f)).toBe(paused);

    rerenderApp(<DevicePanel driver={f.driver} intervals={FAST} visible />);
    await waitFor(() => expect(frames(f)).toBeGreaterThan(paused));

    fireEvent.blur(window);
    await pause(60);
    const blurred = frames(f);
    await pause(200);
    expect(frames(f)).toBe(blurred);
    fireEvent.focus(window);
    await waitFor(() => expect(frames(f)).toBeGreaterThan(blurred));
  });

  it("never has two frame requests in flight", async () => {
    const f = setup();
    let inFlight = 0;
    let peak = 0;
    const frame = f.driver.frame;
    f.driver.frame = async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await pause(50); // much slower than the 20 ms interval
      try {
        return await frame(id);
      } finally {
        inFlight--;
      }
    };
    await openLive(f);
    await pause(300);
    expect(peak).toBe(1);
  });

  it("shows a frame error and recovers", async () => {
    const f = setup();
    await openLive(f);
    const frame = f.driver.frame;
    f.driver.frame = () => Promise.reject(new DeviceError("Simulator is not booted"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Simulator is not booted");
    f.driver.frame = frame;
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 3000 });
  });
});
