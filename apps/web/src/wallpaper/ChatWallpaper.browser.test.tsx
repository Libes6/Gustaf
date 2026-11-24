import { expect, it, vi } from "vite-plus/test";
import { fakeTimers, render } from "../../test/render";
import { ChatWallpaper } from "./ChatWallpaper";
import { BUILT_IN_WALLPAPERS, useWallpaperLibrary } from "./wallpaperLibrary";

function WallpaperHarness() {
  const library = useWallpaperLibrary();
  return (
    <>
      <button onClick={() => library.select(null)}>Off</button>
      <ChatWallpaper working={false} />
    </>
  );
}

function recordFrameMessages() {
  const events: string[] = [];
  const listener = (event: MessageEvent) => {
    if (
      typeof event.data?.type === "string" &&
      event.source === document.querySelector("iframe")?.contentWindow
    ) {
      events.push(
        event.data.type === "wallpaper:watch"
          ? event.data.active === true
            ? "worker:started"
            : "worker:stopped"
          : event.data.type,
      );
    }
  };
  window.addEventListener("message", listener);
  return Object.assign(events, {
    [Symbol.dispose]() {
      window.removeEventListener("message", listener);
    },
  });
}

function installFixture(id: string, source: string) {
  const key = "t3code:wallpaper:v1";
  const previous = localStorage.getItem(key);
  localStorage.setItem(
    key,
    JSON.stringify({
      activeId: `installed:${id}`,
      installed: [{ id: `installed:${id}`, name: id, source }],
    }),
  );
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
}

it.each(BUILT_IN_WALLPAPERS)(
  "renders $name in the sandbox and stops when disabled",
  async ({ id }) => {
    const response = await fetch(`/wallpapers/${id}.js`);
    expect(response.ok).toBe(true);
    const source = await response.text();
    using _fixture = installFixture(id, source);
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    using events = recordFrameMessages();
    await using screen = await render(<WallpaperHarness />);
    await vi.waitFor(() => expect(events).toContain("wallpaper:frame"));
    expect(events).not.toContain("wallpaper:error");
    expect(events).toContain("worker:started");
    const frame = screen.container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(() => frame.contentWindow!.document).toThrow();
    await screen.getByRole("button", { name: "Off" }).click();
    await vi.waitFor(() => expect(screen.container.querySelector("iframe")).toBeNull());
  },
);

it("stops a scene that never returns without freezing the window", async () => {
  using _fixture = installFixture("hang", "SCENES.hang = { cell() { for (;;) {} } };");
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using events = recordFrameMessages();
  await using screen = await render(<WallpaperHarness />);
  using _timers = fakeTimers();
  await vi.waitFor(() => expect(events).toContain("worker:started"));
  vi.advanceTimersByTime(1000);
  // The frame answers the watchdog's stop, so neither it nor this window is blocked by the scene.
  await vi.waitFor(() => expect(events.at(-1)).toBe("worker:stopped"));
  expect(events).not.toContain("wallpaper:frame");
  await screen.getByRole("button", { name: "Off" }).click();
  await vi.waitFor(() => expect(screen.container.querySelector("iframe")).toBeNull());
});
