import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCard } from "../../src/components/ToolCard";
import {
  clearTerminalCommands,
  hasTerminalCommands,
  requestTerminalCommand,
  takeTerminalCommands,
} from "../../src/lib/terminalBridge";
import { renderApp } from "./render";
import { callsOf } from "./tauri";

afterEach(() => clearTerminalCommands());
const card = (name: string, command: unknown, onRunCommand?: (c: string) => void) =>
  renderApp(
    <ToolCard
      call={{ type: "tool_call", id: "c", name, args: { command } } as any}
      result={{ type: "tool_result", id: "c", name, output: "ok" }}
      onRunCommand={onRunCommand}
    />,
  );

it("queues the exact command for the project root and never touches a shell itself", async () => {
  card("run_command", "npm test -- --watch=false", (c) => requestTerminalCommand("/work/alpha", c));
  await userEvent.click(screen.getByRole("button", { name: "Open command in terminal" }));
  expect(takeTerminalCommands("/work/alpha").map((c) => c.command)).toEqual(["npm test -- --watch=false"]);
  expect(callsOf("terminal_create")).toHaveLength(0);
  expect(callsOf("terminal_write")).toHaveLength(0);
});
it("is offered for CLI provider shell cards too", async () => {
  card("command_execution", "ls", () => {});
  expect(screen.getByRole("button", { name: "Open command in terminal" })).toBeInTheDocument();
});
it("is hidden without a handler, for blank commands, and for non-shell tools", () => {
  card("run_command", "ls");
  expect(screen.queryByRole("button", { name: "Open command in terminal" })).toBeNull();
  card("run_command", "   \n", () => {});
  card("read_file", "ls", () => {});
  card("run_command", ["ls", "-la"], () => {});
  expect(screen.queryByRole("button", { name: "Open command in terminal" })).toBeNull();
});
it("shows the bridge error for an invalid command and queues nothing", async () => {
  card("run_command", "echo \u001b[2J", (c) => requestTerminalCommand("/work/alpha", c));
  await userEvent.click(screen.getByRole("button", { name: "Open command in terminal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid terminal command");
  expect(hasTerminalCommands("/work/alpha")).toBe(false);
});
it("passes the command through on click", async () => {
  const run = vi.fn();
  card("shell", "pwd", run);
  await userEvent.click(screen.getByRole("button", { name: "Open command in terminal" }));
  expect(run).toHaveBeenCalledWith("pwd");
});
