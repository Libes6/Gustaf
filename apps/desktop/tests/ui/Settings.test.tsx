import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Settings } from "../../src/components/Settings";
import type { SettingsPage } from "../../src/state";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { mockInvoke, mockSettings } from "./tauri";

const PAGES: [SettingsPage, string][] = [
  ["general", "General"],
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

  it("the usage page shows the effort level of a model's latest turn, and none for a model without one", async () => {
    mockSettings({});
    const stat = (model: string, level?: string) => ({ providerId: "p1", model, turns: 2, input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0, ...(level ? { level } : {}) });
    const tokenStats = { "p1\nm1": stat("m1", "high"), "p1\nm2": stat("m2") } as never;
    renderApp(<Settings />, makeApp({ settingsPage: "usage", providers: [provider()], tokenStats }));
    const withLevel = (await screen.findByText("m1")).closest(".card-row") as HTMLElement;
    expect(within(withLevel).getByTitle("Reasoning effort")).toHaveTextContent("High");
    const without = screen.getByText("m2").closest(".card-row") as HTMLElement;
    expect(within(without).queryByTitle("Reasoning effort")).not.toBeInTheDocument();
  });
});
