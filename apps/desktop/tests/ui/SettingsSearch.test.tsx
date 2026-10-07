import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Settings } from "../../src/components/Settings";
import { SETTING_ENTRIES } from "../../src/lib/settingsIndex";
import { makeApp, project, renderApp } from "./render";
import { mockSettings } from "./tauri";

const box = () => screen.getByRole("combobox", { name: "Search settings" });

describe("settings search", () => {
  it("finds a setting from another page and opens it with its id", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await userEvent.type(box(), "brave");
    const hit = await screen.findByRole("option", { name: /Brave API key/ });
    expect(hit).toHaveTextContent("Web tools");
    await userEvent.click(hit);
    expect(app.openSettings).toHaveBeenCalledWith("web", "webBraveKey");
  });

  it("works from the keyboard: arrows move, Enter opens, Escape clears", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await userEvent.type(box(), "domains");
    await screen.findAllByRole("option");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(app.openSettings).toHaveBeenCalledWith("web", "webDeny");
    await userEvent.type(box(), "zzzz{Escape}");
    expect(box()).toHaveValue("");
  });

  it("finds a keyboard shortcut by its combination", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await userEvent.type(box(), "cmd+k");
    await userEvent.click(await screen.findByRole("option", { name: /Search chats/i }));
    expect(app.openSettings).toHaveBeenCalledWith("shortcuts", "shortcut-search");
  });

  it("shows an empty state", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    await userEvent.type(box(), "qzxwv");
    expect(await screen.findByText("No settings match “qzxwv”.")).toBeInTheDocument();
  });

  it("in Russian the search matches Russian titles", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "general", locale: "ru" }), "ru");
    await userEvent.type(screen.getByRole("combobox", { name: "Поиск по настройкам" }), "домены");
    expect(await screen.findAllByRole("option")).not.toHaveLength(0);
  });

  it("scrolls to the target row and highlights it", async () => {
    mockSettings({});
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "web", settingTarget: "webDeny" }));
    await waitFor(() => expect(document.querySelector('[data-setting="webDeny"]')).toHaveClass("setting-hit"));
    expect(app.clearSettingTarget).toHaveBeenCalled();
  });

  it("every indexed setting has a row on its page", async () => {
    for (const page of [...new Set(SETTING_ENTRIES.map((e) => e.page))]) {
      mockSettings({});
      const { unmount } = renderApp(<Settings />, makeApp({ settingsPage: page, projects: [project()] }));
      await waitFor(() => {
        for (const e of SETTING_ENTRIES.filter((x) => x.page === page)) expect(document.querySelector(`[data-setting="${e.id}"]`), `${page}/${e.id}`).not.toBeNull();
      });
      unmount();
    }
  });
});
