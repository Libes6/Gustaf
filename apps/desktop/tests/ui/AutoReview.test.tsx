import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentSettings } from "../../src/agent/agentSettingsStore";
import { AutoReviewSettings } from "../../src/components/AutoReviewSettings";
import { ChangesPanel } from "../../src/components/ChangesPanel";
import { GitCommitDialog } from "../../src/components/GitCommitDialog";
import type { CommitContext, GitStatus, Hunk } from "../../src/lib/api";
import { loadAutoReview, resetAutoReview } from "../../src/lib/autoReviewStore";
import { makeApp, project, provider, renderApp } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";

const model = vi.hoisted(() => ({ requests: [] as any[], reply: (async () => ({ parts: [] })) as (req: any) => Promise<unknown> }));
vi.mock("../../src/providers", async (orig) => ({ ...(await orig<typeof import("../../src/providers")>()), getAdapter: async () => ({ turn: (req: any) => (model.requests.push(req), model.reply(req)) }) }));

const hunks: Hunk[] = [{ id: "h1", header: "@@ -1,2 +1,2 @@", old_start: 1, old_lines: 2, new_start: 1, new_lines: 2, lines: [{ kind: " ", text: "keep" }, { kind: "+", text: "const x = y.z;" }] }];
const reply = (findings: unknown[], summary = "Looks mostly fine.") => ({ parts: [{ type: "text", text: JSON.stringify({ findings, summary }) }], usage: { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 } });
const HIGH = { file: "src/a.ts", line: 1, severity: "high", title: "Null deref", detail: "y may be undefined" };

const app = () => makeApp({
  providers: [provider()],
  models: [
    { id: "m1", name: "Model One", providerId: "p1", contextWindow: 200_000, created: 1, firstSeen: 1 },
    { id: "cheap", name: "Cheap", providerId: "p1", contextWindow: 200_000, created: 1, firstSeen: 1 },
  ],
  selection: { providerId: "p1", model: "m1" },
});

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+const x = y.z;";
function backend(over: Record<string, unknown> = {}) {
  mockInvoke({
    review_list: [[{ id: "r1", root: "/work/alpha", workspace: "/tmp/ws" }, [{ path: "src/a.ts", binary: false }, { path: ".env", binary: false }, { path: "img.png", binary: true }]]],
    review_diff: ({ path }: { path: string }) => (path === ".env" ? "+API_KEY=abcdef123456" : DIFF),
    review_hunks: hunks,
    ...over,
  });
}
const panel = (busy: boolean) => <ChangesPanel name="Alpha" root="/work/alpha" busy={busy} messages={[]} tick={0} onChanged={() => {}} />;

async function setup(settings: Record<string, unknown> = { autoReview: { enabled: true, trigger: "afterRun", projects: {} } }, over: Record<string, unknown> = {}) {
  mockSettings(settings);
  backend(over);
  await loadAutoReview();
  return renderApp(panel(true), app());
}
/** The agent run ends: busy goes true -> false. */
const finishRun = (view: Awaited<ReturnType<typeof setup>>) => view.rerenderApp(panel(false));
const chip = () => screen.findByRole("button", { name: /Pending changes · 3/ });
const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  model.requests.length = 0;
  model.reply = async () => reply([]);
  resetAutoReview();
  resetAgentSettings();
});

