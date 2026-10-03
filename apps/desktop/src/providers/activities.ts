import type { Part, SubagentInfo, SubagentState } from './types';
export type Activity = Extract<Part, { type: 'activity' }>;
const output = (v: unknown) => typeof v === 'string' ? v : v == null ? undefined : JSON.stringify(v, null, 2);

type Json = Record<string, unknown>;
/** Narrows untrusted CLI JSON to an object; anything else reads as an empty record. */
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : v == null ? '' : String(v);
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** One line, whitespace collapsed, clipped: what the cards and the panel show next to a title. */
const brief = (v: unknown, n: number) => clip(str(v).replace(/\s+/g, ' ').trim(), n);
/** `spawn_agent`, `spawnAgent` and `Spawn-Agent` all read as `spawnagent`. */
const norm = (v: unknown) => str(v).toLowerCase().replace(/[^a-z]/g, '');
const MAX_OUTPUT = 4000;

/** Claude tool results are a string or a list of text blocks; a list of only text blocks reads as its text. */
function resultText(content: unknown): string | undefined {
  const blocks = list(content);
  if (blocks.length && blocks.every((b) => rec(b).type === 'text' && typeof rec(b).text === 'string')) return blocks.map((b) => rec(b).text).join('\n');
  return output(content);
}

// ---- CLI-native subagents ----

const sub = (s: Partial<SubagentInfo> & Pick<SubagentInfo, 'provider' | 'agentId' | 'action' | 'state'>): SubagentInfo => ({ title: '', ...s });
const statusOf = (state: SubagentState): Activity['status'] => state === 'completed' ? 'success' : state === 'failed' ? 'error' : 'running';
const isTerminal = (s?: SubagentState) => s === 'completed' || s === 'failed';

/** Codex `CollabAgentStatus` (pendingInit, running, interrupted, completed, errored, shutdown, notFound) to our state. */
function agentState(status: unknown): SubagentState | undefined {
  switch (norm(status)) {
    case 'pendinginit': case 'running': return 'running';
    case 'completed': case 'shutdown': return 'completed';
    case 'errored': case 'notfound': case 'interrupted': return 'failed';
    default: return undefined;
  }
}
const COLLAB_ACTIONS: Record<string, SubagentInfo['action'] | 'list'> = {
  spawnagent: 'spawn', spawn: 'spawn',
  wait: 'wait', waitagent: 'wait',
  sendinput: 'send', sendmessage: 'send', followuptask: 'send', resumeagent: 'send',
  closeagent: 'close', interruptagent: 'close',
  listagents: 'list',
};

/**
 * Codex `collab_tool_call` items (`codex exec --json`; field names are read in snake_case and camelCase). A spawn is one
 * entry keyed by its call id; every other action addresses agents by thread id (receivers and the keys of
 * `agents_states`), one entry per agent. Returns null for an unknown tool so the caller keeps the generic card.
 */
function collab(ev: Json, it: Json): Activity[] | null {
  const action = COLLAB_ACTIONS[norm(it.tool ?? it.tool_name ?? it.toolName ?? it.action ?? it.name)];
  if (!action) return null;
  if (action === 'list') return [];
  const done = ev.type === 'item.completed';
  const callFailed = norm(it.status) === 'failed';
  const states = rec(it.agents_states ?? it.agentsStates);
  const receivers = list(it.receiver_thread_ids ?? it.receiverThreadIds).map(str).filter(Boolean);
  const ids = [...new Set([...receivers, ...Object.keys(states)])];
  const prompt = str(it.prompt);
  const make = (agentId: string, id: string): Activity => {
    const st = rec(states[agentId]);
    const message = str(st.message);
    const known = agentState(st.status);
    // A call that is still in flight leaves the agent running (or, for `wait`, waited on); a finished one reports what the agent said.
    const state: SubagentState = callFailed ? 'failed' : known && (isTerminal(known) || done) ? known : !done && action === 'wait' ? 'waiting' : action === 'close' && done ? 'completed' : known ?? 'running';
    const info = sub({
      provider: 'codex', agentId, action, state,
      ...(action === 'spawn' && prompt ? { title: brief(prompt.split('\n').find((l) => l.trim()) ?? '', 60) } : {}),
      ...(prompt && (action === 'spawn' || action === 'send') ? { prompt: brief(prompt, 240) } : {}),
      ...(message ? { result: brief(message, 300) } : {}),
      ...(action === 'wait' && done ? { waits: 1 } : {}),
    });
    return { type: 'activity', id, name: 'subagent', args: { tool: str(it.tool), ...(agentId ? { agent: agentId } : {}) }, status: statusOf(state), ...(message ? { output: clip(message, MAX_OUTPUT) } : {}), subagent: info };
  };
  if (action === 'spawn') return [make(ids[0] ?? '', str(it.id))];
  return ids.map((agentId) => make(agentId, `subagent:${agentId}`));
}

