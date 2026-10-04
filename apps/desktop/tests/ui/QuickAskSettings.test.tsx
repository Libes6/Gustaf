import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAskSettings } from "../../src/components/QuickAskSettings";
import { ShortcutsSettings } from "../../src/components/ShortcutsSettings";
import { I18nProvider } from "../../src/i18n";
import { resetQuickAskStatus } from "../../src/lib/quickAskHost";
import { setPlatformForTests } from "../../src/lib/platform";
import { callsOf, mockSettings } from "./tauri";

vi.mock("../../src/lib/quickAskApi", () => ({ quickAskApi: { configure: vi.fn(async () => {}) } }));
import { quickAskApi } from "../../src/lib/quickAskApi";

const configure = vi.mocked(quickAskApi.configure);
const view = (node = <QuickAskSettings />) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const sw = (name: string) => screen.getByRole("switch", { name });
const saved = () => callsOf("db_execute").filter((a: any) => /insert into settings/.test(a.sql) && a.params[0] === "quickAsk").map((a: any) => JSON.parse(a.params[1]));

beforeEach(() => { setPlatformForTests("linux"); resetQuickAskStatus(); });
afterEach(() => setPlatformForTests(undefined));

describe("Settings: Quick ask window", () => {
  it("is off by default and registers nothing until the switch is turned on", async () => {
    mockSettings({});
    view();
    await waitFor(() => expect(sw("Quick ask window")).toBeEnabled());
    expect(sw("Quick ask window")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Turn the switch on to register the shortcut.")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+Space")).toBeInTheDocument();
    expect(configure).not.toHaveBeenCalled();
  });

  it("turning it on saves the setting and registers the default shortcut", async () => {
    const user = userEvent.setup();
    mockSettings({});
    view();
    await waitFor(() => expect(sw("Quick ask window")).toBeEnabled());
    await user.click(sw("Quick ask window"));
    await waitFor(() => expect(configure).toHaveBeenCalledWith(true, "Control+Alt+Space", true));
    expect(sw("Quick ask window")).toHaveAttribute("aria-checked", "true");
    expect(saved().at(-1)).toEqual({ enabled: true, accelerator: null, hideOnBlur: true });
    expect(await screen.findByText("Active: Ctrl+Alt+Space")).toBeInTheDocument();
    await user.click(sw("Quick ask window"));
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(false, "Control+Alt+Space", true));
  });

  it("reads the saved setting", async () => {
    mockSettings({ quickAsk: { enabled: true, accelerator: "Alt+Shift+K", hideOnBlur: false } });
    view();
    await waitFor(() => expect(sw("Quick ask window")).toHaveAttribute("aria-checked", "true"));
    expect(sw("Hide when the window loses focus")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Alt+Shift+K")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("a shortcut another app already owns is shown as a notice, not an exception", async () => {
    const user = userEvent.setup();
    mockSettings({});
    configure.mockRejectedValueOnce("shortcut_unavailable: HotKey already registered");
    view();
    await waitFor(() => expect(sw("Quick ask window")).toBeEnabled());
    await user.click(sw("Quick ask window"));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The shortcut could not be registered. Another app probably uses it");
    expect(sw("Quick ask window")).toHaveAttribute("aria-checked", "true");
  });

  it("records a new shortcut from the keyboard and registers it", async () => {
    const user = userEvent.setup();
    mockSettings({ quickAsk: { enabled: true, accelerator: null, hideOnBlur: true } });
    view();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    const field = screen.getByLabelText("Press the new shortcut, Esc to cancel");
    fireEvent.keyDown(field, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(true, "Control+Shift+K", true));
    expect(saved().at(-1)).toMatchObject({ accelerator: "Control+Shift+K" });
    expect(screen.getByText("Ctrl+Shift+K")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(true, "Control+Alt+Space", true));
  });

  it("rejects a bare key and a reserved key while recording; Esc cancels", async () => {
    const user = userEvent.setup();
    mockSettings({});
    view();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    const field = () => screen.getByLabelText("Press the new shortcut, Esc to cancel");
    fireEvent.keyDown(field(), { key: " ", code: "Space" });
    expect(await screen.findByText(/at least one of Ctrl, Alt, Cmd or Win/)).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Tab", code: "Tab", altKey: true });
    expect(await screen.findByText("The system uses that shortcut. Choose another one.")).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Escape", code: "Escape" });
    expect(screen.queryByLabelText("Press the new shortcut, Esc to cancel")).not.toBeInTheDocument();
    expect(configure).not.toHaveBeenCalled();
  });

  it("the focus-loss option is saved and passed to Rust", async () => {
    const user = userEvent.setup();
    mockSettings({ quickAsk: { enabled: true, accelerator: null, hideOnBlur: true } });
    view();
    await waitFor(() => expect(sw("Hide when the window loses focus")).toHaveAttribute("aria-checked", "true"));
    await user.click(sw("Hide when the window loses focus"));
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(true, "Control+Alt+Space", false));
    expect(saved().at(-1)).toMatchObject({ hideOnBlur: false });
  });

  it("is part of the keyboard shortcuts section", async () => {
    mockSettings({});
    view(<ShortcutsSettings />);
    expect(await screen.findByRole("switch", { name: "Quick ask window" })).toBeInTheDocument();
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    await act(async () => {});
  });
});