describe("automatic review: starting", () => {
  it("runs once after a run that left changes, in the background, read-only, and shows a badge", async () => {
    model.reply = async () => reply([HIGH, { file: "src/a.ts", line: 1, severity: "info", title: "Note", detail: "d" }]);
    const view = await setup();
    finishRun(view);
    await waitFor(() => expect(model.requests).toHaveLength(1));
    const req = model.requests[0];
    expect(req.tools).toEqual([]);
    expect(req.access).toBe("readonly");
    expect(view.app.bumpUsage).toHaveBeenCalledWith("p1");
    const badge = await screen.findByLabelText("2 review findings");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveClass("high");
    // A re-render without a new run does not start another one.
    view.rerenderApp(panel(false));
    await pause(30);
    expect(model.requests).toHaveLength(1);
  });

  it("does nothing when the setting is off (the default)", async () => {
    const view = await setup({});
    finishRun(view);
    await pause();
    expect(model.requests).toHaveLength(0);
  });

  it("a per-project override turns it off, or on, against the global default", async () => {
    const off = await setup({ autoReview: { enabled: true, trigger: "afterRun", projects: { "/work/alpha": false } } });
    finishRun(off);
    await pause();
    expect(model.requests).toHaveLength(0);
    off.unmount();
    resetAutoReview();
    const on = await setup({ autoReview: { enabled: false, trigger: "afterRun", projects: { "/work/alpha": true } } });
    finishRun(on);
    await waitFor(() => expect(model.requests).toHaveLength(1));
  });

  it("under 'only before accepting' a finished run starts nothing", async () => {
    const view = await setup({ autoReview: { enabled: true, trigger: "beforeAccept", projects: {} } });
    finishRun(view);
    await pause();
    expect(model.requests).toHaveLength(0);
  });

  it("a new message cancels the review in flight and its findings never appear", async () => {
    let signal: AbortSignal | undefined;
    let release: (v: unknown) => void = () => {};
    model.reply = (req) => { signal = req.signal; return new Promise((r) => { release = r; }); };
    const view = await setup();
    finishRun(view);
    await waitFor(() => expect(model.requests).toHaveLength(1));
    view.rerenderApp(panel(true));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    release(reply([HIGH]));
    await pause(30);
    expect(screen.queryByLabelText(/review finding/)).toBeNull();
  });

  it("uses the review model from the agent settings", async () => {
    const view = await setup({ autoReview: { enabled: true, trigger: "afterRun", projects: {} }, agentSettings: { models: { review: { providerId: "p1", model: "cheap" } } } });
    finishRun(view);
    await waitFor(() => expect(model.requests).toHaveLength(1));
    expect(model.requests[0].model).toBe("cheap");
  });
});

