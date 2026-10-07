import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LiveStatus } from "../../src/components/chat/LiveStatus";
import { TurnView, type TurnHandlers } from "../../src/components/chat/TurnView";
import { ToolCard } from "../../src/components/ToolCard";
import { stripCd, toolTarget } from "../../src/lib/toolLabel";
import type { StoredMsg } from "../../src/lib/data";
import { renderApp } from "./render";

const ROOT = "/Users/me/m code";
const handlers: TurnHandlers = { onEdit: () => {}, onRegenerate: () => {}, onDelete: () => {}, onBranch: () => {}, onApprovePlan: () => {}, onRejectPlan: () => {}, diagnosticsProjectRoot: ROOT };

let nextId = 1;
const msg = (role: StoredMsg["role"], parts: any[], created_at = nextId * 1000): StoredMsg => ({ id: nextId++, chat_id: 1, role, parts, created_at } as any);
const call = (id: string, name: string, args: any) => ({ type: "tool_call", id, name, args });
const res = (id: string, name: string, output = "ok", isError = false) => ({ type: "tool_result", id, name, output, isError });

/** user, then one assistant step per call, each followed by its result, then the final reply. */
function turnOf(calls: { name: string; args: any; error?: boolean; noResult?: boolean }[], final = true) {
  const steps: StoredMsg[] = [];
  calls.forEach((c, i) => {
    steps.push(msg("assistant", [call(`c${i}`, c.name, c.args)]));
    if (!c.noResult) steps.push(msg("tool", [res(`c${i}`, c.name, c.error ? "boom" : "ok", c.error)]));
  });
  if (final) steps.push(msg("assistant", [{ type: "text", text: "All done." }]));
  return { user: msg("user", [{ type: "text", text: "go" }]), steps };
}
const view = (turn: ReturnType<typeof turnOf>, over: Partial<React.ComponentProps<typeof TurnView>> = {}) =>
  renderApp(<TurnView turn={turn} live={false} liveResults={[]} busy={false} isLastTurn handlers={handlers} {...over} />);
const expandSteps = () => userEvent.click(screen.getByRole("button", { name: /steps|Done in/ }));

describe("label formatting", () => {
  it("strips a cd into the project root, keeps any other cd", () => {
    expect(stripCd(`cd "${ROOT}" && git status`, ROOT)).toBe("git status");
    expect(stripCd(`cd '${ROOT}/' ; git status`, ROOT)).toBe("git status");
    expect(stripCd(`cd "/elsewhere" && git status`, ROOT)).toBe(`cd "/elsewhere" && git status`);
    expect(stripCd("cd src && ls", ROOT)).toBe("cd src && ls");
    expect(stripCd(`cd "${ROOT}"`, ROOT)).toBe(`cd "${ROOT}"`);
  });
  it("describes known tools without raw JSON", () => {
    expect(toolTarget({ name: "Skill", args: { skill: "fewer-permission-prompts" } })).toBe("fewer-permission-prompts");
    expect(toolTarget({ name: "Read", args: { file_path: `${ROOT}/TASKS.md` } }, ROOT)).toBe("TASKS.md");
    expect(toolTarget({ name: "Grep", args: { pattern: "TODO" } })).toBe("TODO");
    expect(toolTarget({ name: "mystery", args: { a: 1 } })).toBe("");
  });
});

