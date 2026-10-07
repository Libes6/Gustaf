import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Settings } from "../../src/components/Settings";
import { createSchedule, SCHEDULED_PROMPTS_SETTING } from "../../src/lib/scheduledPrompts";
import { resetScheduled } from "../../src/lib/scheduledPromptsStore";
import { makeApp, project, renderApp } from "./render";
import { mockSettings } from "./tauri";

const sched = (id: string, title: string) =>
  createSchedule(
    {
      title,
      prompt: "p",
      projectId: null,
      providerId: "p",
      model: "m",
      access: "auto",
      schedule: { kind: "daily", time: "09:00" },
    },
    id,
    0,
  );

describe("Settings > Scheduled", () => {
  beforeEach(() => resetScheduled());

  it("shows an empty state with one sentence and a short summary", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "scheduled" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Scheduled");
    expect(screen.getByText(/Runs while Gustaf is open/)).toBeInTheDocument();
    expect(await screen.findByText(/No schedules yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists schedules with a labelled switch and a row menu", async () => {
    mockSettings({ [SCHEDULED_PROMPTS_SETTING]: [sched("a", "Morning digest"), sched("b", "Nightly check")] });
    renderApp(<Settings />, makeApp({ settingsPage: "scheduled", projects: [project()] }));
    const list = await screen.findByRole("list", { name: "Scheduled prompts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByRole("switch", { name: "Enabled: Morning digest" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await userEvent.click(within(list).getByRole("button", { name: "Actions: Morning digest" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("opens the form from New schedule and returns focus to the button on cancel", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "scheduled" }));
    const add = await screen.findByRole("button", { name: "New scheduled prompt" });
    await userEvent.click(add);
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("keeps the full rules inside the How it works disclosure", async () => {
    mockSettings({});
    const { container } = renderApp(<Settings />, makeApp({ settingsPage: "scheduled" }));
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("How it works")).toBeInTheDocument();
    expect(details).toHaveTextContent(/never get full access/);
    expect(details).toHaveTextContent(/missed while the app was closed/);
    await waitFor(() => expect(screen.getByText(/No schedules yet/)).toBeInTheDocument());
  });

  it("General no longer contains the scheduled prompts section", () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "general" }));
    expect(screen.queryByText("New scheduled prompt")).toBeNull();
    expect(screen.queryByText(/never get full access/)).toBeNull();
  });
});
