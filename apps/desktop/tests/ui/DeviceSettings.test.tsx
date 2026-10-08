import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DeviceSettings } from "../../src/components/DeviceSettings";
import { getDeviceSettings, resetDeviceSettings } from "../../src/agent/deviceSettingsStore";
import { renderApp } from "./render";

describe("device settings", () => {
  beforeEach(() => resetDeviceSettings());

  it("is off by default and the first-use switch is locked until access is on", async () => {
    renderApp(<DeviceSettings />);
    const access = await screen.findByRole("switch", { name: "Agent device access" });
    expect(access).toHaveAttribute("aria-checked", "false");
    const ask = screen.getByRole("switch", {
      name: "Ask before the agent uses a device for the first time in a chat",
    });
    expect(ask).toBeDisabled();
    expect(getDeviceSettings()).toEqual({ access: false, askFirst: true });
  });

  it("turns access on and the first-use question off", async () => {
    renderApp(<DeviceSettings />);
    await userEvent.click(await screen.findByRole("switch", { name: "Agent device access" }));
    expect(getDeviceSettings().access).toBe(true);
    await userEvent.click(
      screen.getByRole("switch", { name: "Ask before the agent uses a device for the first time in a chat" }),
    );
    expect(getDeviceSettings()).toEqual({ access: true, askFirst: false });
  });
});
