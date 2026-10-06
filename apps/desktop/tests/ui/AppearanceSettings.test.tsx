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
