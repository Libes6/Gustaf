// Codex `app-server` (JSON-RPC over stdio) as the live transport of a Codex turn, instead of `codex exec --json`.
// Pure and Tauri-free (unit-tested with recorded-style fixtures in tests/codexAppServer.test.mjs); cli.ts supplies the process.
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
//    still running, they are left "running" and the caller marks them unknown (cli.ts), not completed.
import { isBareCollabWait, nativeActivities, type Activity } from "./activities.ts";
import type { Reasoning, SubagentInfo, SubagentState, TokenUsage } from "./types.ts";

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
};

/** `thread/start` or `thread/resume`. Approvals are never requested: the app has no approval card for Codex yet (`exec` never asked either). */
export function threadRequest(p: TurnParams): { method: string; params: Json } {
  const sb = sandboxFor(p.access, p.mode);
  const common = { ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.model ? { model: p.model } : {}), approvalPolicy: "never", sandbox: sb.mode };
  return p.session ? { method: "thread/resume", params: { threadId: p.session, ...common } } : { method: "thread/start", params: common };
}

export function turnRequest(threadId: string, p: TurnParams): Json {
  const sb = sandboxFor(p.access, p.mode);
  return {
    threadId,
    input: [{ type: "text", text: p.prompt }, ...(p.images ?? []).map((path) => ({ type: "localImage", path }))],
    ...(p.model ? { model: p.model } : {}),
    ...(p.reasoning ? { effort: p.reasoning } : {}),
    approvalPolicy: "never",
    sandboxPolicy: sb.policy,
  };
}

// ---- items ----------------------------------------------------------------------------------------------------------

const STATUS: Record<string, string> = { inprogress: "in_progress", completed: "completed", failed: "failed", declined: "failed" };
const status = (v: unknown) => STATUS[str(v).toLowerCase()] ?? str(v);

/** An app-server `ThreadItem` in the shape `nativeActivities("codex", …)` already understands (`codex exec --json` items). */
export function execItem(item: Json): Json {
  switch (str(item.type)) {
    case "commandExecution":
      return { type: "command_execution", id: item.id, command: item.command, aggregated_output: item.aggregatedOutput ?? "", exit_code: item.exitCode ?? null, status: status(item.status) };
    case "fileChange":
      return { type: "file_change", id: item.id, changes: list(item.changes).map((c) => ({ path: rec(c).path, kind: rec(c).kind })), status: status(item.status) };
    case "mcpToolCall":
      return { type: "mcp_tool_call", id: item.id, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result ?? null, error: item.error ?? null, status: status(item.status) };
    case "webSearch":
      return { type: "web_search", id: item.id, query: item.query };
    default:
      return item;
  }
}

const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"]);
const stepOf = (item: Json) => brief(item.type === "commandExecution" ? str(item.command) : item.type === "mcpToolCall" ? `${str(item.server)} ${str(item.tool)}` : item.type === "webSearch" ? `search ${str(item.query)}` : str(item.type), 90);

// ---- reducer --------------------------------------------------------------------------------------------------------

export type Reply = { id: string | number; result?: unknown; error?: { code: number; message: string } };
export type Effect =
  | { kind: "text"; text: string }
  | { kind: "activity"; activity: Activity }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "reply"; reply: Reply }
  | { kind: "done"; status: "completed" | "interrupted" | "failed"; error?: string };

const MAX_HELD_PER_THREAD = 100;
const MAX_HELD_THREADS = 50;
const HELD = new Set(["turn/started", "turn/completed", "item/started", "item/completed", "thread/tokenUsage/updated", "thread/status/changed"]);

type Child = { activityId: string; state: SubagentState; lastText: string; tokens?: number };

/** "/root/list_files" to "list files": the last segment of an agent path, readable. */
const humanTask = (path: string) => (path.split("/").filter(Boolean).pop() ?? "").replace(/[_-]+/g, " ").trim();

