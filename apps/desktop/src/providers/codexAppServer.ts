// Codex `app-server` (JSON-RPC over stdio) as the live transport of a Codex chat, instead of `codex exec --json`.
// Pure and Tauri-free (unit-tested with recorded-style fixtures in tests/codexAppServer.test.mjs and
// tests/codexLiveSession.test.mjs); cli.ts supplies the process, codexLive.ts keeps one session per chat.
//
// A session (`createAppServerSession`) is one process with one loaded thread serving many turns: the first turn
// initializes and starts or resumes the thread, later ones only send `turn/start`. Follow-ups are `turn/steer` on the running
// root turn; Stop is `turn/interrupt` on the root turn and on every running child, and the process is stopped only when
// that does not end them within `INTERRUPT_WAIT_MS`.
//
// Modelled on how T3 Code's adapter works (apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts), reduced to what
// this app needs:
//  - every notification of the root thread becomes text / activities / usage / a terminal result;
//  - children are discovered from `collabAgentToolCall` (spawnAgent + receiverThreadIds), `subAgentActivity` and
//    `thread/started` (parentThreadId); their own `turn/*`, `item/*` and token notifications carry only a threadId, so
//    frames that arrive before the child is registered are held (bounded) and replayed on registration;
//  - child status is monotone: a terminal child is only reopened by a new turn of that child (SendMessage / resume), never by
//    a late progress frame; the parent turn ending never completes a child that is still running;
//  - liveness is never guessed: nothing here treats silence as a heartbeat. When the connection or the turn ends with children
//    that never reported an end, `settle` closes them: `stopped` when the owning process is confirmed gone (exit, crash, our own
//    kill after a failed/interrupted/aborted turn), `unknown` when observation merely ran out (the wait limit). Never `completed`,
//    never left `running`.
import { applyActivity, isBareCollabWait, nativeActivities, type Activity } from "./activities.ts";
import { followUpPump, type FollowUpChannel } from "./lifecycle.ts";
import {
  textOf,
  type Msg,
  type NativeGoal,
  type Reasoning,
  type SubagentInfo,
  type SubagentState,
  type TokenUsage,
} from "./types.ts";

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const brief = (v: unknown, n: number) => {
  const s = str(v).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// ---- requests -------------------------------------------------------------------------------------------------------

export type Access = "readonly" | "auto" | "full";
export type Mode = "ask" | "plan" | "agent";

/** Sandbox for a turn: Plan and Ask are read-only whatever the access setting says (same rule as `codexArgs`). */
export function sandboxFor(access: Access | undefined, mode: Mode | undefined) {
  const readonly = access === "readonly" || mode === "plan" || mode === "ask";
  if (readonly) return { mode: "read-only" as const, policy: { type: "readOnly" } };
  if (access === "full") return { mode: "danger-full-access" as const, policy: { type: "dangerFullAccess" } };
  return { mode: "workspace-write" as const, policy: { type: "workspaceWrite" } };
}

export type TurnParams = {
  cwd?: string;
  model?: string;
  session?: string;
  prompt: string;
  images?: string[];
  access?: Access;
  mode?: Mode;
  reasoning?: Reasoning;
  /** The caller can ask the user: workspace-write turns use `on-request` and forward approval requests; otherwise nothing is requested. */
  approvals?: boolean;
  /** Run the prompt as a native thread goal: `thread/goal/set` starts the work and the server continues until the goal leaves `active`. */
  goal?: { objective: string; resume?: boolean };
};

const policyFor = (p: TurnParams) =>
  p.approvals && sandboxFor(p.access, p.mode).mode === "workspace-write" ? "on-request" : "never";

/** `thread/start` or `thread/resume`. Without an approval handler nothing is asked (`exec` never asked either). */
export function threadRequest(p: TurnParams): { method: string; params: Json } {
  const sb = sandboxFor(p.access, p.mode);
  // A goal's turns are started by the server, so the effort (a turn/start parameter) has to travel as thread config.
  const config = p.goal && p.reasoning ? { config: { model_reasoning_effort: p.reasoning } } : {};
  const common = {
    ...(p.cwd ? { cwd: p.cwd } : {}),
    ...(p.model ? { model: p.model } : {}),
    approvalPolicy: policyFor(p),
    sandbox: sb.mode,
    ...config,
  };
  return p.session
    ? { method: "thread/resume", params: { threadId: p.session, ...common } }
    : { method: "thread/start", params: common };
}

export function turnRequest(threadId: string, p: TurnParams): Json {
  const sb = sandboxFor(p.access, p.mode);
  return {
    threadId,
    input: [{ type: "text", text: p.prompt }, ...(p.images ?? []).map((path) => ({ type: "localImage", path }))],
    ...(p.model ? { model: p.model } : {}),
    ...(p.reasoning ? { effort: p.reasoning } : {}),
    approvalPolicy: policyFor(p),
    sandboxPolicy: sb.policy,
  };
}

// ---- items ----------------------------------------------------------------------------------------------------------

const STATUS: Record<string, string> = {
  inprogress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "failed",
};
const status = (v: unknown) => STATUS[str(v).toLowerCase()] ?? str(v);

/** An app-server `ThreadItem` in the shape `nativeActivities("codex", …)` already understands (`codex exec --json` items). */
export function execItem(item: Json): Json {
  switch (str(item.type)) {
    case "commandExecution":
      return {
        type: "command_execution",
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregatedOutput ?? "",
        exit_code: item.exitCode ?? null,
        status: status(item.status),
      };
    case "fileChange":
      return {
        type: "file_change",
        id: item.id,
        changes: list(item.changes).map((c) => ({ path: rec(c).path, kind: rec(c).kind })),
        status: status(item.status),
      };
    case "mcpToolCall":
      return {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result ?? null,
        error: item.error ?? null,
        status: status(item.status),
      };
    case "webSearch":
      return { type: "web_search", id: item.id, query: item.query };
    default:
      return item;
  }
}

const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"]);
const stepOf = (item: Json) =>
  brief(
    item.type === "commandExecution"
      ? str(item.command)
      : item.type === "mcpToolCall"
        ? `${str(item.server)} ${str(item.tool)}`
        : item.type === "webSearch"
          ? `search ${str(item.query)}`
          : str(item.type),
    90,
  );

// ---- reducer --------------------------------------------------------------------------------------------------------

export type Reply = { id: string | number; result?: unknown; error?: { code: number; message: string } };
export type Effect =
  | { kind: "text"; text: string }
  | { kind: "activity"; activity: Activity }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "goal"; goal: NativeGoal }
  /** Goal mode: a root turn ended but the goal is still active (more turns may follow) / the next root turn began. */
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "reply"; reply: Reply }
  | { kind: "approval"; id: string | number; ask: { kind: "command"; command: string; reason?: string } }
  | { kind: "done"; status: "completed" | "interrupted" | "failed"; error?: string };