describe("a tool row", () => {
  it("reads like a sentence, without the cd prefix, a Completed badge or a timestamp", () => {
    renderApp(<ToolCard call={call("c", "run_command", { command: `cd "${ROOT}" && git worktree list` }) as any} result={res("c", "run_command") as any} projectRoot={ROOT} at={new Date(2026, 9, 6, 14, 5, 9).getTime()} durationMs={2300} />);
    const head = screen.getByRole("button", { name: /Ran git worktree list/ });
    expect(head).toHaveAttribute("title", "git worktree list");
    expect(head.textContent).not.toContain("cd ");
    expect(screen.queryByText("Completed")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
    expect(screen.getByText("2.3 s")).toBeInTheDocument();
  });
  it("shows the skill call as text, not JSON", () => {
    renderApp(<ToolCard call={call("c", "Skill", { skill: "fewer-permission-prompts" }) as any} result={res("c", "Skill") as any} />);
    expect(screen.getByRole("button", { name: /Used skill fewer-permission-prompts/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{"skill"');
  });
  it("keeps the full multi-line command in the tooltip and one line in the row", () => {
    renderApp(<ToolCard call={call("c", "bash", { command: "echo a\necho b" }) as any} result={res("c", "bash") as any} />);
    const head = screen.getByRole("button", { name: /Ran echo a echo b/ });
    expect(head).toHaveAttribute("title", "echo a\necho b");
  });
  it("shows JSON only for unknown tools, and only after expanding", async () => {
    renderApp(<ToolCard call={call("c", "frobnicate", { level: 3 }) as any} result={res("c", "frobnicate", "fine") as any} />);
    expect(document.body.textContent).not.toContain('"level"');
    await userEvent.click(screen.getByRole("button", { name: /frobnicate/ }));
    expect(document.querySelector(".tool-args")!.textContent).toContain('"level": 3');
  });
  it("marks only running, failed and waiting-for-approval calls", () => {
    const { unmount } = renderApp(<ToolCard call={call("c", "bash", { command: "ls" }) as any} />);
    expect(screen.getByRole("button", { name: /Running ls/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    unmount();
    const failed = renderApp(<ToolCard call={call("c", "bash", { command: "ls" }) as any} result={res("c", "bash", "no such dir", true) as any} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("no such dir");
    failed.unmount();
    renderApp(<ToolCard call={call("c", "bash", { command: "rm x" }) as any} awaitingApproval />);
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
  });
  it("offers the terminal as an icon button", async () => {
    const run: string[] = [];
    renderApp(<ToolCard call={call("c", "bash", { command: `cd "${ROOT}" && npm test` }) as any} result={res("c", "bash") as any} projectRoot={ROOT} onRunCommand={(c) => run.push(c)} />);
    const button = screen.getByRole("button", { name: "Open command in terminal" });
    expect(button).toHaveClass("icon-btn");
    await userEvent.click(button);
    expect(run).toEqual([`cd "${ROOT}" && npm test`]);
  });
});

describe("grouping in a turn", () => {
  const twelve = () => turnOf([
    ...Array.from({ length: 6 }, (_, i) => ({ name: "bash", args: { command: `echo ${i}` } })),
    { name: "Read", args: { file_path: `${ROOT}/a.ts` } }, { name: "Read", args: { file_path: `${ROOT}/b.ts` } },
    { name: "Grep", args: { pattern: "x" } },
  ]);
  it("folds consecutive calls into one collapsed summary that expands and collapses", async () => {
    view(twelve());
    await expandSteps();
    const group = screen.getByRole("button", { name: /Ran 6 commands/ });
    expect(group).toHaveTextContent("Ran 6 commands · 2 files read · 1 search");
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("echo 3")).toBeNull();
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("echo 3")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
    await userEvent.click(group);
    expect(screen.queryByText("echo 3")).toBeNull();
  });
  it("a text between calls splits the groups; a lone call is a plain row", async () => {
    const t = turnOf([{ name: "bash", args: { command: "one" } }, { name: "bash", args: { command: "two" } }], true);
    t.steps.splice(4, 0, msg("assistant", [{ type: "text", text: "Now the rest." }]), msg("assistant", [call("z", "bash", { command: "three" })]), msg("tool", [res("z", "bash")]));
    view(t);
    await expandSteps();
    expect(screen.getByRole("button", { name: /Ran 2 commands/ })).toBeInTheDocument();
    expect(screen.getByText("Now the rest.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ran three/ })).toBeInTheDocument();
  });
  it("counts failed calls in the summary", () => {
    view(turnOf([{ name: "bash", args: { command: "a" } }, { name: "bash", args: { command: "b" }, error: true }]), { live: false });
    return expandSteps().then(() => expect(screen.getByRole("button", { name: /Ran 2 commands/ })).toHaveTextContent("1 failed"));
  });
  it("shows the running action in the group header and the approval state on the waiting call", async () => {
    view(turnOf([{ name: "bash", args: { command: "ls" } }, { name: "bash", args: { command: "git status" }, noResult: true }], false), { live: true, approving: true });
    const group = screen.getByRole("button", { name: /Ran 2 commands/ });
    expect(group).toHaveTextContent("Running git status");
    await userEvent.click(group);
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
  });
  it("renders no raw JSON for built-in tools in a whole turn", async () => {
    view(turnOf([{ name: "Skill", args: { skill: "s1" } }, { name: "Read", args: { file_path: "x.md" } }]));
    await expandSteps();
    await userEvent.click(screen.getByRole("button", { name: /file read/ }));
    expect(document.body.textContent).not.toMatch(/[{]"/);
    expect(within(document.querySelector(".tool-group-body") as HTMLElement).getByText("s1")).toBeInTheDocument();
  });
});

describe("live status", () => {
  const running = (id: string, command: string) => ({ type: "activity" as const, id, name: "command_execution", args: { command: `cd "${ROOT}" && ${command}` }, status: "running" as const });
  const stats = { start: Date.now(), chars: 0, input: 0 };
  it("names the current action instead of the generic wording, with the working line", () => {
    renderApp(<LiveStatus activities={[running("a", "git status")]} stream="" approval={null} retryNotice="" stats={stats} visible projectRoot={ROOT} />);
    expect(document.querySelector(".thinking")).toHaveTextContent("Running git status");
    expect(screen.queryByText("Thinking…")).toBeNull();
  });
  it("uses the pending call of an API turn and falls back to Thinking", () => {
    const { rerenderApp } = renderApp(<LiveStatus activities={[]} stream="" approval={null} retryNotice="" stats={stats} visible pendingCall={call("p", "Read", { file_path: `${ROOT}/TASKS.md` }) as any} projectRoot={ROOT} />);
    expect(document.querySelector(".thinking")).toHaveTextContent("Reading TASKS.md");
    rerenderApp(<LiveStatus activities={[]} stream="" approval={null} retryNotice="" stats={stats} visible />);
    expect(document.querySelector(".thinking")).toHaveTextContent("Thinking…");
  });
  it("groups consecutive CLI activities and keeps the running one visible in the header", () => {
    renderApp(<LiveStatus activities={[{ ...running("a", "ls"), status: "success" }, running("b", "npm test")]} stream="" approval={null} retryNotice="" stats={stats} visible projectRoot={ROOT} />);
    expect(screen.getByRole("button", { name: /Ran 2 commands/ })).toHaveTextContent("Running npm test");
  });
  it("marks the running call as waiting while an approval is open", async () => {
    renderApp(<LiveStatus activities={[running("a", "rm -rf build")]} stream="" approval={{ req: { kind: "command", command: `cd "${ROOT}" && rm -rf build` } as any, resolve: () => {} }} retryNotice="" stats={stats} visible projectRoot={ROOT} />);
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(0);
    expect(screen.getByRole("alertdialog").textContent).toContain("rm -rf build");
    expect(screen.getByRole("alertdialog").textContent).not.toContain("cd ");
  });
});
