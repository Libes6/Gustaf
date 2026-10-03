import { fireEvent, screen, waitFor } from "@testing-library/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { describe, expect, it } from "vitest";
import { DeveloperSettings } from "../../src/components/DeveloperSettings";
import { renderApp } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";

describe("DeveloperSettings: raw CLI event capture", () => {
  it("is off by default, the switch stores the setting, and Clear empties the capture", async () => {
    let files = 2;
    mockSettings({});
    mockInvoke({
      raw_log_info: () => ({ dir: "/data/raw-cli", bytes: files ? 3 * 1024 * 1024 : 0, files, latest: files ? "/data/raw-cli/2026-10-03.jsonl" : null }),
      raw_log_clear: () => { files = 0; },
    });
    renderApp(<DeveloperSettings />);
    const sw = await screen.findByRole("switch", { name: "Record raw CLI events" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(await screen.findByText("2 files · 3.0 MB")).toBeInTheDocument();

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(callsOf("db_execute").some((a: any) => /insert into settings/.test(a.sql) && a.params[0] === "recordRawCliEvents" && a.params[1] === "true")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(callsOf("raw_log_clear")).toHaveLength(1));
    expect(await screen.findByText("0 files · 0 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("reads the stored switch and reveals the newest file", async () => {
    mockSettings({ recordRawCliEvents: true });
    mockInvoke({ raw_log_info: () => ({ dir: "/data/raw-cli", bytes: 10, files: 1, latest: "/data/raw-cli/2026-10-03.jsonl" }) });
    renderApp(<DeveloperSettings />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Record raw CLI events" })).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: /Show in/ }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/data/raw-cli/2026-10-03.jsonl"));
  });
});