describe("automatic review: what is sent and what goes wrong", () => {
  it("never sends binary or secret-looking files and redacts the rest", async () => {
    const key = "sk-" + "A1b2C3d4".repeat(4);
    const view = await setup(undefined, { review_diff: ({ path }: { path: string }) => (path === ".env" ? "+API_KEY=abcdef123456" : `${DIFF}\n+const apiKey = "${key}";`) });
    finishRun(view);
    await waitFor(() => expect(model.requests).toHaveLength(1));
    const text = model.requests[0].messages[0].parts[0].text as string;
    expect(JSON.parse(text).files.map((f: any) => f.path)).toEqual(["src/a.ts"]);
    expect(text).not.toContain(key);
    expect(text).not.toContain("abcdef123456");
    expect(text).toContain("[REDACTED]");
  });

  it("skips a diff above the cap with a visible note and sends nothing", async () => {
    const view = await setup(undefined, { review_diff: `@@ -1 +1 @@\n+${"x".repeat(60_000)}` });
    finishRun(view);
    await userEvent.click(await chip());
    expect(await screen.findByRole("status")).toHaveTextContent(/Automatic review skipped: the changes are too large to send/);
    expect(model.requests).toHaveLength(0);
  });

  it("only secret or binary files changed: a short note, no request", async () => {
    const view = await setup(undefined, { review_list: [[{ id: "r1", root: "/work/alpha", workspace: "/tmp/ws" }, [{ path: ".env", binary: false }, { path: "pic.png", binary: true }]]], review_diff: "+x" });
    finishRun(view);
    await userEvent.click(await screen.findByRole("button", { name: /Pending changes · 2/ }));
    expect(await screen.findByText(/Automatic review skipped: nothing to review/)).toBeInTheDocument();
    expect(model.requests).toHaveLength(0);
  });

  it("a provider error is a short notice, not an alert, and the panel keeps working", async () => {
    model.reply = async () => { throw new Error("503 overloaded"); };
    const view = await setup();
    finishRun(view);
    await userEvent.click(await chip());
    expect(await screen.findByRole("status")).toHaveTextContent("Automatic review did not complete: 503 overloaded");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Accept file: src/a.ts" })).toBeEnabled();
  });

  it("a malformed reply is a short notice and adds no findings", async () => {
    model.reply = async () => ({ parts: [{ type: "text", text: "no json here" }], usage: undefined });
    const view = await setup();
    finishRun(view);
    await userEvent.click(await chip());
    expect(await screen.findByRole("status")).toHaveTextContent("Automatic review: the model did not return findings in the expected format.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText(/review finding/)).toBeNull();
  });

  it("a rejected backend call while collecting changes never throws into the run", async () => {
    const view = await setup();
    mockInvoke({ review_list: () => Promise.reject(new Error("db locked")) });
    finishRun(view);
    await pause();
    expect(model.requests).toHaveLength(0);
  });
});

describe("automatic review: other change sources", () => {
  const checkpointMessage = { id: 1, chat_id: 1, role: "user", parts: [], meta: { checkpoint: "cp1" }, created_at: 1 } as any;

  it("reviews a direct-edit chat's checkpoint diff (no review copy) and badges the chip", async () => {
    model.reply = async () => reply([{ file: "src/c.ts", severity: "warn", title: "Fragile", detail: "d" }]);
    mockSettings({ autoReview: { enabled: true, trigger: "afterRun", projects: {} } });
    mockInvoke({
      git: ({ args }: { args: string[] }) => (args.includes("--numstat") ? "1\t0\tsrc/c.ts\0" : args.includes("--cached") && args.includes("cp1") ? "diff --git a/src/c.ts b/src/c.ts\n+let c = 1;" : ""),
      review_list: [],
    });
    await loadAutoReview();
    const ui = (busy: boolean) => <ChangesPanel reviewOn={false} name="Alpha" root="/work/alpha" busy={busy} messages={[checkpointMessage]} tick={0} onChanged={() => {}} />;
    const view = renderApp(ui(true), app());
    view.rerenderApp(ui(false));
    await waitFor(() => expect(model.requests).toHaveLength(1));
    expect(JSON.parse(model.requests[0].messages[0].parts[0].text).files.map((f: any) => [f.path, f.diff])).toEqual([["src/c.ts", "diff --git a/src/c.ts b/src/c.ts\n+let c = 1;"]]);
    expect(await screen.findByLabelText("1 review finding")).toBeInTheDocument();
  });

  it("a run with nothing pending starts no review", async () => {
    mockSettings({ autoReview: { enabled: true, trigger: "afterRun", projects: {} } });
    mockInvoke({ git: () => "", review_list: [] });
    await loadAutoReview();
    const ui = (busy: boolean) => <ChangesPanel reviewOn={false} name="Alpha" root="/work/alpha" busy={busy} messages={[checkpointMessage]} tick={0} onChanged={() => {}} />;
    const view = renderApp(ui(true), app());
    view.rerenderApp(ui(false));
    await pause();
    expect(model.requests).toHaveLength(0);
  });
});

describe("review rules label and prompt", () => {
  const rulesFile = ({ path }: { path: string }) => (path === ".mcode/REVIEW.md" ? "     1|Flag any SQL built by string concatenation.\n" : Promise.reject(new Error("no such file")));

  it("shows 'Rules: .mcode/REVIEW.md' when the file exists, and appends it to the system prompt, still without tools", async () => {
    const view = await setup(undefined, { fs_read: rulesFile });
    finishRun(view);
    await userEvent.click(await chip());
    expect(await screen.findByText("Rules: .mcode/REVIEW.md")).toBeInTheDocument();
    await waitFor(() => expect(model.requests).toHaveLength(1));
    const req = model.requests[0];
    expect(req.system).toMatch(/<project_review_rules path="\.mcode\/REVIEW\.md">\nFlag any SQL built by string concatenation\.\n<\/project_review_rules>/);
    expect(req.system).toMatch(/untrusted project content/);
    expect(req.tools).toEqual([]);
    expect(req.access).toBe("readonly");
  });

  it("shows nothing when there is no rules file, also for a manual review", async () => {
    mockSettings({});
    backend({ fs_read: () => Promise.reject(new Error("missing")) });
    renderApp(panel(false), app());
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: "Review all with AI" }));
    await waitFor(() => expect(model.requests).toHaveLength(1));
    expect(screen.queryByText(/^Rules:/)).toBeNull();
    expect(model.requests[0].system).not.toMatch(/project_review_rules/);
  });
});

