import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { chatStatusStore } from "../../src/lib/chatStatus";
import { changeTriage, getTriage } from "../../src/lib/triageStore";
import { chat, makeApp, renderApp } from "./render";
import { mockInvoke } from "./tauri";

const noop = () => {};
const chats = [chat({ id: 31, project_id: null, title: "Alpha chat" }), chat({ id: 32, project_id: null, title: "Beta chat" }), chat({ id: 33, project_id: null, title: "Gamma chat" })];
const recentRows = () => screen.getAllByRole("button").filter((b) => b.classList.contains("row-main")).map((b) => b.textContent);
const openMenuFor = async (title: string) => {
  const row = screen.getAllByText(title)[0].closest(".row") as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "More" }));
};

describe("Sidebar settle / snooze", () => {
  beforeEach(() => {
    mockInvoke({});
    changeTriage(() => ({}));
  });

  it("Mark as done hides the chat from Recent; ⌘Z brings it back", async () => {
    renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ chats }));
    await openMenuFor("Beta chat");
    await userEvent.click(screen.getByRole("menuitem", { name: /Mark as done/ }));
    expect(recentRows()).not.toContain("Beta chat");
    expect(screen.getByRole("status")).toHaveTextContent("“Beta chat” marked as done");
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(recentRows()).toContain("Beta chat");
  });

  it("snoozed chats fold into a Snoozed group and return when they need attention", async () => {
    renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ chats }));
    await openMenuFor("Gamma chat");
    await userEvent.click(screen.getByRole("menuitem", { name: /For an hour/ }));
    expect(recentRows()).not.toContain("Gamma chat");
    const group = screen.getByRole("button", { name: /Snoozed/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(group);
    expect(recentRows()).toContain("Gamma chat");
    await userEvent.click(group);
    act(() => chatStatusStore.runEnded(33, "ok"));
    expect(getTriage()[33]).toBeUndefined();
    expect(recentRows()[0]).toBe("Gamma chat");
  });

  it("a custom snooze time must be in the future", async () => {
    renderApp(<Sidebar onCreateProject={noop} onSearch={noop} />, makeApp({ chats }));
    await openMenuFor("Alpha chat");
    await userEvent.click(screen.getByRole("menuitem", { name: /Pick a time/ }));
    const dialog = screen.getByRole("dialog", { name: "Pick a time…" });
    fireEvent.change(within(dialog).getByLabelText("Pick a time…"), { target: { value: "2001-01-01T10:00" } });
    expect(within(dialog).getByText("Pick a time in the future.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Snooze" })).toBeDisabled();
  });
});