const MAX_HELD_PER_THREAD = 100;
const MAX_HELD_THREADS = 50;
const HELD = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "thread/tokenUsage/updated",
  "thread/status/changed",
  "thread/closed",
]);

type Child = {
  activityId: string;
  state: SubagentState;
  lastText: string;
  tokens?: number;
  /** The child's own running turn (from its `turn/started`), the target of `turn/interrupt` on Stop. */
  turnId?: string;
};

/** "/root/list_files" to "list files": the last segment of an agent path, readable. */
const humanTask = (path: string) => (path.split("/").filter(Boolean).pop() ?? "").replace(/[_-]+/g, " ").trim();

const childState = (s: unknown): SubagentState =>
  s === "completed" ? "completed" : s === "interrupted" ? "stopped" : "failed";

/**
 * State machine of one loaded thread (a live session keeps one across turns, so children spawned by an earlier turn stay
 * known). Feed it every JSON-RPC message of the connection; apply the returned effects in order. `beginTurn` resets what
 * belongs to one turn (text separation, usage baseline, goal mode).
 */
export function createReducer(rootThreadId: string, o: { goal?: boolean } = {}) {
  let goal = !!o.goal;
  let goalStatus = "";
  let turnEnded = false;
  const children = new Map<string, Child>();
  const held = new Map<string, Json[]>();
  const hints = new Map<string, { model?: string; role?: string; nickname?: string }>();
  const streamed = new Set<string>();
  let lastMessage = "";
  /** Separate agent messages of one turn (before and after tool calls) read as paragraphs, not one run-on sentence. */
  const gap = (id: string) => {
    const sep = lastMessage && lastMessage !== id ? "\n\n" : "";
    lastMessage = id;
    return sep;
  };
  let baseline: TokenUsage | undefined;
  let latest: { total: TokenUsage; last: TokenUsage } | undefined;
  let usageSeen = 0;

  const info = (
    threadId: string,
    c: Child,
    patch: Partial<SubagentInfo> & Pick<SubagentInfo, "action" | "state">,
  ): Activity => ({
    type: "activity",
    id: c.activityId,
    name: "",
    args: {},
    status: "running",
    subagent: { provider: "codex", agentId: threadId, title: "", ...patch },
  });

  /** Registers every codex subagent entry an activity names, then replays what was held for it. */
  const register = (acts: Activity[], out: Effect[]) => {
    for (const a of acts) {
      const s = a.subagent;
      if (!s || s.provider !== "codex" || !s.agentId || children.has(s.agentId)) continue;
      children.set(s.agentId, { activityId: a.id, state: s.state, lastText: "" });
      const h = hints.get(s.agentId);
      if (h?.model && !s.model) s.model = h.model;
      if (h?.role && !s.role) s.role = h.role;
      for (const m of held.get(s.agentId) ?? []) out.push(...child(s.agentId, m));
      held.delete(s.agentId);
    }
  };

  const publish = (acts: Activity[], out: Effect[]) => {
    register(acts, out);
    for (const activity of acts) out.push({ kind: "activity", activity });
  };

  /** One message from a thread that is not the root. */
  function child(threadId: string, m: Json): Effect[] {
    const c = children.get(threadId);
    const method = str(m.method);
    const p = rec(m.params);
    if (!c) {
      if (!HELD.has(method)) return [];
      if (!held.has(threadId) && held.size >= MAX_HELD_THREADS) return [];
      const q = held.get(threadId) ?? [];
      if (q.length < MAX_HELD_PER_THREAD) q.push(m);
      held.set(threadId, q);
      return [];
    }
    const out: Effect[] = [];
    const push = (a: Activity) => out.push({ kind: "activity", activity: a });
    switch (method) {
      case "turn/started": {
        // A new turn of a finished child is a resume (SendMessage): the one thing allowed to reopen a terminal entry.
        const reopen = c.state !== "running" && c.state !== "waiting";
        c.state = "running";
        c.turnId = str(rec(p.turn).id) || undefined;
        push(info(threadId, c, { action: reopen ? "send" : "progress", state: "running", startedAt: Date.now() }));
        break;
      }
      case "turn/completed": {
        const turn = rec(p.turn);
        const state = childState(turn.status);
        c.state = state;
        c.turnId = undefined;
        const result = c.lastText
          ? brief(c.lastText, 300)
          : str(rec(turn.error).message)
            ? brief(rec(turn.error).message, 300)
            : undefined;
        push({
          ...info(threadId, c, {
            action: "close",
            state,
            ...(result ? { result } : {}),
            ...(c.tokens ? { tokens: c.tokens } : {}),
            ...(num(turn.durationMs) !== undefined ? { durationMs: num(turn.durationMs) } : {}),
          }),
          status: state === "completed" ? "success" : state === "failed" ? "error" : "unknown",
          ...(c.lastText ? { output: c.lastText.slice(0, 4000) } : {}),
        });
        break;
      }
      case "item/started": {
        const item = rec(p.item);
        if (TOOL_ITEMS.has(str(item.type)))
          push(info(threadId, c, { action: "progress", state: c.state, toolUses: 1, step: stepOf(item) }));
        break;
      }
      case "item/completed": {
        const item = rec(p.item);
        if (item.type === "agentMessage" && str(item.text)) c.lastText = str(item.text);
        break;
      }
      case "thread/tokenUsage/updated": {
        const total = num(rec(rec(p.tokenUsage).total).totalTokens);
        if (total !== undefined) {
          c.tokens = total;
          push(info(threadId, c, { action: "progress", state: c.state, tokens: total }));
        }
        break;
      }
      case "thread/closed":
        // The server unloaded the thread: a child that never reported an end is not running any more.
        if (c.state === "running" || c.state === "waiting") {
          c.state = "stopped";
          push({
            ...info(threadId, c, { action: "close", state: "stopped", result: "Agent thread closed" }),
            status: "unknown",
          });
        }
        break;
      case "thread/status/changed":
        if (rec(p.status).type === "systemError" && c.state === "running") {
          c.state = "failed";
          push({
            ...info(threadId, c, { action: "close", state: "failed", result: "Agent failed (system error)" }),
            status: "error",
          });
        }
        break;
    }
    return out;
  }

  /**
   * Codex 0.160 announces a spawned agent with `subAgentActivity` (kind started + agentThreadId + agentPath), not with a
   * `collabAgentToolCall`; the child's own frames follow under that thread id. The item arrives twice (started, completed).
   */
  function subAgentActivity(item: Json, first: boolean, out: Effect[]) {
    const threadId = str(item.agentThreadId);
    if (!threadId) return;
    const kind = str(item.kind);
    const known = children.get(threadId);
    if (kind === "started") {
      if (known || !first) return;
      const h = hints.get(threadId);
      const path = str(item.agentPath);
      publish(
        [
          {
            type: "activity",
            id: str(item.id) || `agent:${threadId}`,
            name: "subagent",
            args: { tool: "spawnAgent", agent: threadId },
            status: "running",
            subagent: {
              provider: "codex",
              agentId: threadId,
              ...(path ? { agentPath: path } : {}),
              title: humanTask(path) || h?.nickname || "",
              action: "spawn",
              state: "running",
              startedAt: Date.now(),
              ...(h?.model ? { model: h.model } : {}),
              ...(h?.role ? { role: h.role } : {}),
            },
          },
        ],
        out,
      );
      return;
    }
    if (!known) return;
    if (kind === "interacted") {
      if (first) return;
      const reopen = known.state !== "running" && known.state !== "waiting";
      known.state = "running";
      out.push({
        kind: "activity",
        activity: info(threadId, known, { action: reopen ? "send" : "progress", state: "running" }),
      });
    } else if ((kind === "completed" || kind === "interrupted") && !first) {
      const state: SubagentState = kind === "completed" ? "completed" : "stopped";
      if (known.state === "completed" || known.state === "failed") return;
      known.state = state;
      out.push({
        kind: "activity",
        activity: {
          ...info(threadId, known, {
            action: "close",
            state,
            ...(known.lastText ? { result: brief(known.lastText, 300) } : {}),
          }),
          status: state === "completed" ? "success" : "unknown",
        },
      });
    }
  }

  /** The turn's own text and tool items. */
  function root(m: Json): Effect[] {
    const method = str(m.method);
    const p = rec(m.params);
    const out: Effect[] = [];
    if (method === "item/agentMessage/delta") {
      const first = !streamed.has(str(p.itemId));
      streamed.add(str(p.itemId));
      if (str(p.delta)) out.push({ kind: "text", text: (first ? gap(str(p.itemId)) : "") + str(p.delta) });
    } else if (method === "item/started" || method === "item/completed") {
      const item = rec(p.item);
      const type = str(item.type);
      const evType = method === "item/started" ? "item.started" : "item.completed";
      if (type === "agentMessage") {
        // A message that never streamed deltas (short or replayed) arrives whole.
        if (evType === "item.completed" && str(item.text) && !streamed.has(str(item.id)))
          out.push({ kind: "text", text: gap(str(item.id)) + str(item.text) });
      } else if (
        type === "collabAgentToolCall" &&
        str(item.tool) === "spawnAgent" &&
        list(item.receiverThreadIds).length > 1
      ) {
        // One entry per spawned agent (the shared mapping keys a spawn by its first receiver only).
        const ids = list(item.receiverThreadIds).map(str);
        const states = rec(item.agentsStates);
        for (const id of ids)
          publish(
            nativeActivities("codex", {
              type: evType,
              item: {
                ...item,
                id: `${str(item.id)}:${id}`,
                receiverThreadIds: [id],
                agentsStates: id in states ? { [id]: states[id] } : {},
              },
            }),
            out,
          );
      } else if (type === "subAgentActivity") {
        subAgentActivity(item, evType === "item.started", out);
      } else if (type === "collabAgentToolCall" && isBareCollabWait({ type: evType, item })) {
        // A `wait` that names no agent says nothing the agents' own entries do not (Codex 0.160 emits only these).
      } else if (type !== "reasoning" && type !== "userMessage" && type !== "plan" && type !== "hookPrompt") {
        const model = type === "collabAgentToolCall" ? str(item.model) : "";
        const acts = nativeActivities("codex", { type: evType, item: execItem(item) });
        if (model) for (const a of acts) if (a.subagent && !a.subagent.model) a.subagent.model = model;
        publish(acts, out);
      }
    } else if (method === "thread/tokenUsage/updated") {
      const u = rec(p.tokenUsage);
      const total = usageOf(rec(u.total));
      const last = usageOf(rec(u.last));
      if (total && last) {
        latest = { total, last };
        if (!baseline) baseline = sub(total, last);
        usageSeen++;
      }
    } else if (method === "turn/started") {
      turnEnded = false;
      if (goal) out.push({ kind: "busy" });
    } else if (method === "thread/goal/updated") {
      const g = rec(p.goal);
      goalStatus = str(g.status);
      out.push({
        kind: "goal",
        goal: {
          status: (goalStatus || "active") as NativeGoal["status"],
          objective: str(g.objective),
          tokensUsed: num(g.tokensUsed) ?? 0,
          timeUsedSeconds: num(g.timeUsedSeconds) ?? 0,
        },
      });
      // The goal finished after the last turn already ended: nothing more will come.
      if (goal && goalStatus !== "active" && turnEnded) out.push({ kind: "done", status: "completed" });
    } else if (method === "turn/completed") {
      const turn = rec(p.turn);
      const s = str(turn.status);
      const e = rec(turn.error);
      turnEnded = true;
      // A goal run continues in further server-started turns while the goal is active.
      if (goal && s === "completed" && (goalStatus === "active" || goalStatus === "")) out.push({ kind: "idle" });
      else
        out.push({
          kind: "done",
          status: s === "interrupted" ? "interrupted" : s === "failed" ? "failed" : "completed",
          ...(str(e.message) ? { error: str(e.message) } : {}),
        });
    } else if (method === "error") {
      const e = rec(p.error);
      if (p.willRetry !== true && str(e.message)) out.push({ kind: "done", status: "failed", error: str(e.message) });
    }
    return out;
  }

  const serverRequest = (m: Json): Effect[] => {
    const method = str(m.method);
    const id = m.id as string | number;
    const p = rec(m.params);
    // The runner asks the user (or declines when it has no handler); the reply is one of the decisions below.
    if (method === "item/commandExecution/requestApproval")
      return [
        {
          kind: "approval",
          id,
          ask: {
            kind: "command",
            command: str(p.command) || "(command)",
            ...(str(p.reason) ? { reason: str(p.reason) } : {}),
          },
        },
      ];
    if (method === "item/fileChange/requestApproval")
      return [
        {
          kind: "approval",
          id,
          ask: {
            kind: "command",
            command: "Apply file changes outside the workspace",
            reason:
              str(p.reason) ||
              (str(p.grantRoot) ? `Write access to ${str(p.grantRoot)}` : "Codex asks to change files"),
          },
        },
      ];
    if (method === "mcpServer/elicitation/request")
      return [{ kind: "reply", reply: { id, result: { action: "decline" } } }];
    return [
      { kind: "reply", reply: { id, error: { code: -32601, message: `Not supported by this client: ${method}` } } },
    ];
  };

  /** History item of a resumed thread: registers the children it names, publishing nothing. */
  function seedItem(item: Json) {
    const sink: Effect[] = [];
    const type = str(item.type);
    if (type === "subAgentActivity") subAgentActivity(item, true, sink);
    else if (
      type === "collabAgentToolCall" &&
      str(item.tool) === "spawnAgent" &&
      list(item.receiverThreadIds).length > 1
    )
      root({ method: "item/completed", params: { threadId: rootThreadId, item } });
    else if (type === "collabAgentToolCall")
      register(nativeActivities("codex", { type: "item.completed", item: execItem(item) }), sink);
  }

  return {
    /** A new turn on this thread: per-turn state is reset, children (and what is known about them) are kept. */
    beginTurn(t: { goal?: boolean } = {}) {
      goal = !!t.goal;
      goalStatus = "";
      turnEnded = false;
      streamed.clear();
      lastMessage = "";
      baseline = undefined;
      latest = undefined;
      usageSeen = 0;
    },
    /**
     * The thread was resumed in a fresh process (`thread/resume` returns its turns): children named in the history become
     * known again, so their frames are no longer held as strangers when the parent talks to them (SendMessage / resume).
     * The process that ran them is gone, so any that never reported an end are `stopped`. Nothing is published.
     */
    seed(turns: unknown) {
      for (const t of list(turns)) for (const it of list(rec(t).items)) seedItem(rec(it));
      for (const c of children.values()) if (c.state === "running" || c.state === "waiting") c.state = "stopped";
      held.clear();
    },
    /** Running children with a known turn id: what a Stop interrupts besides the root turn. */
    activeChildTurns(): { threadId: string; turnId: string }[] {
      return [...children]
        .filter(([, c]) => (c.state === "running" || c.state === "waiting") && c.turnId)
        .map(([threadId, c]) => ({ threadId, turnId: c.turnId! }));
    },
    /** Children whose end is not known: still running, or given up on (`unknown`) while their process lives on. */
    unresolved(): string[] {
      return [...children]
        .filter(([, c]) => c.state === "running" || c.state === "waiting" || c.state === "unknown")
        .map(([id]) => id);
    },
    /** Processes one message (not a response to our own request). */
    onMessage(m: Json): Effect[] {
      const method = str(m.method);
      if (!method) return [];
      if (m.id !== undefined && m.id !== null) return serverRequest(m);
      const p = rec(m.params);
      if (method === "thread/started") {
        const t = rec(p.thread);
        const id = str(t.id);
        if (id && id !== rootThreadId)
          hints.set(id, {
            model: str(t.model) || undefined,
            role: str(t.agentRole) || undefined,
            nickname: str(t.agentNickname) || undefined,
          });
        return [];
      }
      const threadId = str(p.threadId);
      if (!threadId || threadId === rootThreadId) return root(m);
      return child(threadId, m);
    },
    /** Usage of this turn: the thread's cumulative total now, minus what it was before the turn's first model call. */
    usage(): TokenUsage | undefined {
      return latest && baseline && usageSeen ? sub(latest.total, baseline) : undefined;
    },
    /**
     * The connection or turn is over and these children never reported an end: closes each with `state` (see the header) and
     * returns the entries to publish. `stopped`: the process that owned them is confirmed gone. `unknown`: we only stopped
     * observing. Terminal children are untouched.
     */
    settle(state: "stopped" | "unknown", note: string): Effect[] {
      const out: Effect[] = [];
      for (const [threadId, c] of children) {
        if (c.state !== "running" && c.state !== "waiting") continue;
        c.state = state;
        out.push({
          kind: "activity",
          activity: {
            ...info(threadId, c, {
              action: "close",
              state,
              result: c.lastText ? brief(c.lastText, 300) : note,
              ...(c.tokens ? { tokens: c.tokens } : {}),
            }),
            status: "unknown",
          },
        });
      }
      return out;
    },
    /** Children still running (those the caller has not settled yet). */
    running(): string[] {
      return [...children].filter(([, c]) => c.state === "running" || c.state === "waiting").map(([id]) => id);
    },
    /** Test hook. */
    get held() {
      return held.size;
    },
  };
}

