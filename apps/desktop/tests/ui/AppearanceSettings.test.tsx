import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async (orig) => ({ ...(await orig<typeof import("../../src/lib/api")>()), setSetting: vi.fn(async () => {}), getSetting: vi.fn(async (_k: string, d: unknown) => d) }));
const { AppearanceSettings } = await import("../../src/components/AppearanceSettings");
const api = await import("../../src/lib/api");
const { renderApp } = await import("./render");

it("chat width switches the --chat-width variable and is saved", async () => {
  renderApp(<AppearanceSettings />);
  const group = screen.getByRole("group", { name: "Chat width" });
  await userEvent.click(screen.getByRole("button", { name: "Wide" }));
  expect(screen.getByRole("button", { name: "Wide" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.style.getPropertyValue("--chat-width")).toBe("960px");
  expect(api.setSetting).toHaveBeenCalledWith("chatWidth", "wide");
  await userEvent.click(screen.getByRole("button", { name: "Full" }));
  expect(document.documentElement.style.getPropertyValue("--chat-width")).toBe("100%");
  expect(group).toBeInTheDocument();
});

it("appearance: font size, wrapping and motion apply to the page, show in the preview, persist and reset", async () => {
  renderApp(<AppearanceSettings />);
  expect(screen.getByTestId("appearance-preview")).toBeInTheDocument();
  expect(screen.getByTestId("preview-diff")).toBeInTheDocument();
  const size = screen.getByRole("spinbutton", { name: "Code font size" });
  await userEvent.clear(size);
  await userEvent.type(size, "15");
  expect(document.documentElement.style.getPropertyValue("--code-scale")).toBe("1.25");
  await userEvent.click(screen.getByRole("switch", { name: "Wrap long lines in code and diffs" }));
  expect(document.documentElement.dataset.codeWrap).toBe("on");
  await userEvent.click(screen.getByRole("button", { name: "Slow" }));
  expect(document.documentElement.style.getPropertyValue("--motion")).toBe("2");
  expect(api.setSetting).toHaveBeenCalledWith("appearance", expect.objectContaining({ wrapCode: true, motion: "slow", codeSize: 15 }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interface font" }), "serif");
  expect(document.documentElement.style.getPropertyValue("--font")).toContain("serif");
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(document.documentElement.style.getPropertyValue("--code-scale")).toBe("1");
  expect(document.documentElement.dataset.codeWrap).toBe("off");
  expect(document.documentElement.style.getPropertyValue("--motion")).toBe("1");
});