const TASK_TOOLS = new Set(['task', 'agent']);
/** What a subagent just did, from one of its own `tool_use` blocks. */
const stepOf = (name: string, input: Json) => brief(`${name} ${str(input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.query ?? input.url ?? '')}`, 90);

/** An entry read from a rollout file (providers/codexRollout.ts) is authoritative: its state and counters replace the old ones. */
function applyScan(actions: Map<string, Activity>, next: Activity, patch: SubagentInfo): Activity {
  const key = actions.has(next.id) ? next.id : [...actions].find(([, a]) => patch.agentId && a.subagent?.agentId === patch.agentId)?.[0] ?? next.id;
  const old = actions.get(key);
  const info: SubagentInfo = { ...old?.subagent, ...patch, title: patch.title || old?.subagent?.title || '', prompt: patch.prompt ?? old?.subagent?.prompt, result: patch.result ?? old?.subagent?.result };
  const merged: Activity = { ...old, ...next, id: key, name: old?.name || next.name || 'subagent', status: statusOf(info.state), output: next.output ?? old?.output, subagent: info };
  actions.set(key, merged);
  return merged;
}

/**
 * Folds an activity into the per-run map and returns the entry to publish. Subagent activities are merged per agent:
 * repeated `wait` calls bump one counter, a spawn's call id and its later thread id are the same entry, and a Claude
 * `tool_result` completes the `Task` entry. Everything else merges by id as before.
 */
export function applyActivity(actions: Map<string, Activity>, next: Activity): Activity {
  const patch = next.subagent;
  const prev = actions.get(next.id);
  if (!patch) {
    const merged = mergeActivity(prev, next);
    if (prev?.subagent) {
      // The result of a Claude `Task` call.
      const state: SubagentState = next.status === 'error' ? 'failed' : next.status === 'success' ? 'completed' : prev.subagent.state;
      const text = next.output ?? '';
      merged.subagent = { ...prev.subagent, state, ...(text ? { result: brief(text, 300) } : {}) };
      merged.output = text ? clip(text, MAX_OUTPUT) : prev.output;
    }
    actions.set(next.id, merged);
    return merged;
  }
  if (patch.action === 'scan') return applyScan(actions, next, patch);
  let key = next.id;
  if (patch.action === 'spawn' && patch.agentId && !actions.has(next.id)) {
    // A spawn event for an agent the rollout scan already lists is the same entry.
    key = [...actions].find(([, a]) => a.subagent?.action === 'scan' && a.subagent.agentId === patch.agentId)?.[0] ?? next.id;
  }
  if (patch.action !== 'spawn' && patch.action !== 'task' && patch.action !== 'progress' && patch.agentId) {
    key = [...actions].find(([, a]) => a.subagent?.agentId === patch.agentId)?.[0] ?? next.id;
  }
  const old = actions.get(key);
  const p = old?.subagent;
  const progress = patch.action === 'progress';
  const state: SubagentState = !p ? patch.state : progress || (isTerminal(p.state) && patch.action !== 'send') ? p.state : patch.state;
  const info: SubagentInfo = {
    ...p, ...patch,
    agentId: patch.agentId || p?.agentId || '',
    title: p?.title || patch.title,
    role: p?.role ?? patch.role,
    action: progress && p ? p.action : patch.action,
    state,
    prompt: p?.prompt ?? patch.prompt,
    result: patch.result ?? p?.result,
    ...((p?.waits ?? 0) + (patch.waits ?? 0) ? { waits: (p?.waits ?? 0) + (patch.waits ?? 0) } : {}),
    ...((p?.toolUses ?? 0) + (patch.toolUses ?? 0) ? { toolUses: (p?.toolUses ?? 0) + (patch.toolUses ?? 0) } : {}),
    step: patch.step ?? p?.step,
  };
  const merged: Activity = { ...old, ...next, id: key, name: old?.name || next.name || 'subagent', args: Object.keys(next.args).length ? next.args : old?.args ?? {}, status: statusOf(state), output: next.output ?? old?.output, subagent: info };
  actions.set(key, merged);
  return merged;
}