function usageOf(b: Json): TokenUsage | undefined {
  const input = num(b.inputTokens);
  const output = num(b.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cached: num(b.cachedInputTokens) ?? 0,
    cacheWrite: num(b.cacheWriteInputTokens) ?? 0,
    reasoning: num(b.reasoningOutputTokens) ?? 0,
  };
}
const sub = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cached: Math.max(0, a.cached - b.cached),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  reasoning: Math.max(0, a.reasoning - b.reasoning),
});

// ---- a live session over a transport --------------------------------------------------------------------------------

export type Connection = {
  /** Writes one JSON line to the process. */
  write(line: string): Promise<void>;
  /** Subscribes to parsed stdout lines. */
  onMessage(cb: (m: Json) => void): void;
  /** Resolves when the process exits (exit code). */
  closed: Promise<number | null>;
  kill(): void;
  stderr(): string;
};

export type TurnHandlers = {
  signal?: AbortSignal;
  onText(s: string): void;
  onActivity(a: Activity): void;
  onUsage?(u: TokenUsage): void;
  onDebug?(note: string): void;
  /** Answers an approval request (true: allow once). Absent: declined. */
  onApproval?(ask: { kind: "command"; command: string; reason?: string }): Promise<boolean>;
  /** Goal updates (`thread/goal/updated`), in order. */
  onGoal?(g: NativeGoal): void;
  /** Messages sent while the turn runs: steered into the running root turn (`turn/steer`). */
  followUp?: FollowUpChannel;
  /** Goal run: how long an idle thread with a still-active goal is waited on before the turn ends (default `GOAL_IDLE_MS`). */
  goalIdleMs?: number;
  /** How long to keep the turn open for children still running after the parent turn completed (default `CHILD_WAIT_MS`). */
  childWaitMs?: number;
  /** Stop: how long `turn/interrupt` may take before the process is stopped instead (default `INTERRUPT_WAIT_MS`). */
  interruptWaitMs?: number;
};

