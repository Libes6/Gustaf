import type { Part } from './types';
export type Activity = Extract<Part, { type: 'activity' }>;
const output = (v: unknown) => typeof v === 'string' ? v : v == null ? undefined : JSON.stringify(v, null, 2);

type Json = Record<string, unknown>;
/** Narrows untrusted CLI JSON to an object; anything else reads as an empty record. */
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : v == null ? '' : String(v);

/** Native CLI tools are records of completed work, never executable app tool calls. */
export function nativeActivities(provider: string, e: unknown): Activity[] {
  const ev = rec(e);
  if (provider === 'claude') {
    return list(rec(ev.message).content).flatMap((item): Activity[] => {
      const c = rec(item);
      if (c.type === 'tool_use') return [{ type: 'activity', id: str(c.id), name: str(c.name), args: rec(c.input), status: 'running' }];
      if (c.type === 'tool_result') return [{ type: 'activity', id: str(c.tool_use_id), name: '', args: {}, status: c.is_error ? 'error' : 'success', output: output(c.content) }];
      return [];
    });
  }
  if (provider === 'codex') {
    const it = rec(ev.item);
    if (!ev.item || !['item.started', 'item.updated', 'item.completed'].includes(str(ev.type)) || ['reasoning', 'agent_message'].includes(str(it.type))) return [];
    const done = ev.type === 'item.completed';
    const failed = it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0) || !!it.error;
    const path = Array.isArray(it.changes) ? it.changes.map((c) => rec(c).path).join(', ') : undefined;
    return [{ type: 'activity', id: str(it.id), name: str(it.type), args: { command: it.command, path, server: it.server, tool: it.tool, ...rec(it.arguments) }, status: !done ? 'running' : failed ? 'error' : it.status === 'completed' || it.exit_code === 0 || (it.type === 'mcp_tool_call' && it.result != null) ? 'success' : 'unknown', output: output(it.error ?? it.aggregated_output ?? it.result ?? it.changes) }];
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
