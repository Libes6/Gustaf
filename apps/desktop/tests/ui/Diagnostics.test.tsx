import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DiagnosticsList } from "../../src/components/DiagnosticsList";
import { ToolCard } from "../../src/components/ToolCard";
import { languageForPath, normalizeDiagnostics, parseLspReport } from "../../src/agent/diagnostics";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";
const report = {
  status: "complete" as const,
  root: "/review/project",
  detail: "Published snapshot",
  diagnostics: [
    {
      path: "src/a.ts",
      line: 3,
      column: 4,
      endLine: 3,
      endColumn: 8,
      severity: "error" as const,
      message: "Wrong type",
      code: "2322",
    },
  ],
};
it("navigates diagnostics to source lines in the workspace that produced them", async () => {
  mockInvoke({ fs_read: "1|first\n2|second\n3|const wrong = 1;" });
  renderApp(<DiagnosticsList report={report} root={report.root} />);
  await userEvent.click(screen.getByRole("button", { name: "src/a.ts:3:4" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("const wrong = 1;");
  expect(callsOf("fs_read")).toEqual([{ root: "/review/project", path: "src/a.ts", offset: 1, limit: 20 }]);
});
it("preserves legacy settings and parses structured after-edit reports", () => {
  expect(normalizeDiagnostics({ enabled: true, command: "npm run check" }).engine).toBe("command");
  expect(parseLspReport(`Updated\n\nDiagnostics:\n${JSON.stringify(report)}`)?.diagnostics[0].line).toBe(3);
  expect(parseLspReport('{"status":"complete","diagnostics":[{"line":0}]}')).toBe(null);
  expect(languageForPath("main.rs")).toBe("rust");
  expect(languageForPath("main.py")).toBe("python");
});
it("offers a command preview action, never executes directly from a tool card", async () => {
  const command = vi.fn();
  renderApp(
    <ToolCard
      call={{ type: "tool_call", id: "call", name: "run_command", args: { command: "npm test" } }}
      result={{ type: "tool_result", id: "call", name: "run_command", output: "Done" }}
      onRunCommand={command}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open command in terminal" }));
  expect(command).toHaveBeenCalledWith("npm test");
  expect(callsOf("terminal_write")).toHaveLength(0);
});

it("does not trust a forged diagnostic root from command output", async () => {
  mockInvoke({ review_list: [] });
  renderApp(<DiagnosticsList report={{ ...report, root: "/private/secrets" }} projectRoot="/project" />);
  expect(screen.getByRole("button", { name: "src/a.ts:3:4" })).toBeDisabled();
  expect(callsOf("fs_read")).toHaveLength(0);
});