/** A Codex `wait` item that names no agent at all (`codex exec --json` emits only these for multi-agent runs). */
export function isBareCollabWait(e: unknown): boolean {
  const ev = rec(e);
  const it = rec(ev.item);
  if (!['item.started', 'item.updated', 'item.completed'].includes(str(ev.type)) || !norm(it.type).includes('collab')) return false;
  if (COLLAB_ACTIONS[norm(it.tool ?? it.tool_name ?? it.toolName ?? it.action ?? it.name)] !== 'wait') return false;
  return !list(it.receiver_thread_ids ?? it.receiverThreadIds).length && !Object.keys(rec(it.agents_states ?? it.agentsStates)).length;
}

/** Why an item that looks like a subagent event got the generic card; written to the raw CLI log (lib/rawCliLog.ts). */
export type Unmapped = { type: string; tool: string; status: string; reason: 'unknown-tool' | 'no-agents' | 'invalid'; keys: string[] };

/** `collab()` that can neither throw nor lose the item: an empty or unknown result is reported through `onUnmapped` and is null. */
function collabOrFallback(ev: Json, it: Json, onUnmapped?: (u: Unmapped) => void): Activity[] | null {
  let subs: Activity[] | null = null;
  let invalid = false;
  try { subs = collab(ev, it); } catch { invalid = true; }
  if (subs?.length) return subs;
  const known = !!COLLAB_ACTIONS[norm(it.tool ?? it.tool_name ?? it.toolName ?? it.action ?? it.name)];
  try { onUnmapped?.({ type: str(it.type), tool: str(it.tool), status: str(it.status), reason: invalid ? 'invalid' : known ? 'no-agents' : 'unknown-tool', keys: Object.keys(it).slice(0, 30) }); } catch { /* debug only */ }
  return null;
}

/** The generic card of a Codex item (commands, file changes, MCP calls and subagent items that could not be mapped). */
function codexItem(ev: Json, it: Json, subagentLike: boolean): Activity {
  const done = ev.type === 'item.completed';
  const failed = it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0) || !!it.error;
  const path = Array.isArray(it.changes) ? it.changes.map((c) => rec(c).path).join(', ') : undefined;
  // A subagent-like item that fell through keeps everything it said, under an id that is stable across its updates.
  const id = str(it.id ?? it.call_id ?? it.callId) || (subagentLike ? `${norm(it.type)}:${norm(it.tool)}:${brief(it.prompt, 40)}` : '');
  const status: Activity['status'] = !done ? 'running' : failed ? 'error' : norm(it.status) === 'completed' || it.exit_code === 0 || (it.type === 'mcp_tool_call' && it.result != null) ? 'success' : 'unknown';
  return { type: 'activity', id, name: str(it.type), args: { command: it.command, path, server: it.server, tool: it.tool, ...(subagentLike && it.prompt ? { prompt: brief(it.prompt, 240) } : {}), ...rec(it.arguments) }, status, output: subagentLike ? clip(output(it.error ?? it) ?? '', MAX_OUTPUT) : output(it.error ?? it.aggregated_output ?? it.result ?? it.changes) };
}

