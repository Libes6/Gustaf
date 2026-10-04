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
const queue = async (root: string, command: string) => {
  const { requestTerminalCommand } = await import("../../src/lib/terminalBridge");
  const { act } = await import("@testing-library/react");
  act(() => requestTerminalCommand(root, command));
};
const writes = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "terminal_write").map(([, a]) => a as { id: number; data: string });

it("types a single-line tool command in the visible review workspace without Enter", async () => {
  renderApp(<TerminalPanel root="/review/project" commandScope="/project" />);
  await queue("/project", "printf 'approved'");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("terminal_create", expect.objectContaining({ root: "/review/project" })));
  await waitFor(() => expect(writes()).toEqual([{ id: 1, data: "printf 'approved'" }]));
  expect(await screen.findByText(/typed but not run/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Run command" })).toBeNull();
  expect(writes().some(w => /[\r\n]/.test(w.data))).toBe(false);
});
it("drops trailing newlines so a typed command can never execute by itself", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await queue("/project", "npm test\n\n");
  await waitFor(() => expect(writes()).toEqual([{ id: 1, data: "npm test" }]));
});
it("shows a multi-line command and only sends it after the Run click", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await queue("/project", "cd src\r\nls");
  expect(await screen.findByText(/multi-line/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Run command" })).toBeEnabled());
  expect(writes()).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Run command" }));
  expect(writes()).toEqual([{ id: 1, data: "cd src\nls\r" }]);
});
it("opens one more tab for a request while a terminal is already open, in the same root", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  await queue("/project", "ls");
  await waitFor(() => expect(screen.getByRole("button", { name: "Terminal 2" })).toBeInTheDocument());
  await waitFor(() => expect(writes()).toEqual([{ id: 2, data: "ls" }]));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "terminal_create").map(([, a]) => (a as any).root)).toEqual(["/project", "/project"]);
});
it("ignores commands queued for another project", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await queue("/other", "ls");
  expect(mocks.invoke).not.toHaveBeenCalled();
  const { takeTerminalCommands } = await import("../../src/lib/terminalBridge");
  expect(takeTerminalCommands("/other")).toHaveLength(1);
});
it("refuses a seventeenth terminal with a visible notice", async () => {
  renderApp(<TerminalPanel root="/project" />);
  await userEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  for (let i = 1; i < 16; i++) await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  await queue("/project", "ls");
  expect(await screen.findByRole("alert")).toHaveTextContent("maximum is 16");
});
