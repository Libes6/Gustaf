import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRun, recordStep, resetAgentRuns, updateRun } from "../../src/agent/agentRuns";
import { finishCliAgents, resetCliAgents, trackCliAgents } from "../../src/agent/cliAgents";
import { AgentsColumn, AgentsToggle } from "../../src/components/AgentsPanel";
import { useBackgroundTasks } from "../../src/lib/useBackgroundTasks";
import { applyActivity } from "../../src/providers/activities";
import { createRolloutTracker } from "../../src/providers/codexRollout";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

/** What ChatView does: the toggle in the chat and the column when it is open. */
function Panel({ onContinue }: { onContinue?: (m: string) => void }) {
  const tasks = useBackgroundTasks("/work/alpha");
  const toggleRef = useRef<HTMLButtonElement>(null);
  return <><AgentsToggle tasks={tasks} buttonRef={toggleRef} />{tasks.open && <AgentsColumn root="/work/alpha" tasks={tasks} onContinue={onContinue} toggleRef={toggleRef} />}</>;
}
const openColumn = async () => { fireEvent.click(await screen.findByRole("button", { name: /Background tasks/ })); };

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
  renderApp(<Panel onContinue={onContinue} />);
  return onContinue;
}

describe("AgentsPanel: CLI-native subagents", () => {
  const cliAct = (id: string, state: "running" | "completed" | "stopped" | "failed", over: Record<string, unknown> = {}) => ({
    type: "activity" as const, id, name: "subagent", args: {}, status: state === "running" ? ("running" as const) : state === "completed" ? ("success" as const) : ("unknown" as const),
    subagent: { provider: "codex" as const, agentId: `thread-${id}`, title: `Worker ${id}`, action: "wait" as const, state, prompt: "Count the files", ...over },
    ...(state === "completed" ? { output: "42 files in total" } : {}),
  });
  // The run store loads its rows once per module: leave it untouched for the tests below.
  afterEach(() => { resetAgentRuns(); resetCliAgents(); });
  const render = () => {
    mockInvoke({ db_select: ({ sql }: { sql: string }) => (/from settings where key/.test(sql) ? [{ value: "true" }] : []) });
    renderApp(<Panel />);
  };

  it("mirrors a live Codex subagent read-only, then lists it as finished once the run ends; stop says it stops the whole run", async () => {
    resetCliAgents();
    render();
    expect(screen.queryByRole("complementary")).toBeNull();
    const stop = vi.fn();
    act(() => trackCliAgents({ chatId: 1, root: "/work/alpha", stop }, [cliAct("a", "running", { step: "reading files" })]));
    // The panel opens by itself when the first agent starts.
    expect(await screen.findByText("Worker a")).toBeInTheDocument();
    expect(screen.getByText("Agent · Codex")).toBeInTheDocument();
    expect(screen.getByText("reading files")).toBeInTheDocument();
    // The CLI cannot stop one subagent: the button aborts the whole run, and its accessible name says so.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const stopBtn = screen.getByRole("button", { name: "Stop the whole Codex run" });
    expect(stopBtn).toHaveAttribute("title", "Stops the whole Codex run, not just this agent.");
    expect(screen.queryByRole("button", { name: "Continue this agent" })).toBeNull();
    fireEvent.click(stopBtn);
    expect(stop).toHaveBeenCalledTimes(1);

    act(() => { trackCliAgents({ chatId: 1, root: "/work/alpha", stop }, [cliAct("a", "completed")]); finishCliAgents(1); });
    expect(screen.getByRole("button", { name: "Finished 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const dialog = await screen.findByRole("dialog", { name: "Worker a" });
    expect(within(dialog).getByText("Count the files")).toBeInTheDocument();
    expect(within(dialog).getByText("42 files in total")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() => expect(screen.queryByText("Worker a")).toBeNull());
    resetCliAgents();
  });

  it("shows three Codex cards from a mocked rollout scan (through the real tracker and the invoke command), then a finished one after the last scan", async () => {
    resetCliAgents();
    const rollout = (nick: string, state: string, over: Record<string, unknown> = {}) => ({
      id: `thread-${nick}`, key: `parent:task_${nick}`, threadId: `thread-${nick}`, parentThreadId: "parent", nickname: nick, taskName: `task_${nick}`, state,
      startedAtMs: Date.now() - 5000, toolUses: 2, step: `cargo test ${nick}`, tokens: { input: 1000, output: 200, cached: 0, reasoning: 0, total: 1500 }, ...over,
    });
    let phase = 0;
    mockInvoke({
      db_select: ({ sql }: { sql: string }) => (/from settings where key/.test(sql) ? [{ value: "true" }] : []),
      codex_agents_scan: () => ({
        parentFound: true, truncated: false, notes: [],
        agents: phase === 0
          ? [rollout("Ada", "running"), rollout("Bo", "running"), rollout("Cy", "starting", { threadId: null, id: "pending:parent:task_Cy", step: null, tokens: undefined })]
          : [rollout("Ada", "completed", { lastMessage: "alpha is fine", endedAtMs: Date.now() }), rollout("Bo", "running"), rollout("Cy", "running")],
      }),
    });
    renderApp(<Panel />);
    const map = new Map<string, any>();
    const tracker = createRolloutTracker({
      intervalMs: 3_600_000,
      onActivity: (a) => trackCliAgents({ chatId: 1, root: "/work/alpha" }, [applyActivity(map, a)]),
    });
    tracker.begin("parent");
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Bo")).toBeInTheDocument();
    expect(screen.getByText("Cy")).toBeInTheDocument();
    expect(screen.getAllByText("Agent · Codex")).toHaveLength(3);
    expect(screen.getAllByText("cargo test Ada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.5k tokens").length).toBeGreaterThan(0);
    expect(callsOf("codex_agents_scan")[0]).toMatchObject({ threadId: "parent" });
    expect(screen.queryByRole("button", { name: /^Finished/ })).toBeNull();

    phase = 1;
    // (providers/cli.ts publishes what `finish` returns the same way)
    await act(async () => { for (const a of await tracker.finish(true)) trackCliAgents({ chatId: 1, root: "/work/alpha" }, [applyActivity(map, a)]); });
    // The turn is over: Bo and Cy were still running in the last scan, and the Codex process that ran them is gone, so they
    // are settled as stopped instead of ticking on; nothing is left under Running.
    await waitFor(() => expect(screen.getByRole("button", { name: "Finished 3" })).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Running" })).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getAllByText("Stopped")).toHaveLength(2);
    expect(screen.getByText("alpha is fine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Background tasks · 0 running" })).toBeInTheDocument();
    resetCliAgents();
  });

  it("stopped agents sit under Finished with a neutral Stopped label, never under Running, and do not count in the badge", async () => {
    resetCliAgents();
    render();
    act(() => trackCliAgents({ chatId: 1, root: "/work/alpha", stop: vi.fn() }, [
      cliAct("a", "running"),
      cliAct("b", "stopped", { endedAt: Date.now() }),
      cliAct("c", "failed", { endedAt: Date.now() }),
    ]));
    expect(await screen.findByRole("button", { name: "Background tasks · 1 running" })).toBeInTheDocument();
    const running = screen.getByRole("region", { name: "Running" });
    expect(within(running).getAllByRole("article")).toHaveLength(1);
    expect(within(running).getByRole("article", { name: "Worker a" })).toBeInTheDocument();
    const finished = screen.getByRole("region", { name: "Finished" });
    fireEvent.click(within(finished).getByRole("button", { name: "Finished 2" }));
    const stopped = within(finished).getByRole("article", { name: "Worker b" });
    expect(within(stopped).getByText("Stopped")).toBeInTheDocument();
    expect(within(stopped).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(within(finished).getByRole("article", { name: "Worker c" })).getByText("Failed")).toBeInTheDocument();
    resetCliAgents();
  });

  it("does not show subagents of another project", async () => {
    resetCliAgents();
    render();
    act(() => trackCliAgents({ chatId: 1, root: "/work/other" }, [cliAct("z", "running")]));
    expect(screen.queryByText("Worker z")).toBeNull();
    resetCliAgents();
  });
});

describe("AgentsPanel", () => {
  it("lists the runs stored in SQLite and reads the full transcript only when it is opened", async () => {
    setup();
    await openColumn();
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
    await openColumn();
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

  it("in Russian the CLI stop button says it stops the whole run", async () => {
    resetCliAgents();
    mockInvoke({ db_select: ({ sql }: { sql: string }) => (/from settings where key/.test(sql) ? [{ value: "true" }] : []) });
    renderApp(<Panel />, undefined, "ru");
    act(() => trackCliAgents({ chatId: 1, root: "/work/alpha", stop: vi.fn() }, [{
      type: "activity" as const, id: "a", name: "subagent", args: {}, status: "running" as const,
      subagent: { provider: "codex" as const, agentId: "thread-a", title: "Worker a", action: "wait" as const, state: "running" as const },
    }]));
    expect(await screen.findByText("Worker a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Остановить весь запуск Codex" })).toHaveAttribute("title", "Останавливает весь запуск Codex, а не только этого агента.");
  });

  it("shows a card per run (title, muted type line, model · tokens · tool uses, current step) with a square stop button; finished runs fold into a collapsible row", async () => {
    resetAgentRuns(); // the store loads its rows once per module
    mockInvoke({
      db_select: ({ sql }: { sql: string }) => {
        if (/from settings where key/.test(sql)) return [{ value: "true" }];
        if (/from agent_runs/.test(sql)) return [runRow("r1", "Done one", "completed")];
        return [];
      },
    });
    const stop = vi.fn();
    renderApp(<Panel />);
    await screen.findByRole("button", { name: /Background tasks/ });
    act(() => {
      const id = createRun({ title: "Live scout", type: "explore", providerId: "p1", model: "m1", projectRoot: "/work/alpha" }, stop);
      updateRun(id, { status: "running", startedAt: Date.now() });
      recordStep(id, null, { tokens: 15000, toolUses: 4 }, "reading parser.ts");
    });
    const live = await screen.findByRole("article", { name: "Live scout" });
    expect(within(live).getByText("Agent · Explore")).toBeInTheDocument();
    expect(within(live).getByText("m1")).toBeInTheDocument();
    expect(within(live).getByText("15k tokens")).toBeInTheDocument();
    expect(within(live).getByText("4 tool uses")).toBeInTheDocument();
    expect(within(live).getByText("reading parser.ts")).toBeInTheDocument();
    expect(within(live).getByText("0 s")).toBeInTheDocument(); // unit format, not a clock-style 0:00
    // Our own agents stop individually: plain "Stop", no "whole run" wording.
    expect(within(live).queryByRole("button", { name: /whole/ })).toBeNull();
    fireEvent.click(within(live).getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(within(live).getByRole("button", { name: "View transcript" })).toBeInTheDocument();
    // Something is running, so the finished list starts folded.
    const toggle = await screen.findByRole("button", { name: "Finished 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("article", { name: "Done one" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const done = screen.getByRole("article", { name: "Done one" });
    expect(within(done).getByText("Done")).toBeInTheDocument();
    expect(within(done).getByText("short report")).toBeInTheDocument();
    expect(within(done).getByText("4 s")).toBeInTheDocument(); // started_at 1000, ended_at 5000
    expect(within(done).queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Done one" })).toBeNull());
    expect(screen.getByRole("article", { name: "Live scout" })).toBeInTheDocument();
  });
  afterAll(() => resetAgentRuns());
});

describe("Background tasks column", () => {
  const cliAct = (id: string, state: "running" | "completed") => ({
    type: "activity" as const, id, name: "subagent", args: {}, status: state === "running" ? ("running" as const) : state === "completed" ? ("success" as const) : ("unknown" as const),
    subagent: { provider: "codex" as const, agentId: `thread-${id}`, title: `Worker ${id}`, action: "wait" as const, state },
  });
  const ctx = { chatId: 1, root: "/work/alpha" };
  afterEach(() => { resetAgentRuns(); resetCliAgents(); });
  const render = () => {
    resetCliAgents();
    mockInvoke({ db_select: ({ sql }: { sql: string }) => (/from settings where key/.test(sql) ? [{ value: "true" }] : []) });
    renderApp(<Panel />);
  };

  it("is a region with a header (expand, close), has no toggle until an agent exists and opens by itself for the first run only", async () => {
    render();
    expect(screen.queryByRole("button", { name: /Background tasks/ })).toBeNull();
    act(() => trackCliAgents(ctx, [cliAct("a", "running")]));
    const region = await screen.findByRole("complementary", { name: "Background tasks" });
    expect(within(region).getByRole("heading", { name: "Background tasks" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Expand" })).toBeInTheDocument();
    // The toggle carries the number of running agents.
    const toggle = screen.getByRole("button", { name: "Background tasks · 1 running" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("1");

    // The user closes it: focus returns to the toggle and further updates of the same run do not reopen it.
    fireEvent.click(within(region).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    act(() => trackCliAgents(ctx, [{ ...cliAct("a", "running"), subagent: { ...cliAct("a", "running").subagent, step: "reading" } }]));
    expect(screen.queryByRole("complementary")).toBeNull();
    // A new run opens it again.
    act(() => trackCliAgents(ctx, [cliAct("b", "running")]));
    expect(await screen.findByRole("complementary", { name: "Background tasks" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Worker b" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Background tasks · 2 running" })).toBeInTheDocument();
  });

  it("does not open for agents that were already running when the view mounted, and the toggle opens it", async () => {
    resetCliAgents();
    act(() => trackCliAgents(ctx, [cliAct("old", "running")]));
    mockInvoke({ db_select: ({ sql }: { sql: string }) => (/from settings where key/.test(sql) ? [{ value: "true" }] : []) });
    renderApp(<Panel />);
    const toggle = await screen.findByRole("button", { name: /Background tasks/ });
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByRole("article", { name: "Worker old" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("expands to cover the chat area and restores; Escape inside it closes it, Escape inside a transcript dialog only closes the dialog", async () => {
    render();
    act(() => trackCliAgents(ctx, [cliAct("a", "running")]));
    const region = await screen.findByRole("complementary", { name: "Background tasks" });
    expect(region).not.toHaveClass("expanded");
    fireEvent.click(within(region).getByRole("button", { name: "Expand" }));
    expect(region).toHaveClass("expanded");
    fireEvent.click(within(region).getByRole("button", { name: "Restore size" }));
    expect(region).not.toHaveClass("expanded");

    fireEvent.click(within(region).getByRole("button", { name: "View transcript" }));
    const dialog = await screen.findByRole("dialog", { name: "Worker a" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("complementary", { name: "Background tasks" })).toBeInTheDocument();

    fireEvent.keyDown(within(screen.getByRole("complementary")).getByRole("button", { name: "Expand" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows an empty hint when opened without agents and lists finished agents under a collapsible row", async () => {
    render();
    act(() => trackCliAgents(ctx, [cliAct("a", "completed")]));
    await openColumn();
    // Nothing runs, so Finished starts open; its chevron row toggles the list.
    const toggle = screen.getByRole("button", { name: "Finished 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("article", { name: "Worker a" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("article", { name: "Worker a" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() => expect(screen.getByText(/No background agents yet/)).toBeInTheDocument());
  });
});
