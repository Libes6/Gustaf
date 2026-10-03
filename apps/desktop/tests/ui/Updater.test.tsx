import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdaterPanel } from "../../src/components/UpdaterPanel";
import { makeApp, renderApp } from "./render";
import { mockInvoke } from "./tauri";
const native = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: native.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: native.relaunch }));

describe("Signed updater UI", () => {
  it("does not contact an endpoint when the build is unconfigured", async () => {
    mockInvoke({ updater_configured: false });
    renderApp(<UpdaterPanel />);
    expect(await screen.findByText(/Updates are unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name:"Check" })).toBeDisabled();
    expect(native.check).not.toHaveBeenCalled();
  });
  it("checks, downloads then installs/restarts only after distinct user actions", async () => {
    mockInvoke({ updater_configured: true });
    const download = vi.fn(async cb => { cb({ event:"Started", data:{ contentLength:10 } }); cb({ event:"Progress", data:{ chunkLength:10 } }); });
    const install = vi.fn(async () => {});
    native.check.mockResolvedValue({ version:"0.2.0", body:"Changes", download, install });
    native.relaunch.mockResolvedValue(undefined);
    renderApp(<UpdaterPanel />);
    await screen.findByRole("button", { name:"Download" });
    await screen.findByRole("button", { name:"Download" });
    expect(download).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name:"Download" }));
    await screen.findByRole("button", { name:"Install and restart" });
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name:"Install and restart" }));
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name:"Confirm restart" }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(native.relaunch).toHaveBeenCalledTimes(1);
  });
  it("shows verification errors without enabling installation", async () => {
    mockInvoke({ updater_configured: true });
    const install = vi.fn();
    native.check.mockResolvedValue({ version:"0.2.0", download:async () => { throw Error("Invalid signature"); }, install });
    renderApp(<UpdaterPanel />);
    await screen.findByRole("button", { name:"Download" });
    await userEvent.click(await screen.findByRole("button", { name:"Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid signature");
    expect(screen.queryByRole("button", { name:"Install and restart" })).not.toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });
  it("requires explicit permission to interrupt generation, including a run starting during confirmation", async () => {
    const install = vi.fn(async () => {});
    const transport = { check: async () => ({ version: "0.2.0", download: async () => {}, install }) };
    const app = makeApp();
    const result = renderApp(<UpdaterPanel transport={transport} />, app);
    await userEvent.click(await screen.findByRole("button", { name: "Download" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    app.sessions.items[0].busy = true;
    result.rerenderApp(<UpdaterPanel transport={transport} />);
    expect(screen.getByRole("button", { name: "Confirm restart" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    expect(install).toHaveBeenCalledTimes(1);
  });

});
