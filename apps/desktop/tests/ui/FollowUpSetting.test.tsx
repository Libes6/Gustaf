import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Settings } from "../../src/components/Settings";
import { makeApp, renderApp } from "./render";

describe("follow-up setting", () => {
  it("shows the saved action and changes it", async () => {
    const { app } = renderApp(<Settings />, makeApp({ settingsPage: "general", followUp: "steer" }));
    const group = await screen.findByRole("group", { name: "Message while the agent works" });
    expect(group.querySelector("[aria-pressed=true]")).toHaveTextContent("Refine current work");
    await userEvent.click(screen.getByRole("button", { name: "Next request" }));
    expect(app.setFollowUp).toHaveBeenCalledWith("queue");
  });
});
