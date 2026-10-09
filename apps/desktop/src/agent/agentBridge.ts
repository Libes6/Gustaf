// App side of the `gustaf-agent` command (docs/features/agents.md, "Subagents from CLI agents"): turns a request from the
// local bridge (src-tauri/src/device_bridge.rs: argv + the per-chat token) into a call on the SAME SubagentHost the
// `spawn_agent` / `delegate_tasks` tools use, and the text the CLI agent prints. Pure of Tauri: agentBridgeNative.ts
// connects it to the real bridge.
//
// A CLI shell has tool timeouts (Claude Code's Bash: 2 minutes), subagents can run much longer. So no call blocks for
// a whole task: `spawn` returns a task id (or waits a short bound), `wait` long-polls in chunks of at most MAX_WAIT_S and
// reports progress until the task is done. Tasks belong to the chat's agent run: they are stopped when it ends or is
// stopped (the same abort chain as API subagents), and their runs appear in the Agents panel like any other.
import { getRun } from "./agentRuns";
import { AGENT_CLI_NAME, DEFAULT_WAIT_S, agentCliErrorText, parseAgentArgv, type AgentCall } from "./agentCli";
import { renderTargets, resolveTarget } from "./agentTargets";
import { createTokenRegistry, type BridgeReply, type BridgeRequest, type TokenRegistry } from "./bridgeTokens";
import type { RunOptions } from "./agent";
import type { RunHooks, SubagentHost } from "./subagents";
import { clip, isActiveStatus, type AgentRun } from "./agentRunsModel";

/** What the running agent turn of a chat provides: its Stop signal, the subagent host and the main loop's options (access, approvals, provider). */
export type AgentTurn = { signal: AbortSignal; host: SubagentHost; parent: RunOptions };

export type AgentBridgeDeps = {
  /** Shared with the device command; default: this bridge's own. */
  tokens?: TokenRegistry;
  /** The run behind a task (progress, provider, model); default: the agent run store. */
  runOf?: (
    runId: string,
  ) =>
    | Pick<
        AgentRun,
        "status" | "title" | "providerId" | "model" | "toolUses" | "tokens" | "currentStep" | "startedAt" | "createdAt"
      >
    | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Records a start or stop in the action log; returns the function that closes the entry. */
  audit?: (tool: string, summary: string) => (status: "success" | "error" | "cancelled", detail?: string) => void;
};

/** Unfinished tasks per chat: more would only queue behind the global concurrency limit. */
export const MAX_ACTIVE_TASKS = 12;
const MAX_KEPT_TASKS = 60;
/** How long a start waits for the run to exist (the validation of arguments and providers happens first). */
const START_WINDOW_MS = 5_000;
const STOP_WINDOW_MS = 10_000;