/**
 * `unreported`: children that never reported an end and were settled (`stopped` or `unknown`) when the turn ended.
 * `background`: children left running because the turn ended early for a waiting follow-up; the live session keeps
 * following them and the next turn shows their updates.
 */
export type TurnResult = {
  session: string;
  error: string;
  unreported: string[];
  background: string[];
  usage?: TokenUsage;
};

/**
 * The app-server could not be started or spoken to before the turn was accepted (nothing ran, nothing streamed): the
 * caller may fall back to `exec`. After `turn/start` (or `thread/goal/set`) was accepted, failures are plain errors.
 */
export class AppServerUnavailable extends Error {}
/** The process exited while a request waited for its answer. */
class Gone extends Error {}

const REQUEST_TIMEOUT_MS = 20_000;
/**
 * A parent turn can complete while its background children still work. The turn stays open (the chat card follows them and
 * Stop interrupts them) until they all report an end, the process exits, a follow-up message waits (the turn then ends and
 * the live session keeps following the children into the next turn), or this long passes. Hitting the limit is not a
 * verdict about the children: they are shown as unknown and the session stays pinned while they may still run.
 */
export const CHILD_WAIT_MS = 15 * 60_000;
/** An active goal whose thread went idle and stayed idle: the server is not continuing (waiting for the user, or stuck). */
export const GOAL_IDLE_MS = 30_000;
/** Stop: `turn/interrupt` normally completes the turn within milliseconds (codex-cli 0.160); past this the process goes. */
export const INTERRUPT_WAIT_MS = 5_000;

