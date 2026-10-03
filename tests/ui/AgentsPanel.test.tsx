import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "../../src/components/AgentsPanel";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const runRow = (id: string, title: string, status: string, over: Record<string, unknown> = {}) => ({
  id, chat_id: 1, title, type: "explore", model: "m1", status, started_at: 1000, ended_at: 5000, tokens: 1200, tool_uses: 2, error: null, summary: "short report",
  provider_id: "p1", project_root: "/work/alpha", created_at: Number(id.replace(/\D/g, "")) || 1, changed_json: null, warnings_json: null, ...over,
});
const longResult = `${"line of a long tool result\n".repeat(30)}END-OF-RESULT`;
const messages = [
  { seq: 0, role: "user", parts_json: JSON.stringify([{ type: "text", text: "Find the parser" }]), created_at: 1 },
  { seq: 1, role: "assistant", parts_json: JSON.stringify([{ type: "tool_call", id: "c1", name: "read_file", args: { path: "parser.ts" } }]), created_at: 2 },
  { seq: 2, role: "tool", parts_json: JSON.stringify([{ type: "tool_result", id: "c1", name: "read_file", output: longResult }]), created_at: 3 },
];

function setup(onContinue = vi.fn()) {
  mockInvoke({
    db_select: ({ sql }: { sql: string }) => {
      if (/from settings where key/.test(sql)) return [{ value: "true" }]; // legacy runs already migrated
      if (/from agent_runs/.test(sql)) return [runRow("r3", "Parser scout", "budget"), runRow("r2", "Stopped one", "cancelled"), runRow("r1", "Done one", "completed")];
      if (/from agent_messages/.test(sql)) return messages;
      return [];
    },
  });
  renderApp(<AgentsPanel root="/work/alpha" onContinue={onContinue} />);
  return onContinue;
}

describe("AgentsPanel", () => {
  it("lists the runs stored in SQLite and reads the full transcript only when it is opened", async () => {
    setup();
    const header = await screen.findByRole("button", { name: /Background agents/i });
    fireEvent.click(header);
    expect(await screen.findByText("Parser scout")).toBeInTheDocument();
    expect(screen.getByText("Over budget")).toBeInTheDocument();
    expect(callsOf("db_select").some((a: any) => /from agent_messages/.test(a.sql))).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: "View transcript" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Parser scout" });
    // The whole stored tool result is there, not a 240-character clip.
    await waitFor(() => expect(within(dialog).getByText(/END-OF-RESULT/)).toBeInTheDocument());
    expect(within(dialog).getByText(/Find the parser/)).toBeInTheDocument();
    expect(callsOf("db_select").filter((a: any) => /from agent_messages/.test(a.sql) && a.params[0] === "r3").length).toBeGreaterThan(0);
  });

  it("continues a finished run: the follow-up becomes a request for the main agent; cancelled runs cannot be continued", async () => {
    const onContinue = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Background agents/i }));
    await screen.findByText("Parser scout");
    // One continue button per continuable run (the budget-stopped and the completed one, not the cancelled one).
    const buttons = screen.getAllByRole("button", { name: "Continue this agent" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole("dialog", { name: "Parser scout" });
    const send = within(dialog).getByRole("button", { name: "Continue this agent" });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Continue this agent" }), "also check the lexer");
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onContinue).toHaveBeenCalledTimes(1);
    const message = onContinue.mock.calls[0][0] as string;
    expect(message).toContain('continue_from "r3"');
    expect(message).toContain('type "explore"');
    expect(message.endsWith("also check the lexer")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