/**
 * Native CLI tools are records of completed work, never executable app tool calls. `onUnmapped` is told about every
 * Codex item whose type mentions collab or agent but that could not become a subagent entry (those items keep a
 * generic card with the whole item as its output: a subagent event is never dropped).
 */
export function nativeActivities(provider: string, e: unknown, onUnmapped?: (u: Unmapped) => void): Activity[] {
  const ev = rec(e);
  if (provider === 'claude') {
    // Events from inside a subagent are marked with the `tool_use` id of the Task call that started it.
    const parent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? ev.parent_tool_use_id : '';
    return list(rec(ev.message).content).flatMap((item): Activity[] => {
      const c = rec(item);
      if (c.type === 'tool_use') {
        if (parent) return [{ type: 'activity', id: parent, name: '', args: {}, status: 'running', subagent: sub({ provider: 'claude', agentId: parent, action: 'progress', state: 'running', toolUses: 1, step: stepOf(str(c.name), rec(c.input)) }) }];
        const args = rec(c.input);
        if (TASK_TOOLS.has(str(c.name).toLowerCase())) {
          const role = str(args.subagent_type);
          return [{ type: 'activity', id: str(c.id), name: str(c.name), args, status: 'running', subagent: sub({ provider: 'claude', agentId: str(c.id), action: 'task', state: 'running', title: brief(args.description || role, 80), ...(role ? { role } : {}), ...(args.prompt ? { prompt: brief(args.prompt, 240) } : {}) }) }];
        }
        return [{ type: 'activity', id: str(c.id), name: str(c.name), args, status: 'running' }];
      }
      if (c.type === 'tool_result') {
        if (parent) return [];
        return [{ type: 'activity', id: str(c.tool_use_id), name: '', args: {}, status: c.is_error ? 'error' : 'success', output: resultText(c.content) }];
      }
      return [];
    });
  }
  if (provider === 'codex') {
    const it = rec(ev.item);
    if (!ev.item || !['item.started', 'item.updated', 'item.completed'].includes(str(ev.type)) || ['reasoning', 'agentmessage'].includes(norm(it.type))) return [];
    const kind = norm(it.type);
    const subagentLike = kind.includes('collab') || kind.includes('agent');
    if (subagentLike) {
      const subs = collabOrFallback(ev, it, onUnmapped);
      // A wait that started without agents got a generic card (nothing else to show); close it when its result names them.
      if (subs) return subs.length && ev.type === 'item.completed' && !list(it.receiver_thread_ids ?? it.receiverThreadIds).length && !subs.some((a) => a.subagent?.action === 'spawn') ? [...subs, (({ output: _o, ...closing }) => closing)(codexItem(ev, it, true))] : subs;
    }
    return [codexItem(ev, it, subagentLike)];
  }
  if (provider === 'cursor-agent' && ev.type === 'tool_call') {
    const [name, call] = Object.entries(rec(ev.tool_call))[0] ?? ['tool', {}];
    const c = rec(call);
    return [{ type: 'activity', id: str(ev.call_id ?? ev.id ?? `${name}:${JSON.stringify(c.args ?? {})}`), name: name.replace(/ToolCall$/, ''), args: rec(c.args), status: ev.subtype !== 'completed' ? 'running' : rec(c.result).error || ev.is_error ? 'error' : c.result ? 'success' : 'unknown', output: output(c.result ?? ev.result) }];
  }
  return [];
}

export function mergeActivity(previous: Activity | undefined, next: Activity): Activity {
  return { ...previous, ...next, name: next.name || previous?.name || 'tool', args: Object.keys(next.args).length ? next.args : previous?.args ?? {} };
}
