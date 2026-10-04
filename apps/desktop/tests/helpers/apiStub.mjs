// Stand-in for src/lib/api.ts in Node tests: settings in memory, file tools on a real temporary folder, git through the
// real `git` binary with a shadow repo laid out like src-tauri/src/git.rs does. Commands are recorded, never executed.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const state = {
  settings: new Map(),
  instructionFiles: [],
  /** Commands the agent asked to run: { root, command }. */
  runs: [],
  /** A result object, or ({ root, command, timeoutMs }) => result. */
  runResult: { code: 0, output: 'ran', timed_out: false },
  /** Timeout argument of every command in `runs`, in the same order. */
  runTimeouts: [],
  /** Hook commands that were run: { root, command, timeoutMs, stdin, env }. */
  hookRuns: [],
  hookResult: () => ({ code: 0, output: '', timed_out: false }),
  /** (id, path) => diff text for the review panel; empty string = nothing pending. */
  reviewDiff: () => '',
  /** Computer action batches the agent executed (nothing touches the real desktop). */
  executed: [],
  /** actions => the fake `cu_execute` result. */
  shot: () => ({ png: '', width: 1, height: 1 }),
  shadows: mkdtempSync(join(tmpdir(), 'apistub-shadow-')),
  /** Keychain entries written through `secrets`. */
  secrets: new Map(),
  /** Batches written through `rawLog.append`: [day, lines]. */
  rawLog: [],
  /** Fake stdio MCP servers by config id: { tools, call(name, args), epoch?, startError? }; and what was sent. */
  mcp: { servers: {}, starts: [], requests: [], stops: [], cancels: [], waiting: new Map() },
  /** Unexpected errors of the SQLite stand-in (a missing table is not one: only the agent tables exist there). */
  dbErrors: [],
  reset() {
    agentDb = null;
    this.dbErrors.length = 0;
    this.settings.clear();
    this.secrets.clear();
    this.rawLog.length = 0;
    this.mcp = { servers: {}, starts: [], requests: [], stops: [], cancels: [], waiting: new Map() };
    this.instructionFiles = [];
    this.runs.length = 0;
    this.runTimeouts.length = 0;
    this.hookRuns.length = 0;
    this.hookResult = () => ({ code: 0, output: '', timed_out: false });
    this.runResult = { code: 0, output: 'ran', timed_out: false };
    this.reviewDiff = () => '';
    this.executed = [];
    this.shot = () => ({ png: '', width: 1, height: 1 });
  },
};

const confine = (root, rel) => {
  const parts = String(rel).split('/').filter((p) => p && p !== '.');
  if (String(rel).startsWith('/') || parts.includes('..') || !parts.length && rel !== '.') throw new Error(`path escapes project: ${rel}`);
  return join(root, ...parts);
};

export const getSetting = async (key, fallback) => (state.settings.has(key) ? JSON.parse(state.settings.get(key)) : fallback);
export const setSetting = async (key, value) => void state.settings.set(key, JSON.stringify(value));
export const deleteSetting = async (key) => void state.settings.delete(key);
// SQL bridge: a real in-memory SQLite (node:sqlite) holding only the agent_runs / agent_messages tables, created from the
// statements in src-tauri/src/db.rs (between its agent-runs markers). Anything else behaves like an empty database.
let agentDb = null;
function sqlite() {
  if (!agentDb) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    agentDb = new DatabaseSync(':memory:');
    const rs = readFileSync(new URL('../../src-tauri/src/db.rs', import.meta.url), 'utf8');
    agentDb.exec('pragma foreign_keys = on; create table chats(id integer primary key);');
    agentDb.exec(/-- memories:begin([\s\S]*?)-- memories:end/.exec(rs)[1]);
    agentDb.exec(/-- agent-runs:begin([\s\S]*?)-- agent-runs:end/.exec(rs)[1]);
  }
  return agentDb;
}
const dbFail = (e) => { if (!/no such table/.test(String(e?.message))) state.dbErrors.push(String(e?.message ?? e)); };
export const db = {
  select: async (sql, params = []) => { try { return sqlite().prepare(sql).all(...params).map((r) => ({ ...r })); } catch (e) { dbFail(e); return []; } },
  exec: async (sql, params = []) => { try { const r = sqlite().prepare(sql).run(...params); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; } catch (e) { dbFail(e); return { changes: 0, lastId: 0 }; } },
  /** Test access to the stand-in database. */
  raw: () => sqlite(),
};
/** Raw CLI log (src-tauri/src/rawlog.rs): appended batches by day. */
export const rawLog = {
  append: async (day, lines) => void state.rawLog.push([day, lines]),
  clear: async () => void (state.rawLog.length = 0),
  info: async () => ({ dir: '/stub/raw-cli', bytes: state.rawLog.reduce((n, [, l]) => n + l.length, 0), files: state.rawLog.length ? 1 : 0, latest: state.rawLog.length ? '/stub/raw-cli/day.jsonl' : null }),
};
/** Codex rollout scan (src-tauri/src/codex_agents.rs): nothing found unless a test sets `state.codexScan`. */
export const codexAgents = {
  scan: async (threadId, startedAt) => (state.codexScan ?? (() => ({ parentFound: false, agents: [], truncated: false, notes: [] })))(threadId, startedAt),
};
export const secrets = {
  set: async (id, value) => void state.secrets.set(id, value),
  get: async (id) => state.secrets.get(id) ?? null,
  delete: async (id) => void state.secrets.delete(id),
};

