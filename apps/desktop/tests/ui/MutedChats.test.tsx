import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { isMuted } from "../../src/lib/mutedChats";
import { chat, makeApp, renderApp } from "./render";
import { mockInvoke } from "./tauri";

it("Mute notifications from the chat menu marks the row and can be undone", async () => {
  mockInvoke({});
  renderApp(
    <Sidebar onCreateProject={() => {}} onSearch={() => {}} />,
    makeApp({ chats: [chat({ id: 51, project_id: null, title: "Noisy chat" })] }),
  );
  const row = () => screen.getAllByText("Noisy chat")[0].closest(".row") as HTMLElement;
  await userEvent.click(within(row()).getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Mute notifications/ }));
  expect(isMuted(51)).toBe(true);
  expect(within(row()).getByLabelText("Notifications muted")).toBeInTheDocument();
  await userEvent.click(within(row()).getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Unmute notifications/ }));
  expect(isMuted(51)).toBe(false);
  vi.restoreAllMocks();
});
