import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { beginApproval } from "../../src/lib/attention";
import { chatStatusStore } from "../../src/lib/chatStatus";
import { beginLiveRun } from "../../src/lib/liveRuns";
import { chat, makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const noop = () => {};
const chats = [
  chat({ id: 1, project_id: 1, title: "Fix the parser" }),
  chat({ id: 2, project_id: 1, title: "Refactor router" }),
  chat({ id: 3, project_id: null, title: "Loose question" }),
];

const setup = (over: Record<string, unknown> = {}, props: { onSearch?: () => void; onCreateProject?: () => void } = {}) =>
  renderApp(<Sidebar onCreateProject={props.onCreateProject ?? noop} onSearch={props.onSearch ?? noop} />, makeApp({ projects: [project()], chats, ...over }));

describe("Sidebar", () => {
  it("lists projects with their chats and the recent chats", () => {
    setup();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    // Chats of a project show under it and again in "Recent".
    expect(screen.getAllByText("Fix the parser")).toHaveLength(2);
    expect(screen.getAllByText("Loose question")).toHaveLength(1);
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("shows the new-project row when there are no projects", async () => {
    const onCreateProject = vi.fn();
    setup({ projects: [], chats: [] }, { onCreateProject });
    await userEvent.click(screen.getByText("New project"));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("opens a chat in the chat view", async () => {
    const { app } = setup();
    await userEvent.click(screen.getByText("Loose question"));
    expect(app.openChat).toHaveBeenCalledWith(3, null);
    expect(app.setView).toHaveBeenCalledWith("chat");
  });

  it("offers Pin on an unpinned project and toggles it in the database", async () => {
    const { app } = setup();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("Unpin")).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Pin/ }));
    await waitFor(() => expect(app.reload).toHaveBeenCalled());
    expect(callsOf("db_execute").some((a) => /update projects set pinned/.test(a.sql) && a.params[0] === 1)).toBe(true);
  });

  it("offers Unpin and a pin icon for a pinned project", () => {
    setup({ projects: [project({ pinned: 1 })] });
    fireEvent.contextMenu(screen.getByText("Alpha"));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Unpin/ })).toBeInTheDocument();
  });

  it("renames a project inline: Edit in the menu, type, Enter", async () => {
    const { app } = setup();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Edit/ }));
    const input = screen.getByDisplayValue("Alpha");
    await userEvent.clear(input);
    await userEvent.type(input, "Beta{Enter}");
    await waitFor(() => expect(app.reload).toHaveBeenCalled());
    expect(callsOf("db_execute").some((a) => /update projects set name/.test(a.sql) && a.params[0] === "Beta" && a.params[1] === 1)).toBe(true);
  });

  it("Escape cancels an inline rename without writing", async () => {
    setup();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Edit/ }));
    await userEvent.type(screen.getByDisplayValue("Alpha"), "x{Escape}");
    expect(callsOf("db_execute")).toHaveLength(0);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("renames a chat from its context menu", async () => {
    setup();
    fireEvent.contextMenu(screen.getByText("Loose question"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByDisplayValue("Loose question");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed{Enter}");
    await waitFor(() => expect(callsOf("db_execute").some((a) => /update chats set title/.test(a.sql) && a.params[0] === "Renamed")).toBe(true));
  });

  it("the full-text search button calls onSearch", async () => {
    const onSearch = vi.fn();
    setup({}, { onSearch });
    await userEvent.click(screen.getByRole("button", { name: "Search all chats" }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("the title filter narrows chats and projects, and Escape closes it", async () => {
    setup();
    await userEvent.click(screen.getByTitle("Search"));
    const box = screen.getByPlaceholderText("Search chats");
    await userEvent.type(box, "router");
    expect(screen.getAllByText("Refactor router").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loose question")).not.toBeInTheDocument();
    expect(screen.queryByText("Fix the parser")).not.toBeInTheDocument();
    await userEvent.type(box, "{Escape}");
    expect(screen.queryByPlaceholderText("Search chats")).not.toBeInTheDocument();
    expect(screen.getAllByText("Loose question").length).toBeGreaterThan(0);
  });

  it("shows the approval badge only on chats with an open approval request", () => {
    setup();
    expect(screen.queryByRole("status", { name: "Waiting for your approval" })).not.toBeInTheDocument();
    let done = noop;
    act(() => { done = beginApproval(2, "main"); });
    // Chat 2 appears under its project and in Recent.
    expect(screen.getAllByRole("status", { name: "Waiting for your approval" }).length).toBeGreaterThan(0);
    const row = screen.getAllByText("Refactor router")[0].closest(".row") as HTMLElement;
    expect(within(row).getByRole("status", { name: "Waiting for your approval" })).toBeInTheDocument();
    const other = screen.getByText("Loose question").closest(".row") as HTMLElement;
    expect(within(other).queryByRole("status")).not.toBeInTheDocument();
    act(() => done());
    expect(screen.queryByRole("status", { name: "Waiting for your approval" })).not.toBeInTheDocument();
  });

  it("shows the running state of a chat a scheduled run writes to, even when it is not open", async () => {
    setup();
    const row = () => screen.getByText("Loose question").closest(".row") as HTMLElement;
    expect(within(row()).queryByRole("img", { name: "Thinking…" })).not.toBeInTheDocument();
    let handle: ReturnType<typeof beginLiveRun> | undefined;
    act(() => { handle = beginLiveRun(3, "Nightly", noop); });
    // A running chat folds into the Working group of Recent (T6); opening the group shows it with its badge.
    expect(screen.queryByText("Loose question")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Working/ }));
    expect(within(row()).getByRole("img", { name: "Thinking…" })).toBeInTheDocument();
    expect(within(screen.getAllByText("Refactor router")[0].closest(".row") as HTMLElement).queryByRole("img", { name: "Thinking…" })).not.toBeInTheDocument();
    act(() => handle?.end());
    expect(within(row()).queryByRole("img", { name: "Thinking…" })).not.toBeInTheDocument();
  });

  it("shows done-unread and failed badges with text alternatives, cleared when the chat is opened or run again", () => {
    setup();
    const row = () => screen.getByText("Loose question").closest(".row") as HTMLElement;
    act(() => chatStatusStore.runEnded(3, "ok"));
    const unread = within(row()).getByRole("img", { name: "Finished, not viewed yet" });
    expect(unread).toHaveAttribute("title", "Finished, not viewed yet");
    act(() => chatStatusStore.setViewing(3));
    expect(within(row()).queryByRole("img", { name: "Finished, not viewed yet" })).not.toBeInTheDocument();
    act(() => chatStatusStore.setViewing(null));
    act(() => chatStatusStore.runEnded(3, "failed"));
    expect(within(row()).getByRole("status", { name: "The last run failed" })).toBeInTheDocument();
    act(() => chatStatusStore.runStarted(3));
    expect(within(row()).queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows one badge per chat: an open approval wins over a failure", () => {
    setup();
    const row = () => screen.getByText("Loose question").closest(".row") as HTMLElement;
    let done = noop;
    act(() => { chatStatusStore.runEnded(3, "failed"); done = beginApproval(3, "main"); });
    expect(within(row()).getByRole("status", { name: "Waiting for your approval" })).toBeInTheDocument();
    expect(within(row()).queryByRole("status", { name: "The last run failed" })).not.toBeInTheDocument();
    act(() => { done(); chatStatusStore.runStarted(3); });
  });

  it("archives a chat with the row button", async () => {
    mockInvoke({});
    const { app } = setup();
    const row = screen.getByText("Loose question").closest(".row") as HTMLElement;
    await userEvent.click(within(row).getByTitle("Archive"));
    await waitFor(() => expect(app.reload).toHaveBeenCalled());
    expect(callsOf("db_execute").some((a) => /update chats set archived/.test(a.sql))).toBe(true);
  });
});
