// Settings, Diagnostics: the app's own processes with CPU and memory, provider state from the provider checks, recent
// errors, the logs button. Secrets never reach the screen; sampling runs only while the page is mounted.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AppDiagnostics, SAMPLE_MS } from "../../src/components/AppDiagnostics";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
const procs = [
  { pid: 100, ppid: 1, cpu: 2.5, rssKb: 204_800, elapsedSecs: 3700, command: "/Applications/Gustaf.app/Contents/MacOS/gustaf", isApp: true },
  { pid: 101, ppid: 100, cpu: 95.2, rssKb: 512_000, elapsedSecs: 61, command: `node /x/sidecar/index.mjs --api-key ${SECRET} --token=hunter2hunter2`, isApp: false },
  { pid: 102, ppid: 101, cpu: 0, rssKb: 2048, elapsedSecs: 5, command: `claude --env ANTHROPIC_API_KEY=${SECRET}`, isApp: false },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockInvoke({ process_snapshot: procs, mcp_status: [{ id: "srv", state: "error", error: `spawn failed with Bearer ${"a".repeat(40)}`, pid: null, restarts: 0, toolsEpoch: 0, resourcesEpoch: 0, promptsEpoch: 0, init: null }], app_logs_dir: "/logs" });
});
afterEach(() => vi.useRealTimers());

const app = () => makeApp({
  settingsPage: "diagnostics",
  providers: [provider({ id: "p1", name: "Claude Code" }), provider({ id: "p2", name: "Broken AI" })],
  providerHealth: { p1: { status: "ok", message: "", at: Date.now() }, p2: { status: "error", message: `401 for key ${SECRET}`, at: Date.now() } },
  modelErrors: {},
  limitErrors: { p1: "limit endpoint timed out" },
});

describe("AppDiagnostics", () => {
  it("lists the app's processes with CPU and memory and flags the heavy one", async () => {
    renderApp(<AppDiagnostics />, app());
    expect(await screen.findByText("Gustaf (this app)")).toBeInTheDocument();
    const heavy = screen.getByTestId("diag-proc-101");
    expect(heavy).toHaveTextContent("node index.mjs");
    expect(heavy).toHaveTextContent("CPU 95.2%");
    expect(heavy).toHaveTextContent("500 MB");
    expect(within(heavy).getByText("High load")).toBeInTheDocument();
    expect(within(screen.getByTestId("diag-proc-100")).queryByText("High load")).toBeNull();
    expect(screen.getByTestId("diag-summary")).toHaveTextContent("3 processes");
  });

  it("never shows secrets from command lines or error texts", async () => {
    renderApp(<AppDiagnostics />, app());
    await screen.findByText("Gustaf (this app)");
    const html = document.body.textContent ?? "";
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("hunter2");
    expect(html).not.toMatch(/a{30}/);
    expect(html).toContain("[REDACTED]");
  });

  it("shows provider state from the check data and errors from every source", async () => {
    renderApp(<AppDiagnostics />, app());
    await screen.findByText("Gustaf (this app)");
    expect(screen.getByTestId("diag-provider-p1")).toHaveTextContent("Claude Code · Signed in");
    expect(screen.getByTestId("diag-provider-p2")).toHaveTextContent("Broken AI · Unavailable");
    const errors = screen.getByTestId("diag-errors");
    expect(errors).toHaveTextContent("Broken AI");
    expect(errors).toHaveTextContent("limit endpoint timed out");
    expect(errors).toHaveTextContent("MCP srv");
  });

  it("opens the logs folder", async () => {
    renderApp(<AppDiagnostics />, app());
    await userEvent.click(screen.getByRole("button", { name: /Open logs folder/ }));
    await vi.waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/logs"));
  });

  it("samples every few seconds while open and stops on leave", async () => {
    const { unmount } = renderApp(<AppDiagnostics />, app());
    await screen.findByText("Gustaf (this app)");
    expect(callsOf("process_snapshot")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2 + 100);
    expect(callsOf("process_snapshot").length).toBeGreaterThanOrEqual(3);
    unmount();
    const after = callsOf("process_snapshot").length;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 5);
    expect(callsOf("process_snapshot")).toHaveLength(after);
  });

  it("says so when the process list is unavailable", async () => {
    mockInvoke({ process_snapshot: () => { throw new Error("unsupported"); } });
    renderApp(<AppDiagnostics />, app());
    expect(await screen.findByText("Process list is not available on this system.")).toBeInTheDocument();
  });
});