export type AppServerSession = {
  /** The loaded native thread (undefined before the first turn). */
  readonly threadId: string | undefined;
  /** False once the process is gone or the session was given up (failed start, interrupt timeout). */
  alive(): boolean;
  /** Children of earlier turns whose end is not known yet while the process lives (keeps the session pinned). */
  backgroundWork(): boolean;
  release(reason?: string): Promise<void>;
  /** One turn: the first one initializes and starts or resumes the thread, later ones only `turn/start`. */
  turn(p: TurnParams, h: TurnHandlers): Promise<TurnResult>;
};

type End = { status: string; error?: string };
const aborted = () => new DOMException("Aborted", "AbortError");

/** Text and images of follow-up messages as `turn/steer` input. */
function steerInput(msgs: Msg[]): Json[] {
  const text = msgs.map(textOf).filter(Boolean).join("\n\n");
  const images = msgs.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "image" && p.data.startsWith("data:") ? [{ type: "image", url: p.data }] : [])),
  );
  return [...(text ? [{ type: "text", text }] : []), ...images];
}

/**
 * One `codex app-server` process with one loaded thread, serving turn after turn (kept by `sessionManager.liveSessions`).
 * Requests and notifications are routed here for the whole life of the process; the reducer is per session, so children of
 * an earlier turn stay known. Between turns their updates are folded into `cards` and handed to the next turn.
 */
