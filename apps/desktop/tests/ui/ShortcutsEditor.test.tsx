import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutsSettings } from "../../src/components/ShortcutsSettings";
import { setShortcutOverrides, shortcut } from "../../src/lib/shortcuts";
import { renderApp } from "./render";
import { callsOf, mockSettings } from "./tauri";

afterEach(() => setShortcutOverrides({}));
const rowOf = (name: string) => screen.getByText(name, { selector: ".t" }).closest(".setting-row") as HTMLElement;

describe("shortcut editor", () => {
  it("rebinds a shortcut, saves it, and resets it", async () => {
    mockSettings({});
    renderApp(<ShortcutsSettings />);
    await userEvent.click(within(rowOf("New chat")).getByRole("button", { name: "Change: New chat" }));
    await userEvent.keyboard("{Meta>}{Shift>}j{/Shift}{/Meta}");
    await waitFor(() => expect(shortcut("newChat").combo).toBe("Cmd+Shift+J"));
    expect(within(rowOf("New chat")).getByText("⌘⇧J")).toBeInTheDocument();
    expect(JSON.stringify(callsOf("db_execute"))).toContain('{\\"newChat\\":\\"Cmd+Shift+J\\"}');
    await userEvent.click(within(rowOf("New chat")).getByRole("button", { name: "Reset: New chat" }));
    await waitFor(() => expect(shortcut("newChat").combo).toBe("Cmd+N"));
    expect(within(rowOf("New chat")).queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("the keys themselves are the edit control: no separate Change button, fixed keys are plain text", async () => {
    mockSettings({});
    renderApp(<ShortcutsSettings />);
    const chip = within(rowOf("New chat")).getByRole("button", { name: "Change: New chat" });
    expect(chip).toHaveTextContent("⌘N");
    expect(within(rowOf("New chat")).queryByText("Change")).toBeNull();
    await userEvent.click(chip);
    expect(within(rowOf("New chat")).getByText("Press the new shortcut…")).toBeInTheDocument();
    expect(within(rowOf("Send")).queryByRole("button")).toBeNull();
  });

  it("explains a conflict and keeps the old binding", async () => {
    mockSettings({});
    renderApp(<ShortcutsSettings />);
    await userEvent.click(within(rowOf("New chat")).getByRole("button", { name: "Change: New chat" }));
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Already used by “Search chats”/);
    expect(shortcut("newChat").combo).toBe("Cmd+N");
  });

  it("refuses a key without Cmd and an editing key; Escape cancels", async () => {
    mockSettings({});
    renderApp(<ShortcutsSettings />);
    await userEvent.click(within(rowOf("New chat")).getByRole("button", { name: "Change: New chat" }));
    await userEvent.keyboard("j");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Include/);
    await userEvent.keyboard("{Meta>}v{/Meta}");
    expect(screen.getByRole("alert")).toHaveTextContent(/editing or by the system/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Press the new shortcut…")).toBeNull();
    expect(shortcut("newChat").combo).toBe("Cmd+N");
  });

  it("message box keys are listed as fixed, and the list can be searched by name or keys", async () => {
    mockSettings({});
    renderApp(<ShortcutsSettings />);
    expect(within(rowOf("Send")).getByText("Fixed")).toBeInTheDocument();
    expect(within(rowOf("Send")).queryByRole("button", { name: /Change/ })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Search shortcuts" }), "⌘K");
    expect(screen.getAllByText(/Search chats/).length).toBeGreaterThan(0);
    expect(screen.queryByText("New chat", { selector: ".t" })).toBeNull();
    await userEvent.clear(screen.getByRole("textbox", { name: "Search shortcuts" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search shortcuts" }), "qzxwv");
    expect(screen.getByText("No shortcuts match “qzxwv”.")).toBeInTheDocument();
  });

  it("loads saved bindings through the setting", async () => {
    const { loadShortcutBindings } = await import("../../src/lib/shortcutPrefs");
    mockSettings({ shortcutBindings: { search: "Cmd+Shift+F", send: "Cmd+J" } });
    await loadShortcutBindings();
    expect(shortcut("search").combo).toBe("Cmd+Shift+F");
    expect(shortcut("send").combo).toBe("Enter");
  });
});