describe("high-severity gate", () => {
  async function withHighFinding(settings?: Record<string, unknown>) {
    model.reply = async () => reply([HIGH]);
    const view = await setup(settings);
    finishRun(view);
    await userEvent.click(await chip());
    await screen.findByText("Null deref");
    return view;
  }

  it("accepting a file asks first, lists the finding, and 'Accept anyway' still accepts (never a hard block)", async () => {
    await withHighFinding();
    await userEvent.click(screen.getByRole("button", { name: "Accept file: src/a.ts" }));
    const gate = await screen.findByRole("alert");
    expect(gate).toHaveTextContent("1 high-severity finding — review or dismiss first");
    expect(gate).toHaveTextContent("src/a.ts:1");
    expect(gate).toHaveTextContent("Null deref");
    expect(callsOf("review_decide")).toEqual([]);
    await userEvent.click(within(gate).getByRole("button", { name: "Accept anyway" }));
    await waitFor(() => expect(callsOf("review_decide")).toEqual([{ id: "r1", path: "src/a.ts", accept: true }]));
  });

  it("'Back to review' accepts nothing", async () => {
    await withHighFinding();
    await userEvent.click(screen.getByRole("button", { name: "Accept file: src/a.ts" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back to review" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsOf("review_decide")).toEqual([]);
  });

  it("dismissing with a reason removes it from the gate and the panel, and accepting then goes ahead", async () => {
    await withHighFinding();
    await userEvent.click(screen.getByRole("button", { name: "Accept file: src/a.ts" }));
    const gate = await screen.findByRole("alert");
    await userEvent.type(within(gate).getByLabelText("Reason for dismissing (optional): Null deref"), "guarded by the caller");
    await userEvent.click(within(gate).getByRole("button", { name: "Dismiss: Null deref" }));
    expect(await screen.findByText("All high-severity findings are dismissed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(callsOf("review_decide")).toHaveLength(1));
    expect(screen.queryByText("Null deref")).toBeNull();
  });

  it("warnings and notes never trigger the confirm step", async () => {
    model.reply = async () => reply([{ file: "src/a.ts", line: 1, severity: "warn", title: "Fragile", detail: "d" }]);
    const view = await setup();
    finishRun(view);
    await userEvent.click(await chip());
    await screen.findByText("Fragile");
    await userEvent.click(screen.getByRole("button", { name: "Accept file: src/a.ts" }));
    await waitFor(() => expect(callsOf("review_decide")).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("with automatic review off, high findings of a manual review do not put a step in the way", async () => {
    model.reply = async () => reply([HIGH]);
    mockSettings({});
    backend();
    renderApp(panel(false), app());
    await userEvent.click(await chip());
    await userEvent.click(await screen.findByRole("button", { name: "Review all with AI" }));
    await screen.findByText("Null deref");
    await userEvent.click(screen.getByRole("button", { name: "Accept file: src/a.ts" }));
    await waitFor(() => expect(callsOf("review_decide")).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("under 'only before accepting' the accept click runs the review first, then asks", async () => {
    model.reply = async () => reply([HIGH]);
    const view = await setup({ autoReview: { enabled: true, trigger: "beforeAccept", projects: {} } });
    finishRun(view);
    await userEvent.click(await chip());
    expect(model.requests).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "Accept file: src/a.ts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 high-severity finding");
    expect(model.requests).toHaveLength(1);
    expect(callsOf("review_decide")).toEqual([]);
  });

  describe("commit dialog", () => {
    const status: GitStatus = { repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", inProgress: null, total: 1, files: [{ path: "src/a.ts", kind: "modified", staged: false }] };
    const result = { sha: "f".repeat(40), short: "fffffff", branch: "main", files: ["src/a.ts"], createdBranch: false };
    const context: CommitContext = { files: ["src/a.ts"], stat: "", diff: "", truncated: false, recent: [] };
    const high = [{ id: "f1", file: "src/a.ts", line: 3, title: "SQL injection" }, { id: "f2", file: "other.ts", title: "elsewhere" }];

    function open(gate?: Parameters<typeof GitCommitDialog>[0]["gate"]) {
      mockInvoke({ git_status: status, git_commit: result, git_commit_context: context });
      return renderApp(<GitCommitDialog root="/work/alpha" accepted={["src/a.ts"]} gate={gate} onClose={() => {}} onCommitted={() => {}} />, app());
    }
    const commit = async () => {
      await screen.findByText("main");
      await userEvent.type(screen.getByLabelText("Commit message"), "Fix it");
      await userEvent.click(screen.getByRole("button", { name: /^Commit 1 file$/ }));
    };

    it("lists the high findings of the ticked files, then 'Commit anyway' commits", async () => {
      const ensure = vi.fn(async () => {});
      open({ ensure, high: (paths) => high.filter((f) => paths.includes(f.file)), dismiss: vi.fn() });
      await commit();
      const gate = await screen.findByRole("alert");
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(gate).toHaveTextContent("1 high-severity finding — review or dismiss first");
      expect(gate).toHaveTextContent("SQL injection");
      expect(gate).not.toHaveTextContent("elsewhere");
      expect(callsOf("git_commit")).toEqual([]);
      await userEvent.click(within(gate).getByRole("button", { name: "Commit anyway" }));
      await waitFor(() => expect(callsOf("git_commit")).toHaveLength(1));
    });

    it("commits straight away when nothing high is open, or when there is no gate", async () => {
      open({ ensure: async () => {}, high: () => [], dismiss: vi.fn() });
      await commit();
      await waitFor(() => expect(callsOf("git_commit")).toHaveLength(1));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a failing review step never blocks the commit", async () => {
      open({ ensure: async () => { throw new Error("provider down"); }, high: () => [], dismiss: vi.fn() });
      await commit();
      await waitFor(() => expect(callsOf("git_commit")).toHaveLength(1));
    });

    it("dismissing from the step calls the gate with the reason", async () => {
      const dismiss = vi.fn();
      open({ ensure: async () => {}, high: () => high.slice(0, 1), dismiss });
      await commit();
      const gate = await screen.findByRole("alert");
      fireEvent.change(within(gate).getByLabelText(/Reason for dismissing/), { target: { value: "false positive" } });
      await userEvent.click(within(gate).getByRole("button", { name: "Dismiss: SQL injection" }));
      expect(dismiss).toHaveBeenCalledWith("f1", "false positive");
    });
  });
});

describe("settings", () => {
  const view = () => renderApp(<AutoReviewSettings />, makeApp({ projects: [project(), project({ id: 2, name: "Beta", path: "/work/beta" })] }));
  const saved = () => callsOf("db_execute").map((a: any) => a.params).filter((p: any[]) => p?.[0] === "autoReview").map((p: any[]) => JSON.parse(p[1]));

  it("is off by default, states the cost, and saves the switch", async () => {
    mockSettings({});
    view();
    const toggle = screen.getByRole("switch", { name: "Review changes automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/each review is one more model request that sends the diff to the provider/)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(saved().slice(-1)[0]).toMatchObject({ enabled: true, trigger: "afterRun" });
  });

  it("chooses the trigger and a per-project override", async () => {
    mockSettings({ autoReview: { enabled: true, trigger: "afterRun", projects: {} } });
    view();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Review changes automatically" })).toHaveAttribute("aria-checked", "true"));
    await userEvent.selectOptions(screen.getByLabelText("When to review"), "beforeAccept");
    expect(saved().slice(-1)[0]).toMatchObject({ enabled: true, trigger: "beforeAccept" });
    const beta = screen.getByLabelText("Automatic review for Beta");
    expect(beta).toHaveValue("default");
    await userEvent.selectOptions(beta, "off");
    expect(saved().slice(-1)[0].projects).toEqual({ "/work/beta": false });
    await userEvent.selectOptions(beta, "default");
    expect(saved().slice(-1)[0].projects).toEqual({});
  });
});
