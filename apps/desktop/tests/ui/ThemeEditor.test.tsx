import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { beforeEach, expect, it, vi } from "vitest";
import { callsOf, mockInvoke } from "./tauri";

vi.mock("../../src/lib/api", async (orig) => ({ ...(await orig<typeof import("../../src/lib/api")>()), setSetting: vi.fn(async () => {}), getSetting: vi.fn(async (_k: string, d: unknown) => d) }));
const { ThemeEditor } = await import("../../src/components/ThemeEditor");
const { getCustomThemes, deleteCustomTheme } = await import("../../src/lib/customTheme");
const api = await import("../../src/lib/api");
const { exportTheme, emptyTheme } = await import("../../src/lib/customThemeUtil");
const { renderApp } = await import("./render");

beforeEach(() => {
  for (const t of [...getCustomThemes().themes]) deleteCustomTheme(t.id);
  document.documentElement.dataset.theme = "dark";
  vi.mocked(api.setSetting).mockClear();
});

const file = (text: string, name = "t.json") => new File([text], name, { type: "application/json" });
const upload = (f: File) => fireEvent.change(screen.getByTestId("theme-import-input"), { target: { files: [f] } });

it("creates a theme, edits the dark palette with a live preview, saves, applies and persists it", async () => {
  renderApp(<ThemeEditor />);
  await userEvent.click(screen.getByRole("button", { name: "New theme" }));
  const preview = screen.getByTestId("theme-preview");
  expect(preview.style.getPropertyValue("--bg")).toBe("#181818");
  const bg = screen.getByRole("textbox", { name: "--bg" });
  await userEvent.clear(bg);
  await userEvent.type(bg, "#102030");
  expect(preview.style.getPropertyValue("--bg")).toBe("#102030");
  expect(preview.style.getPropertyValue("--bg-side")).not.toBe("#1d1d1d");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(getCustomThemes().themes).toHaveLength(1);
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#102030");
  expect(api.setSetting).toHaveBeenCalledWith("customThemes", expect.any(Array));
  expect(api.setSetting).toHaveBeenCalledWith("customThemeId", getCustomThemes().activeId);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Active theme" }), "");
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
});

it("light and dark palettes are separate", async () => {
  renderApp(<ThemeEditor />);
  await userEvent.click(screen.getByRole("button", { name: "New theme" }));
  await userEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(screen.getByTestId("theme-preview").style.getPropertyValue("--bg")).toBe("#ffffff");
  const text = screen.getByRole("textbox", { name: "--text" });
  await userEvent.clear(text);
  await userEvent.type(text, "#000000");
  await userEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(screen.getByTestId("theme-preview").style.getPropertyValue("--text")).toBe("#e6e6e6");
});

it("advanced mode edits a single token without touching the others", async () => {
  renderApp(<ThemeEditor />);
  await userEvent.click(screen.getByRole("button", { name: "New theme" }));
  await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
  const kw = screen.getByRole("textbox", { name: "--hl-keyword" });
  await userEvent.clear(kw);
  await userEvent.type(kw, "#ff0000");
  const p = screen.getByTestId("theme-preview");
  expect(p.style.getPropertyValue("--hl-keyword")).toBe("#ff0000");
  expect(p.style.getPropertyValue("--bg")).toBe("#181818");
});

it("imports a valid theme file and activates it", async () => {
  renderApp(<ThemeEditor />);
  const t = emptyTheme("x", "Shared");
  t.dark.bg = "#0a0b0c";
  upload(file(exportTheme(t)));
  await waitFor(() => expect(getCustomThemes().themes.map((x) => x.name)).toEqual(["Shared"]));
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0a0b0c");
  expect(await screen.findByRole("status")).toHaveTextContent("imported");
});

it("rejects invalid files with a message and changes nothing", async () => {
  renderApp(<ThemeEditor />);
  upload(file("not json"));
  expect(await screen.findByRole("alert")).toHaveTextContent("not valid JSON");
  upload(file(JSON.stringify({ format: "gustaf-theme", version: 1, name: "Evil", dark: { bg: "url(javascript:alert(1))" } })));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid colour"));
  upload(file(JSON.stringify({ format: "gustaf-theme", version: 1, name: "Evil", dark: { onload: "#000000" } })));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unknown field"));
  upload(new File(["x".repeat(70 * 1024)], "big.json"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("too large"));
  expect(getCustomThemes().themes).toHaveLength(0);
});

it("duplicates, exports and deletes the active theme", async () => {
  renderApp(<ThemeEditor />);
  upload(file(exportTheme(emptyTheme("x", "Shared"))));
  await waitFor(() => expect(getCustomThemes().themes).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  expect(getCustomThemes().themes.map((x) => x.name)).toEqual(["Shared", "Shared copy"]);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  mockInvoke({ fs_write: () => "ok" });
  vi.mocked(save).mockResolvedValueOnce("/home/me/shared-copy.gustaf-theme.json");
  await userEvent.click(screen.getByRole("button", { name: "Export theme" }));
  await waitFor(() => expect(callsOf("fs_write")).toHaveLength(1));
  const w = callsOf("fs_write")[0];
  expect(w.root).toBe("/home/me");
  expect(w.path).toBe("shared-copy.gustaf-theme.json");
  expect(JSON.parse(w.content)).toMatchObject({ format: "gustaf-theme", version: 1, name: "Shared copy" });

  vi.mocked(ask).mockResolvedValueOnce(true);
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(getCustomThemes().themes.map((x) => x.name)).toEqual(["Shared"]));
  expect(getCustomThemes().activeId).toBe("");
});
