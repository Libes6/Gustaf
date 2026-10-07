import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detectLocale } from "../../src/i18n";
import { Settings } from "../../src/components/Settings";
import type { SettingsPage } from "../../src/state";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { mockInvoke, mockSettings } from "./tauri";

const PAGES: [SettingsPage, string][] = [
  ["general", "General"],
  ["shortcuts", "Keyboard shortcuts"],
  ["import", "Import"],
  ["providers", "Model providers"],
  ["usage", "Usage"],
  ["computer", "Computer use"],
  ["mcp", "MCP"],
  ["scheduled", "Scheduled"],
  ["git", "Git & commands"],
  ["rules", "Rules"],
  ["archive", "Archived chats"],
];

const page = () => screen.getByRole("heading", { level: 1 });
const nav = () => screen.getByRole("navigation", { name: "Settings" }) as HTMLElement;

describe("Settings", () => {
  it.each(PAGES)("renders the %s page with an empty backend", async (id, title) => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: id, projects: [project()] }));
    expect(page()).toHaveTextContent(title);
    // Let the page's own effects (settings, permission and list loads) finish so nothing updates after the test.
    await waitFor(() => expect(page()).toBeInTheDocument());
  });

  it("keyboard shortcuts are their own menu item and no longer part of General", async () => {
    mockSettings({});
    const { app, unmount } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    expect(within(nav()).getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(page()).toHaveTextContent("General");
    expect(screen.queryByText("Keyboard shortcuts", { selector: "h1, h4" })).toBeNull();
    await userEvent.click(within(nav()).getByRole("button", { name: "Keyboard shortcuts" }));
    expect(app.openSettings).toHaveBeenCalledWith("shortcuts");
    unmount();
  });

  it("General has no raw CLI events recorder (no developer block, no switch)", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await waitFor(() => expect(page()).toHaveTextContent("General"));
    expect(screen.queryByText("Developer")).toBeNull();
    expect(screen.queryByText(/raw CLI events/i)).toBeNull();
    expect(screen.queryByRole("switch", { name: /raw CLI/i })).toBeNull();
  });

  it("English is the default UI language even when the system language is Russian", () => {
    const spy = vi.spyOn(navigator, "language", "get").mockReturnValue("ru-RU");
    expect(detectLocale()).toBe("en");
    spy.mockRestore();
  });

  it("the archive page lists archived chats", async () => {
    mockInvoke({ db_select: ({ sql }: { sql: string }) => (/archived = 1/.test(sql) ? [chat({ id: 9, title: "Old archived chat" })] : []) });
    renderApp(<Settings />, makeApp({ settingsPage: "archive" }));
    expect(await screen.findByText("Old archived chat")).toBeInTheDocument();
  });

  it("the import page shows the import history", async () => {
    mockSettings({ importHistory: [{ source: "cursor", at: 1_700_000_000_000, chats: 7, projects: 1 }] });
    renderApp(<Settings />, makeApp({ settingsPage: "import" }));
    expect(await screen.findByText(/Imported from/)).toBeInTheDocument();
  });

  it("the providers page lists configured providers", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "providers", providers: [provider({ name: "My Anthropic" })] }));
    expect((await screen.findAllByText("My Anthropic")).length).toBeGreaterThan(0);
  });

  it("lists every section in the navigation and marks the current one", () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "usage" }));
    for (const [, title] of PAGES) expect(within(nav()).getByText(title)).toBeInTheDocument();
    expect(within(nav()).getByText("Usage").closest(".row")).toHaveClass("active");
    expect(within(nav()).getByText("General").closest(".row")).not.toHaveClass("active");
  });

  it("navigates by calling openSettings with the page id", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    for (const [id, title] of PAGES) {
      await userEvent.click(within(nav()).getByText(title));
      expect(app.openSettings).toHaveBeenLastCalledWith(id);
    }
  });

  it("General changes the language through the app state", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await userEvent.click(screen.getByRole("button", { name: "Русский" }));
    expect(app.setLocale).toHaveBeenCalledWith("ru");
  });
});