export function createAppServerSession(conn: Connection): AppServerSession {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let gone = false;
  let broken = false;
  let busy = false;
  const exit = conn.closed.then((code) => {
    gone = true;
    for (const w of pending.values()) w.reject(new Gone(stderrOr(`codex app-server exited`)));
    pending.clear();
    return code;
  });
  const stderrOr = (fallback: string) => conn.stderr().trim().slice(-400) || fallback;
  let ready: Promise<unknown> | undefined;
  let threadId: string | undefined;
  let reducer: ReturnType<typeof createReducer> | undefined;
  /** The root turn in progress (from the turn/start answer or turn/started), cleared by its turn/completed. */
  let rootTurn: string | undefined;
  let lastRootDone = "";
  const early: Json[] = [];
  /** Every subagent card of the session, folded; the base a later turn needs to show an update of an earlier child. */
  const cards = new Map<string, Activity>();
  /** Cards that changed while no turn ran. */
  const dirty = new Set<string>();
  /** Where effects go: the running turn, or `idle` between turns. */
  let sink: ((effects: Effect[]) => void) | undefined;

  const send = (m: Json) => void conn.write(JSON.stringify({ jsonrpc: "2.0", ...m })).catch(() => {});
  const fold = (a: Activity) => {
    if (a.subagent) applyActivity(cards, a);
  };
  const idle = (effects: Effect[]) => {
    for (const e of effects) {
      if (e.kind === "activity" && e.activity.subagent) {
        fold(e.activity);
        dirty.add(e.activity.id);
      } else if (e.kind === "approval") send({ id: e.id, result: { decision: "decline" } });
      else if (e.kind === "reply") send(e.reply);
    }
  };

  conn.onMessage((m) => {
    if (m.id !== undefined && m.id !== null && !m.method) {
      const w = pending.get(m.id as number);
      if (!w) return;
      pending.delete(m.id as number);
      if (m.error) w.reject(new Error(str(rec(m.error).message) || "app-server error"));
      else w.resolve(rec(m.result));
      return;
    }
    const p = rec(m.params);
    if (threadId && str(p.threadId) === threadId) {
      const id = str(rec(p.turn).id);
      if (m.method === "turn/started" && id) rootTurn = id;
      else if (m.method === "turn/completed") {
        lastRootDone = id;
        if (!id || id === rootTurn) rootTurn = undefined;
      }
    }
    if (!reducer) {
      if (early.length < 500) early.push(m);
      return;
    }
    (sink ?? idle)(reducer.onMessage(m));
  });

  const request = (method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> => {
    if (gone) return Promise.reject(new Gone(stderrOr("codex app-server exited")));
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Json>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`app-server did not answer ${method}`));
      }, timeoutMs);
    }).finally(() => clearTimeout(timer));
    send({ id, method, params });
    return reply;
  };

  const session: AppServerSession = {
    get threadId() {
      return threadId;
    },
    alive: () => !gone && !broken,
    backgroundWork: () => !gone && !broken && !busy && !!reducer?.unresolved().length,
    async release() {
      broken = true;
      conn.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exit, new Promise((r) => (timer = setTimeout(r, 3000)))]);
      clearTimeout(timer);
    },
    async turn(p, h) {
      if (busy) throw new Error("This Codex session is already running a turn");
      busy = true;
      const seen = new Set<string>();
      let finish: (r: End) => void = () => {};
      const finished = new Promise<End>((resolve) => {
        finish = resolve;
      });
      let rootDone = false;
      /** Wakes the waits below: a batch of effects was applied (children may have ended, the root turn may be over). */
      let changed: (() => void) | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let followUpWaits: (() => void) | undefined;
      let followUpWaiting = false;
      let closePump: () => Promise<void> = async () => {};
      let abortListener: (() => void) | undefined;
      const abort = new Promise<"abort">((resolve) => {
        if (h.signal?.aborted) return resolve("abort");
        abortListener = () => resolve("abort");
        h.signal?.addEventListener("abort", abortListener, { once: true });
      });

      const emit = (a: Activity) => {
        // The first update this turn of a card from an earlier turn: its folded state goes first, so the card is whole.
        if (!seen.has(a.id)) {
          seen.add(a.id);
          const base = cards.get(a.id);
          if (base && a.subagent) h.onActivity(base);
        }
        fold(a);
        h.onActivity(a);
      };
      const apply = (effects: Effect[]) => {
        for (const e of effects) {
          if (e.kind === "text") h.onText(e.text);
          else if (e.kind === "activity") emit(e.activity);
          else if (e.kind === "usage") h.onUsage?.(e.usage);
          else if (e.kind === "goal") h.onGoal?.(e.goal);
          else if (e.kind === "busy") {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          } else if (e.kind === "idle") {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finishRoot({ status: "completed" }), h.goalIdleMs ?? GOAL_IDLE_MS);
          } else if (e.kind === "approval") {
            const answer = (ok: boolean) => send({ id: e.id, result: { decision: ok ? "accept" : "decline" } });
            if (!h.onApproval) answer(false);
            else h.onApproval(e.ask).then(answer, () => answer(false));
          } else if (e.kind === "reply") send(e.reply);
          else if (e.kind === "done") finishRoot({ status: e.status, error: e.error });
        }
        changed?.();
      };
      const finishRoot = (r: End) => {
        rootDone = true;
        finish(r);
      };
      /**
       * Waits until `ok()` holds (checked after every applied batch): "ok", or "timeout" after `ms`, "exit" when the process
       * exits, or whatever `cut` resolves with first.
       */
      const until = (ok: () => boolean, ms: number, cut?: Promise<string>) =>
        new Promise<string>((resolve) => {
          if (ok()) return resolve("ok");
          let over = false;
          const done = (v: string) => {
            if (over) return;
            over = true;
            clearTimeout(timer);
            changed = undefined;
            resolve(v);
          };
          const timer = setTimeout(() => done("timeout"), ms);
          changed = () => {
            if (ok()) done("ok");
          };
          void exit.then(() => done("exit"));
          void cut?.then(done);
        });

      /**
       * Interrupts the root turn (if one runs) and every running child (T3 interrupts the whole lineage). True when all of them
       * ended in time; otherwise the process is stopped (the session is broken), so what was running is confirmed gone.
       */
      const interruptAll = async (): Promise<boolean> => {
        const rd = reducer!;
        if (gone) return false;
        const children = rd.activeChildTurns();
        // A child whose turn id never arrived cannot be interrupted: only stopping the process ends it.
        const unreachable = rd.running().length > children.length;
        const targets = [...(rootTurn ? [{ threadId: threadId!, turnId: rootTurn }] : []), ...children];
        for (const t of targets) void request("turn/interrupt", t).catch(() => {});
        const quiet =
          !unreachable &&
          (await until(() => !rootTurn && rd.running().length === 0, h.interruptWaitMs ?? INTERRUPT_WAIT_MS)) === "ok";
        if (!quiet) {
          h.onDebug?.("codex app-server: the interrupt did not end the work in time, stopping the process");
          broken = true;
          conn.kill();
        }
        return quiet;
      };

      /** Stop: interrupt first; the session stays usable when everything ended in time. */
      const halt = async (): Promise<never> => {
        const rd = reducer!;
        // A goal would start the next turn by itself: pause it (`/goal resume` re-activates it).
        if (p.goal && !gone) void request("thread/goal/set", { threadId, status: "paused" }).catch(() => {});
        await interruptAll();
        apply(rd.settle("stopped", "Stopped with the Codex run"));
        const usage = rd.usage();
        if (usage) h.onUsage?.(usage);
        throw aborted();
      };

      /** Before the turn is accepted a Stop needs no interrupt: the connection is given up (nothing ran on it yet). */
      const orAbort = <T>(work: Promise<T>) => {
        let over = false;
        return Promise.race([
          work.finally(() => {
            over = true;
          }),
          abort.then((): never => {
            if (!over) {
              broken = true;
              conn.kill();
            }
            throw aborted();
          }),
        ]);
      };

      try {
        if (h.signal?.aborted) throw aborted();
        if (gone || broken) throw new AppServerUnavailable(stderrOr("codex app-server exited"));
        // 1. Connect: once per process.
        try {
          await orAbort(
            (ready ??= request("initialize", {
              clientInfo: { name: "gustaf", title: "Gustaf", version: "0.1.0" },
            }).then(() => send({ method: "initialized" }))),
          );
        } catch (e) {
          broken = true;
          if (h.signal?.aborted) throw aborted();
          throw new AppServerUnavailable(e instanceof Error ? e.message : String(e));
        }
        // 2. The thread: started or resumed once per process; later turns run on the loaded thread.
        if (!threadId) {
          const t = threadRequest(p);
          let res: Json;
          try {
            res = await orAbort(request(t.method, t.params));
          } catch (e) {
            if (h.signal?.aborted) throw aborted();
            if (e instanceof Gone) throw new AppServerUnavailable(e.message);
            throw e;
          }
          const thread = rec(res.thread);
          const id = str(thread.id);
          if (!id) throw new Error("app-server returned no thread id");
          threadId = id;
          reducer = createReducer(id);
          // A fresh process on an old thread: children named in its history are known again (their frames are not strangers).
          if (p.session) reducer.seed(thread.turns);
        } else if (p.session && p.session !== threadId) {
          throw new Error("This Codex session holds another thread");
        }
        const rd = reducer!;
        rd.beginTurn({ goal: !!p.goal });
        sink = apply;
        for (const m of early.splice(0)) apply(rd.onMessage(m));
        // Earlier children that changed between turns: their cards come back with this turn.
        for (const id of dirty) {
          const card = cards.get(id);
          if (card) {
            seen.add(id);
            h.onActivity(card);
          }
        }
        dirty.clear();
        if (h.signal?.aborted) throw aborted();

        // 3. Start the turn (or the goal run). Accepted means the agent may act: no `exec` fallback from here on.
        let started: Json;
        try {
          started = p.goal
            ? await request("thread/goal/set", {
                threadId,
                ...(p.goal.resume ? { status: "active" } : { objective: p.goal.objective }),
              })
            : await request("turn/start", turnRequest(threadId, p));
        } catch (e) {
          if (e instanceof Gone) throw new AppServerUnavailable(e.message);
          if (/did not answer/.test(String((e as Error)?.message))) broken = true;
          if (h.signal?.aborted) throw aborted();
          throw e;
        }
        const tid = str(rec(started.turn).id);
        if (tid && tid !== lastRootDone) rootTurn = tid;

        // 4. Follow-ups go into the running root turn; once it is over they wait for the next turn (and end the child wait).
        closePump = followUpPump(h.followUp, async (msgs) => {
          const turnId = rootTurn;
          if (!rootDone && turnId && !gone) {
            const input = steerInput(msgs);
            if (!input.length) return true;
            try {
              await request("turn/steer", { threadId, expectedTurnId: turnId, input });
              return true;
            } catch (e) {
              h.onDebug?.(`codex turn/steer rejected: ${(e as Error)?.message ?? e}`);
            }
          }
          followUpWaiting = true;
          followUpWaits?.();
          return false;
        });

        const end = await Promise.race([
          finished,
          abort,
          exit.then((code): End => ({
            status: "lost",
            error: conn.stderr().trim().slice(-600) || `codex app-server exited${code == null ? "" : ` with ${code}`}`,
          })),
        ]);
        if (end === "abort") return await halt();
        let verdict: { state: "stopped" | "unknown"; note: string } = {
          state: "stopped",
          note: "Agent did not report a result before the Codex run ended",
        };
        if (end.status === "lost")
          verdict = { state: "stopped", note: "Codex process exited before the agent reported a result" };
        let background: string[] = [];
        // 5. Children still running after a completed parent turn: follow them while the turn stays open.
        if (end.status === "completed" && rd.running().length && !followUpWaiting) {
          const cut = new Promise<string>((resolve) => {
            followUpWaits = () => resolve("followUp");
            void abort.then(resolve);
          });
          const how = await until(() => rd.running().length === 0, h.childWaitMs ?? CHILD_WAIT_MS, cut).finally(() => {
            followUpWaits = undefined;
          });
          if (how === "abort") return await halt();
          if (how === "timeout")
            verdict = { state: "unknown", note: "Lost track of this agent: no report within the wait limit" };
          else if (how === "exit")
            verdict = { state: "stopped", note: "Codex process exited before the agent reported a result" };
          else if (how === "followUp") background = rd.running();
        } else if (end.status === "completed" && followUpWaiting) background = rd.running();
        else if (end.status !== "completed" && rd.running().length) {
          // The parent turn failed or was interrupted: its children are interrupted too (or the process goes), so "stopped" is true.
          await interruptAll();
        }
        // Whatever never reported an end is closed now (never left `running`, never called completed), unless the live
        // session goes on following it (`background`).
        const unreported = background.length ? [] : rd.running();
        if (!background.length) apply(rd.settle(verdict.state, verdict.note));
        const usage = rd.usage();
        if (usage) h.onUsage?.(usage);
        const error =
          end.status === "completed" || end.status === "interrupted" ? "" : end.error || "Codex turn failed";
        if (end.status === "lost") broken = true;
        return { session: threadId, error, unreported, background, usage };
      } finally {
        clearTimeout(idleTimer);
        changed = undefined;
        if (abortListener) h.signal?.removeEventListener("abort", abortListener);
        await closePump();
        sink = undefined;
        busy = false;
      }
    },
  };
  return session;
}

/**
 * One turn on a connection that is closed afterwards (tests, callers without a chat to keep a session for). Rejects with
 * AbortError when the signal aborts.
 */
export async function runAppServerTurn(conn: Connection, p: TurnParams, h: TurnHandlers): Promise<TurnResult> {
  try {
    return await createAppServerSession(conn).turn(p, h);
  } finally {
    conn.kill();
  }
}