type Job = {
  id: string;
  kind: "task" | "plan";
  title: string;
  ctl: AbortController;
  runIds: string[];
  state: "running" | "done" | "failed";
  /** The host's report (or the failure message). */
  report: string;
  startedAt: number;
  settled: Promise<void>;
};

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function createAgentBridge(deps: AgentBridgeDeps = {}) {
  const tokens = deps.tokens ?? createTokenRegistry();
  const runOf = deps.runOf ?? ((id: string) => getRun(id));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const turns = new Map<number, AgentTurn>();
  const jobs = new Map<number, Map<string, Job>>();
  const counters = new Map<number, number>();

  const jobsOf = (chatId: number) => {
    let m = jobs.get(chatId);
    if (!m) jobs.set(chatId, (m = new Map()));
    return m;
  };

  /** One line of progress for a running run. */
  function runLine(runId: string): string {
    const r = runOf(runId);
    if (!r) return "starting";
    const since = r.startedAt || r.createdAt;
    const bits = [
      r.status === "queued" ? "queued (waiting for a free slot)" : r.status,
      ...(since && isActiveStatus(r.status) ? [seconds(now() - since)] : []),
      `${r.toolUses} tool uses`,
      ...(r.tokens ? [`${kilo(r.tokens)} tokens`] : []),
      ...(r.currentStep ? [`now: ${clip(r.currentStep, 80)}`] : []),
    ];
    return bits.join(", ");
  }
  const where = (runId: string) => {
    const r = runOf(runId);
    return r ? `${r.providerId}/${r.model}` : "";
  };
  const heading = (j: Job) =>
    `${j.kind === "plan" ? "Plan" : "Task"} ${j.id} "${clip(j.title, 60)}"${j.runIds[0] && j.kind === "task" ? ` (${where(j.runIds[0])})` : ""}`;

  function describe(j: Job, full: boolean): string {
    if (j.state === "running") {
      const lines = [`${heading(j)}: running`];
      if (j.kind === "plan")
        for (const id of j.runIds) {
          const r = runOf(id);
          lines.push(`  - ${clip(r?.title ?? id, 60)} (${where(id)}): ${runLine(id)}`);
        }
      else if (j.runIds.length) lines[0] += ` - ${runLine(j.runIds[j.runIds.length - 1])}`;
      return lines.join("\n");
    }
    const head = `${heading(j)}: ${j.state === "failed" ? "failed" : "finished"} after ${seconds(now() - j.startedAt)}`;
    return full ? `${head}\n${j.report}` : `${head} - ${clip(j.report.split("\n")[0] ?? "", 160)}`;
  }

  /** Waits until all of `list` settled, `ms` passed or the run was stopped. */
  async function settleOrTimeout(list: Job[], ms: number, signal: AbortSignal) {
    let stop: () => void = () => {};
    const aborted = new Promise<void>((r) => {
      stop = r;
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      await Promise.race([Promise.all(list.map((j) => j.settled)), sleep(ms), aborted]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  async function waitText(list: Job[], ms: number, signal: AbortSignal): Promise<string> {
    if (list.some((j) => j.state === "running")) await settleOrTimeout(list, ms, signal);
    const out = list.map((j) => describe(j, j.state !== "running"));
    const open = list.filter((j) => j.state === "running");
    out.push(
      open.length
        ? `Not finished: ${open.map((j) => j.id).join(", ")}. Call \`${AGENT_CLI_NAME} wait ${open.map((j) => j.id).join(" ")}\` again.`
        : list.length > 1
          ? `All ${list.length} finished.`
          : "",
    );
    return out.filter(Boolean).join("\n\n");
  }

  /** Starts a host call in the background and returns its job once the run exists (or the call was refused). */
  async function launch(
    chatId: number,
    turn: AgentTurn,
    kind: Job["kind"],
    title: string,
    start: (parent: RunOptions, hooks: RunHooks) => Promise<string>,
  ): Promise<{ job: Job } | { error: string }> {
    const book = jobsOf(chatId);
    if ([...book.values()].filter((j) => j.state === "running").length >= MAX_ACTIVE_TASKS)
      return {
        error: `Too many unfinished subagents in this chat (${MAX_ACTIVE_TASKS}). Wait for or stop some first.`,
      };
    const n = (counters.get(chatId) ?? 0) + 1;
    counters.set(chatId, n);
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    turn.signal.addEventListener("abort", abort, { once: true });
    if (turn.signal.aborted) ctl.abort();
    let seen!: () => void;
    const gotRun = new Promise<void>((r) => (seen = r));
    const job: Job = {
      id: `${kind === "plan" ? "p" : "t"}${n}`,
      kind,
      title,
      ctl,
      runIds: [],
      state: "running",
      report: "",
      startedAt: now(),
      settled: Promise.resolve(),
    };
    book.set(job.id, job);
    job.settled = start(
      { ...turn.parent, signal: ctl.signal },
      {
        onRun: (id) => {
          job.runIds.push(id);
          seen();
        },
      },
    ).then(
      (report) => {
        job.report = report;
        job.state = "done";
      },
      (e) => {
        job.report = String((e as Error)?.message ?? e);
        job.state = "failed";
      },
    );
    void job.settled.finally(() => {
      turn.signal.removeEventListener("abort", abort);
      seen();
    });
    await Promise.race([gotRun, sleep(START_WINDOW_MS)]);
    if (job.state === "failed" && !job.runIds.length) {
      // Refused before anything started (arguments, provider not allowed, budget): not a task.
      book.delete(job.id);
      return { error: job.report };
    }
    // Keep the book bounded: forget the oldest finished jobs.
    if (book.size > MAX_KEPT_TASKS)
      for (const [id, j] of book) {
        if (book.size <= MAX_KEPT_TASKS) break;
        if (j.state !== "running") book.delete(id);
      }
    return { job };
  }

  async function run(chatId: number, turn: AgentTurn, call: AgentCall): Promise<BridgeReply> {
    const fail = (text: string): BridgeReply => ({ ok: false, text });
    const ok = (text: string): BridgeReply => ({ ok: true, text });
    const book = jobsOf(chatId);
    const known = (id: string) => book.get(id);
    switch (call.op) {
      case "list":
        return ok(renderTargets(await turn.host.targets(turn.parent), call.filter));
      case "spawn": {
        const targets = await turn.host.targets(turn.parent);
        const choice = resolveTarget(call.args as { provider?: string; model?: string; role?: string }, targets);
        if (!choice.ok) return fail(choice.error);
        const args: Record<string, unknown> = { ...call.args };
        if (choice.provider) args.provider = choice.provider;
        if (choice.model) args.model = choice.model;
        // Without a target the subagent runs on the chat's own provider (a CLI agent cannot host the API subagent loop).
        if (!args.provider && !args.role) args.provider = turn.parent.providerId;
        const started = await launch(chatId, turn, "task", String(args.title), (p, hooks) =>
          turn.host.spawn(args, p, hooks),
        );
        if ("error" in started) return fail(started.error);
        const job = started.job;
        const head = `Started task ${job.id} "${clip(job.title, 60)}" on ${where(job.runIds[0]) || "the chosen provider"}; it shows in the Agents panel.`;
        if (call.background) return ok(`${head}\nCall \`${AGENT_CLI_NAME} wait ${job.id}\` to wait for the report.`);
        return ok(`${head}\n\n${await waitText([job], DEFAULT_WAIT_S * 1000, turn.signal)}`);
      }
      case "delegate": {
        // Tasks that name no target run on the chat's own provider, like `spawn`.
        const plan = call.plan && typeof call.plan === "object" ? { ...(call.plan as Record<string, unknown>) } : {};
        if (Array.isArray(plan.tasks)) {
          const targets = await turn.host.targets(turn.parent);
          const tasks: unknown[] = [];
          for (const t of plan.tasks) {
            if (!t || typeof t !== "object") {
              tasks.push(t);
              continue;
            }
            const task = { ...(t as Record<string, unknown>) };
            const choice = resolveTarget(task as { provider?: string; model?: string; role?: string }, targets);
            if (!choice.ok) return fail(`Task "${String(task.id ?? "?").slice(0, 40)}": ${choice.error}`);
            if (choice.provider) task.provider = choice.provider;
            if (choice.model) task.model = choice.model;
            if (!task.provider && !task.role) task.provider = turn.parent.providerId;
            tasks.push(task);
          }
          plan.tasks = tasks;
        }
        const count = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
        const started = await launch(chatId, turn, "plan", `plan of ${count} tasks`, (p, hooks) =>
          turn.host.delegate(plan, p, hooks),
        );
        if ("error" in started) return fail(started.error);
        const job = started.job;
        return ok(
          `Started plan ${job.id} with ${count} tasks; the runs show in the Agents panel.\n\n${await waitText([job], DEFAULT_WAIT_S * 1000, turn.signal)}`,
        );
      }
      case "wait": {
        const list: Job[] = [];
        for (const id of call.ids) {
          const j = known(id);
          if (!j) return fail(`No task "${id}" in this chat. \`${AGENT_CLI_NAME} status\` lists them.`);
          list.push(j);
        }
        return ok(await waitText(list, call.timeoutS * 1000, turn.signal));
      }
      case "status": {
        if (call.id) {
          const j = known(call.id);
          return j ? ok(describe(j, false)) : fail(`No task "${call.id}" in this chat.`);
        }
        const all = [...book.values()];
        return ok(
          all.length ? all.map((j) => describe(j, false)).join("\n") : "No subagents were started in this chat.",
        );
      }
      case "report": {
        const j = known(call.id);
        if (!j) return fail(`No task "${call.id}" in this chat.`);
        return ok(
          j.state === "running"
            ? `${describe(j, false)}\nNot finished: call \`${AGENT_CLI_NAME} wait ${j.id}\`.`
            : describe(j, true),
        );
      }
      case "stop": {
        const j = known(call.id);
        if (!j) return fail(`No task "${call.id}" in this chat.`);
        if (j.state !== "running") return ok(`${heading(j)} had already finished.`);
        j.ctl.abort();
        await Promise.race([j.settled, sleep(STOP_WINDOW_MS)]);
        return ok(j.state === "running" ? `Stopping ${heading(j)}...` : `Stopped.\n${describe(j, true)}`);
      }
    }
  }

  return {
    tokenFor: (chatId: number) => tokens.tokenFor(chatId),
    /** The chat's agent run starts (or continues): requests with its token are served until the returned function runs, which also stops the tasks it started. */
    beginTurn(chatId: number, turn: AgentTurn): () => void {
      turns.set(chatId, turn);
      return () => {
        if (turns.get(chatId) !== turn) return;
        turns.delete(chatId);
        for (const j of jobsOf(chatId).values()) if (j.state === "running") j.ctl.abort();
      };
    },
    async handle(req: BridgeRequest): Promise<BridgeReply> {
      const fail = (text: string): BridgeReply => ({ ok: false, text });
      const chatId = tokens.chatFor(req.token);
      if (chatId === undefined) return fail(`${AGENT_CLI_NAME}: unknown session. Start a new message in Gustaf.`);
      const turn = turns.get(chatId);
      if (!turn || turn.signal.aborted)
        return fail(`${AGENT_CLI_NAME}: no agent run is active in this chat, so the command is not available now.`);
      if (!(await turn.host.cliCommandEnabled()))
        return fail(
          `${AGENT_CLI_NAME}: subagents from CLI agents are off. The user can turn them on in Settings > Usage > Agents.`,
        );
      const parsed = parseAgentArgv(req.argv, req.input);
      if (!parsed.ok) return fail(agentCliErrorText(parsed.error));
      const mutating = parsed.call.op === "spawn" || parsed.call.op === "delegate" || parsed.call.op === "stop";
      const done = mutating ? deps.audit?.(`gustaf-agent ${parsed.call.op}`, summarize(parsed.call)) : undefined;
      try {
        const reply = await run(chatId, turn, parsed.call);
        done?.(reply.ok ? "success" : "error", reply.ok ? undefined : reply.text.slice(0, 300));
        return reply;
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        if (turn.signal.aborted) {
          done?.("cancelled");
          return fail("Stopped by the user.");
        }
        done?.("error", message);
        return fail(`${AGENT_CLI_NAME}: ${message}`);
      }
    },
  };
}

const summarize = (c: AgentCall): string =>
  c.op === "spawn"
    ? clip(
        `${String(c.args.title)} (${String(c.args.provider ?? c.args.role ?? "own provider")}${c.args.model ? `/${String(c.args.model)}` : ""})`,
        120,
      )
    : c.op === "stop"
      ? `stop ${c.id}`
      : "run a plan of subagent tasks";