const fakeMcp = (id) => {
  const s = state.mcp.servers[id];
  if (!s) throw new Error(`unknown MCP server ${id}`);
  return s;
};
const mcpStatus = (id) => {
  const s = state.mcp.servers[id];
  const capabilities = { ...(s?.resources ? { resources: {} } : {}), ...(s?.prompts ? { prompts: {} } : {}) };
  return { id, state: 'running', error: null, pid: 1, restarts: 0, toolsEpoch: s?.epoch ?? 0, resourcesEpoch: s?.resourcesEpoch ?? 0, promptsEpoch: s?.promptsEpoch ?? 0, init: { protocolVersion: '2025-06-18', capabilities, serverInfo: { name: id } } };
};
export const mcpStdio = {
  start: async (id, spec) => {
    state.mcp.starts.push({ id, spec });
    const s = fakeMcp(id);
    if (s.startError) throw new Error(s.startError);
    return mcpStatus(id);
  },
  /** A server's `hang` function (name, args) => true makes that tools/call wait until `cancel` (like a slow server). */
  request: async (id, method, params, _timeoutMs, requestKey) => {
    state.mcp.requests.push({ id, method, params, requestKey });
    const s = fakeMcp(id);
    if (method === 'tools/list') return { tools: s.tools };
    if (method === 'tools/call') {
      if (s.hang?.(params.name, params.arguments)) return new Promise((_, reject) => state.mcp.waiting.set(requestKey, () => reject(new Error('MCP request cancelled'))));
      return s.call(params.name, params.arguments);
    }
    if (method === 'resources/list') return { resources: s.resources };
    if (method === 'resources/templates/list' && s.resourceTemplates) return { resourceTemplates: s.resourceTemplates };
    if (method === 'resources/read') return s.read(params.uri);
    if (method === 'prompts/list') return { prompts: s.prompts };
    if (method === 'prompts/get') return s.getPrompt(params.name, params.arguments);
    throw new Error(`MCP error -32601: Method not found: ${method}`);
  },
  cancel: async (id, requestKey) => {
    state.mcp.cancels.push({ id, requestKey });
    state.mcp.waiting.get(requestKey)?.();
  },
  stop: async (id) => void state.mcp.stops.push(id),
  status: async () => Object.keys(state.mcp.servers).map(mcpStatus),
  logs: async () => [],
};
export const oauthLoopback = {
  start: async () => {
    throw new Error('oauthLoopback is faked per test through setMcpOAuthDeps');
  },
  wait: async () => '',
  cancel: async () => {},
};
export const cursor = { scan: async () => [], messages: async () => [] };

export const fsx = {
  read: async (root, path) => {
    const text = readFileSync(confine(root, path), 'utf8');
    return text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}|${l}\n`).join('');
  },
  list: async (root, path) => readdirSync(confine(root, path || '.'), { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort().join('\n'),
  files: async () => [],
  search: async () => 'no matches',
  edit: async (root, path, oldString, newString) => {
    const p = confine(root, path);
    const text = readFileSync(p, 'utf8');
    const n = text.split(oldString).length - 1;
    if (n === 0) throw new Error('old_string not found');
    if (n > 1) throw new Error(`old_string is not unique (${n} matches); include more context`);
    writeFileSync(p, text.replace(oldString, () => newString));
    return 'ok';
  },
  write: async (root, path, content) => {
    const p = confine(root, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return 'ok';
  },
  /** Instruction files the test put in `state.instructionFiles` ({ name, text }). */
  instructions: async () => state.instructionFiles.map((f) => ({ bytes: new TextEncoder().encode(f.text).length, ...f })),
  homeFile: async () => null,
  run: async (root, command, timeoutMs) => {
    state.runs.push({ root, command });
    state.runTimeouts.push(timeoutMs);
    return typeof state.runResult === 'function' ? state.runResult({ root, command, timeoutMs }) : state.runResult;
  },
};

/** Hook runner (src-tauri/src/hook_exec.rs): calls are recorded in `state.hookRuns`, the answer comes from `state.hookResult(call)`. */
export const hookRunner = {
  run: async (root, command, timeoutMs, stdin, env) => {
    const call = { root, command, timeoutMs, stdin, env };
    state.hookRuns.push(call);
    return state.hookResult(call);
  },
};

export const git = async (root, args, shadow) => {
  if (!shadow) throw new Error('only the shadow repo is available in tests');
  const dir = join(state.shadows, createHash('sha1').update(root).digest('hex'));
  if (!existsSync(join(dir, 'HEAD'))) {
    execFileSync('git', ['init', '-q', '--bare', dir]);
    mkdirSync(join(dir, 'info'), { recursive: true });
    writeFileSync(join(dir, 'info/exclude'), '.git/\nnode_modules/\ntarget/\ndist/\n.DS_Store\n');
  }
  const r = spawnSync('git', [`--git-dir=${dir}`, `--work-tree=${root}`, ...args], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim() || `git exited with ${r.status}`);
  return r.stdout;
};

export const review = {
  prepare: async () => { throw new Error('not in tests'); },
  list: async () => [],
  diff: async (id, path) => state.reviewDiff(id, path),
  decide: async () => {},
  finish: async () => {},
};

export const computer = {
  execute: async (actions) => {
    state.executed.push(actions);
    return state.shot(actions);
  },
  screenSize: async () => ({ width: 1, height: 1 }),
  permissions: async () => ({ accessibility: true, screen: true }),
};