const childState = (s: unknown): SubagentState => (s === "completed" ? "completed" : s === "interrupted" ? "stopped" : "failed");

/** Per-turn state machine. Feed it every JSON-RPC message of the connection; apply the returned effects in order. */
export function createReducer(rootThreadId: string) {
  const children = new Map<string, Child>();
  const held = new Map<string, Json[]>();
  const hints = new Map<string, { model?: string; role?: string; nickname?: string }>();
  const streamed = new Set<string>();
  let baseline: TokenUsage | undefined;
  let latest: { total: TokenUsage; last: TokenUsage } | undefined;
  let usageSeen = 0;

  const info = (threadId: string, c: Child, patch: Partial<SubagentInfo> & Pick<SubagentInfo, "action" | "state">): Activity => ({
    type: "activity", id: c.activityId, name: "", args: {}, status: "running",
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
        push(info(threadId, c, { action: reopen ? "send" : "progress", state: "running", startedAt: Date.now() }));
        break;
      }
      case "turn/completed": {
        const turn = rec(p.turn);
        const state = childState(turn.status);
        c.state = state;
        const result = c.lastText ? brief(c.lastText, 300) : str(rec(turn.error).message) ? brief(rec(turn.error).message, 300) : undefined;
        push({ ...info(threadId, c, { action: "close", state, ...(result ? { result } : {}), ...(c.tokens ? { tokens: c.tokens } : {}), ...(num(turn.durationMs) !== undefined ? { durationMs: num(turn.durationMs) } : {}) }), status: state === "completed" ? "success" : state === "failed" ? "error" : "unknown", ...(c.lastText ? { output: c.lastText.slice(0, 4000) } : {}) });
        break;
      }
      case "item/started": {
        const item = rec(p.item);
        if (TOOL_ITEMS.has(str(item.type))) push(info(threadId, c, { action: "progress", state: c.state, toolUses: 1, step: stepOf(item) }));
        break;
      }
      case "item/completed": {
        const item = rec(p.item);
        if (item.type === "agentMessage" && str(item.text)) c.lastText = str(item.text);
        break;
      }
      case "thread/tokenUsage/updated": {
        const total = num(rec(rec(p.tokenUsage).total).totalTokens);
        if (total !== undefined) { c.tokens = total; push(info(threadId, c, { action: "progress", state: c.state, tokens: total })); }
        break;
      }
      case "thread/status/changed":
        if (rec(p.status).type === "systemError" && c.state === "running") {
          c.state = "failed";
          push({ ...info(threadId, c, { action: "close", state: "failed", result: "Agent failed (system error)" }), status: "error" });
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
      publish([{ type: "activity", id: str(item.id) || `agent:${threadId}`, name: "subagent", args: { tool: "spawnAgent", agent: threadId }, status: "running", subagent: { provider: "codex", agentId: threadId, ...(path ? { agentPath: path } : {}), title: humanTask(path) || h?.nickname || "", action: "spawn", state: "running", startedAt: Date.now(), ...(h?.model ? { model: h.model } : {}), ...(h?.role ? { role: h.role } : {}) } }], out);
      return;
    }
    if (!known) return;
    if (kind === "interacted") {
      if (first) return;
      const reopen = known.state !== "running" && known.state !== "waiting";
      known.state = "running";
      out.push({ kind: "activity", activity: info(threadId, known, { action: reopen ? "send" : "progress", state: "running" }) });
    } else if ((kind === "completed" || kind === "interrupted") && !first) {
      const state: SubagentState = kind === "completed" ? "completed" : "stopped";
      if (known.state === "completed" || known.state === "failed") return;
      known.state = state;
      out.push({ kind: "activity", activity: { ...info(threadId, known, { action: "close", state, ...(known.lastText ? { result: brief(known.lastText, 300) } : {}) }), status: state === "completed" ? "success" : "unknown" } });
    }
  }

  /** The turn's own text and tool items. */
  function root(m: Json): Effect[] {
    const method = str(m.method);
    const p = rec(m.params);
    const out: Effect[] = [];
    if (method === "item/agentMessage/delta") {
      streamed.add(str(p.itemId));
      if (str(p.delta)) out.push({ kind: "text", text: str(p.delta) });
    } else if (method === "item/started" || method === "item/completed") {
      const item = rec(p.item);
      const type = str(item.type);
      const evType = method === "item/started" ? "item.started" : "item.completed";
      if (type === "agentMessage") {
        // A message that never streamed deltas (short or replayed) arrives whole.
        if (evType === "item.completed" && str(item.text) && !streamed.has(str(item.id))) out.push({ kind: "text", text: str(item.text) });
      } else if (type === "collabAgentToolCall" && str(item.tool) === "spawnAgent" && list(item.receiverThreadIds).length > 1) {
        // One entry per spawned agent (the shared mapping keys a spawn by its first receiver only).
        const ids = list(item.receiverThreadIds).map(str);
        const states = rec(item.agentsStates);
        for (const id of ids) publish(nativeActivities("codex", { type: evType, item: { ...item, id: `${str(item.id)}:${id}`, receiverThreadIds: [id], agentsStates: id in states ? { [id]: states[id] } : {} } }), out);
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
    } else if (method === "turn/completed") {
      const turn = rec(p.turn);
      const s = str(turn.status);
      const e = rec(turn.error);
      out.push({ kind: "done", status: s === "interrupted" ? "interrupted" : s === "failed" ? "failed" : "completed", ...(str(e.message) ? { error: str(e.message) } : {}) });
    } else if (method === "error") {
      const e = rec(p.error);
      if (p.willRetry !== true && str(e.message)) out.push({ kind: "done", status: "failed", error: str(e.message) });
    }
    return out;
  }

  const serverRequest = (m: Json): Effect[] => {
    const method = str(m.method);
    const id = m.id as string | number;
    // No approval UI yet: refuse (the sandbox/never policy should keep these from arriving at all).
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return [{ kind: "reply", reply: { id, result: { decision: "decline" } } }];
    if (method === "mcpServer/elicitation/request") return [{ kind: "reply", reply: { id, result: { action: "decline" } } }];
    return [{ kind: "reply", reply: { id, error: { code: -32601, message: `Not supported by this client: ${method}` } } }];
  };

  return {
    /** Processes one message (not a response to our own request). */
    onMessage(m: Json): Effect[] {
      const method = str(m.method);
      if (!method) return [];
      if (m.id !== undefined && m.id !== null) return serverRequest(m);
      const p = rec(m.params);
      if (method === "thread/started") {
        const t = rec(p.thread);
        const id = str(t.id);
        if (id && id !== rootThreadId) hints.set(id, { model: str(t.model) || undefined, role: str(t.agentRole) || undefined, nickname: str(t.agentNickname) || undefined });
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
    /** Children still running (the caller marks them unknown when the turn or the connection ends). */
    running(): string[] { return [...children].filter(([, c]) => c.state === "running" || c.state === "waiting").map(([id]) => id); },
    /** Test hook. */
    get held() { return held.size; },
  };
}

function usageOf(b: Json): TokenUsage | undefined {
  const input = num(b.inputTokens);
  const output = num(b.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cached: num(b.cachedInputTokens) ?? 0, cacheWrite: num(b.cacheWriteInputTokens) ?? 0, reasoning: num(b.reasoningOutputTokens) ?? 0 };
}
const sub = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output), cached: Math.max(0, a.cached - b.cached), cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite), reasoning: Math.max(0, a.reasoning - b.reasoning) });

