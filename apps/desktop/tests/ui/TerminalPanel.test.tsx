import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TerminalPanel } from "../../src/components/TerminalPanel";
import { renderApp } from "./render";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), terms: [] as any[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => mocks.invoke(cmd,args),
  Channel: class { onmessage: any; },
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; selection = ""; data: any; changed: any;
  write = vi.fn(); writeln = vi.fn(); dispose = vi.fn();
  constructor() { mocks.terms.push(this); }
  loadAddon() {} open() {} getSelection() { return this.selection; }
  onData(callback: any) { this.data = callback; return { dispose() {} }; }
  onSelectionChange(callback: any) { this.changed = callback; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
beforeEach(() => {
  mocks.terms.length = 0;
  let next = 1;
  mocks.invoke.mockImplementation(async (cmd: string) => cmd === "terminal_create" ? next++ : undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
it("starts the project shell only after the user opens it and closes on unmount", async () => {
  const { unmount } = renderApp(<TerminalPanel root="/project" />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("terminal_create", expect.objectContaining({ root: "/project", cols: 80, rows: 24 })));
  unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", { id: 1 });
});
it("keeps inactive tabs alive, and closes only the selected session", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  await userEvent.click(screen.getByRole("button", { name: "Terminal 1" }));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "terminal_close")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Close terminal 2" }));
  expect(mocks.invoke).toHaveBeenCalledWith("terminal_close", { id: 2 });
  expect(mocks.terms[1].dispose).toHaveBeenCalled();
});
it("streams bytes and forwards keyboard data to its own PTY", async () => {
  renderApp(<TerminalPanel root="/shadow/project" />);
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("terminal_create", expect.anything()));
  const args = mocks.invoke.mock.calls.find(([cmd]) => cmd === "terminal_create")![1];
  args.output.onmessage({ id: 1, data: [27,91,51,49,109,65], exitCode: null, error: null });
  expect(mocks.terms[0].write).toHaveBeenCalledWith(new Uint8Array([27,91,51,49,109,65]));
  mocks.terms[0].data("pwd\r");
  expect(mocks.invoke).toHaveBeenCalledWith("terminal_write", { id: 1, data: "pwd\r" });
});
it("queues a tool command in the visible review workspace but never sends it before Run", async () => {
  const { requestTerminalCommand } = await import("../../src/lib/terminalBridge");
  const { act } = await import("@testing-library/react");
  renderApp(<TerminalPanel root="/review/project" commandScope="/project" />);
  act(() => requestTerminalCommand("/project", "printf 'approved'"));
  expect(await screen.findByText("printf 'approved'")).toBeInTheDocument();
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("terminal_create", expect.objectContaining({ root:"/review/project" })));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name:"Run command" }));
  expect(mocks.invoke).toHaveBeenCalledWith("terminal_write", { id:1, data:"printf 'approved'\r" });
});
