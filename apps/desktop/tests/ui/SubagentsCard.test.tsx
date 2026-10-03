import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithSubagents, SubagentsCard, type SubagentActivity } from "../../src/components/SubagentsCard";
import { ToolCard } from "../../src/components/ToolCard";
import type { Part } from "../../src/providers/types";
import { renderApp } from "./render";
import { mockInvoke } from "./tauri";

const agent = (id: string, over: Partial<SubagentActivity["subagent"]> = {}, top: Partial<SubagentActivity> = {}): SubagentActivity => ({
  type: "activity", id, name: "subagent", args: {}, status: "running",
  subagent: { provider: "codex", agentId: `thread-${id}`, title: `Task ${id}`, action: "wait", state: "running", ...over },
  ...top,
});

describe("SubagentsCard", () => {
  it("shows Codex agents read from rollout files: title, state, latest step and tokens", () => {
    mockInvoke({});
    const agents = [
      agent("a", { action: "scan", state: "completed", result: "alpha ok", tokens: 1500, toolUses: 3 }, { status: "success", output: "alpha ok" }),
      agent("b", { action: "scan", state: "running", step: "cargo test", role: "task_b" }),
      agent("c", { action: "scan", state: "running" }),
    ];
    renderApp(<SubagentsCard agents={agents} />);
    const rows = within(screen.getByRole("region", { name: "Subagents" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("cargo test")).toBeInTheDocument();
    expect(within(rows[1]).getByText("task_b")).toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Task a/ }));
    expect(within(rows[0]).getByText("1.5k tokens")).toBeInTheDocument();
    expect(within(rows[0]).getByText("3 tool uses")).toBeInTheDocument();
  });

  it("shows one card with counts and one row per agent; a row expands to its task and report", () => {
    mockInvoke({});
    const agents = [
      agent("a", { state: "completed", waits: 5, prompt: "Count the files", result: "42 files" }, { status: "success", output: "42 files\nin total" }),
      agent("b", { state: "waiting" }),
      agent("c", { state: "failed", result: "boom" }, { status: "error", output: "boom" }),
    ];
    renderApp(<SubagentsCard agents={agents} />);
    const card = screen.getByRole("region", { name: "Subagents" });
    expect(within(card).getByText("1 running · 1 done · 1 failed")).toBeInTheDocument();
    const rows = within(card).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Done")).toBeInTheDocument();
    expect(within(rows[0]).getByText("42 files")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Waiting")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Failed")).toBeInTheDocument();

    const head = within(rows[0]).getByRole("button", { name: /Task a/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(rows[0]).getByText("Count the files")).toBeInTheDocument();
    expect(within(rows[0]).getByText("waited ×5")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/42 files\s+in total/)).toBeInTheDocument();
  });

  it("an agent still running when the turn ended reads as Ended; unnamed agents show a short id", () => {
    mockInvoke({});
    renderApp(<SubagentsCard agents={[agent("x", { title: "", agentId: "019a-abcdef" }, { status: "unknown" })]} />);
    expect(screen.getByText("Ended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agent abcdef/ })).toBeInTheDocument();
  });

  it("replaces a run of subagent activities by a single card and leaves other parts alone", () => {
    mockInvoke({});
    const parts: Part[] = [
      { type: "activity", id: "cmd", name: "command_execution", args: { command: "ls" }, status: "success" },
      agent("a"), agent("b"), agent("c"), agent("d"), agent("e"),
      { type: "text", text: "all done" },
    ];
    renderApp(<>{renderWithSubagents(parts, (p, i) => (p.type === "activity" ? <ToolCard key={p.id} call={p} /> : <p key={i}>{p.type === "text" ? p.text : ""}</p>))}</>);
    expect(screen.getAllByRole("region", { name: "Subagents" })).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText("collab_tool_call")).toBeNull();
    expect(screen.getByText("ls")).toBeInTheDocument();
    expect(screen.getByText("all done")).toBeInTheDocument();
    // The group can be collapsed.
    fireEvent.click(screen.getByRole("button", { name: /Subagents/ }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