// ---- one turn over a transport --------------------------------------------------------------------------------------

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
};

export type TurnResult = { session: string; error: string; running: string[]; usage?: TokenUsage };

/** Thrown when the app-server could not be started or spoken to before any output: the caller may fall back to `exec`. */
export class AppServerUnavailable extends Error {}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * initialize, thread/start|resume, turn/start, then reduce notifications until the root turn ends. Never reports an error
 * for a child: children failing is their own state. Rejects with AbortError when the signal aborts (the process is killed).
 */
export async function runAppServerTurn(conn: Connection, p: TurnParams, h: TurnHandlers): Promise<TurnResult> {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let reducer: ReturnType<typeof createReducer> | undefined;
  let finish: (r: { status: string; error?: string }) => void = () => {};
  const finished = new Promise<{ status: string; error?: string }>((resolve) => { finish = resolve; });
  const early: Json[] = [];

  const apply = (effects: Effect[]) => {
    for (const e of effects) {
      if (e.kind === "text") h.onText(e.text);
      else if (e.kind === "activity") h.onActivity(e.activity);
      else if (e.kind === "usage") h.onUsage?.(e.usage);
      else if (e.kind === "reply") void conn.write(JSON.stringify({ jsonrpc: "2.0", ...e.reply })).catch(() => {});
      else if (e.kind === "done") finish({ status: e.status, error: e.error });
    }
  };

  conn.onMessage((m) => {
    if (m.id !== undefined && m.id !== null && !m.method && pending.has(m.id as number)) {
      const w = pending.get(m.id as number)!;
      pending.delete(m.id as number);
      if (m.error) w.reject(new Error(str(rec(m.error).message) || "app-server error"));
      else w.resolve(rec(m.result));
      return;
    }
    if (!reducer) { early.push(m); return; }
    apply(reducer.onMessage(m));
  });

  const aborted = () => new DOMException("Aborted", "AbortError");
  const onAbort = () => conn.kill();
  h.signal?.addEventListener("abort", onAbort, { once: true });
  const exit = conn.closed.then((code) => ({ status: "closed" as const, code }));

  const request = (method: string, params: Json): Promise<Json> => {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Json>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => { pending.delete(id); reject(new Error(`app-server did not answer ${method}`)); }, REQUEST_TIMEOUT_MS);
    }).finally(() => clearTimeout(timer));
    void conn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch(() => {});
    return Promise.race([reply, exit.then(() => { throw new AppServerUnavailable(conn.stderr().trim().slice(-400) || "app-server exited"); })]);
  };

  try {
    if (h.signal?.aborted) throw aborted();
    try {
      await request("initialize", { clientInfo: { name: "gustaf", title: "Gustaf", version: "0.1.0" } });
      await conn.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    } catch (e) {
      if (h.signal?.aborted) throw aborted();
      throw e instanceof AppServerUnavailable ? e : new AppServerUnavailable(e instanceof Error ? e.message : String(e));
    }
    const t = threadRequest(p);
    let thread: Json;
    try {
      thread = rec((await request(t.method, t.params)).thread);
    } catch (e) {
      if (h.signal?.aborted) throw aborted();
      throw e;
    }
    const session = str(thread.id);
    if (!session) throw new Error("app-server returned no thread id");
    reducer = createReducer(session);
    for (const m of early.splice(0)) apply(reducer.onMessage(m));
    try {
      await request("turn/start", turnRequest(session, p));
    } catch (e) {
      if (h.signal?.aborted) throw aborted();
      throw e;
    }
    const end = await Promise.race([finished, exit.then((x) => ({ status: "lost", error: conn.stderr().trim().slice(-600) || `codex app-server exited${x.code == null ? "" : ` with ${x.code}`}` }))]);
    if (h.signal?.aborted) throw aborted();
    const usage = reducer.usage();
    if (usage) h.onUsage?.(usage);
    const error = end.status === "completed" ? "" : end.status === "interrupted" ? "" : end.error || "Codex turn failed";
    return { session, error, running: reducer.running(), usage };
  } finally {
    h.signal?.removeEventListener("abort", onAbort);
    conn.kill();
  }
}

