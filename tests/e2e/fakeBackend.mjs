// In-memory stand-in for the Rust side of M Code, living in the test process. The browser's fake
// `window.__TAURI_INTERNALS__.invoke` (tests/e2e/tauriInit.js) forwards every command here.
//
// Database: the real SQLite engine through Node's built-in `node:sqlite`, with the schema read out of
// src-tauri/src/db.rs (so migrations are never duplicated). Only the FTS5 search index is not rebuilt; the
// `search_messages` command is a plain substring scan over the same rows (see `searchMessages`).
// HTTP: `plugin:http|*` is implemented on top of `FakeProvider`, a scripted OpenAI-compatible endpoint.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MARK_CLOSE, MARK_OPEN } from '../../src/lib/searchUtil.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SCHEMA = /const SCHEMA: &str = "([\s\S]*?)";/.exec(readFileSync(`${root}/src-tauri/src/db.rs`, 'utf8'))[1];

export const FAKE_BASE_URL = 'https://fake-llm.test/v1';
const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const json = (obj, status = 200) => ({
  status,
  headers: [['content-type', 'application/json']],
  chunks: (async function* () { yield enc.encode(JSON.stringify(obj)); })(),
});

/**
 * Scripted OpenAI-compatible chat endpoint. `reply()` queues the answer for the next `/chat/completions` request:
 *   { text }                        streamed word by word, then usage
 *   { toolCalls: [{ name, args }] } streamed tool calls
 *   { hold: true }                  (with text) the stream stops after the first chunk until `handle.release()`
 * With nothing queued the model answers "OK".
 */
export class FakeProvider {
  models = ['fake-model'];
  requests = [];
  #queue = [];

  reply(spec) {
    const gate = spec.hold ? deferred() : null;
    this.#queue.push({ ...spec, gate });
    return { release: () => gate?.resolve() };
  }

  /** Chat-completion request bodies, oldest first. */
  get chatBodies() { return this.requests.filter((r) => r.path === '/chat/completions').map((r) => r.body); }

  handle(method, url, body) {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    this.requests.push({ method, path, body: body ? JSON.parse(body) : null });
    if (path === '/models') return json({ data: this.models.map((id) => ({ id, created: 1700000000 })) });
    if (path === '/chat/completions') return { status: 200, headers: [['content-type', 'text/event-stream']], chunks: this.#stream(this.#queue.shift() ?? { text: 'OK' }) };
    return json({ error: { message: `fake provider: no route for ${path}` } }, 404);
  }

  async *#stream(spec) {
    const delta = (d) => sse({ choices: [{ index: 0, delta: d }] });
    if (spec.toolCalls) {
      let index = 0;
      for (const c of spec.toolCalls) {
        yield delta({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] });
        index++;
      }
    } else {
      const text = spec.text ?? 'OK';
      const words = text.match(/\S+\s*/g) ?? [text];
      for (let i = 0; i < words.length; i++) {
        yield delta({ content: words[i] });
        if (i === 0 && spec.gate) await spec.gate.promise;
      }
    }
    yield sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    yield sse('[DONE]');
  }
}

function bind(params = []) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
}

export class FakeBackend {
  db = new DatabaseSync(':memory:');
  provider = new FakeProvider();
  secrets = new Map();
  /** Every command the page invoked: [name, args]. */
  calls = [];
  /** Commands the agent ran through `run_command` / `review_run` (nothing is executed). */
  shellCommands = [];
  /** Files the app wrote through `fs_write` (export): absolute path -> content. */
  files = new Map();
  /** What the native "save" dialog answers (`null` = cancelled). */
  savePath = '/exports/mcode-export.json';
  #overrides = new Map();
  #fetches = new Map();
  #nextRid = 1;

  constructor() {
    this.db.exec(SCHEMA);
  }

  /** Handler override for one command: `backend.on('git_status', (args) => ...)`. */
  on(cmd, fn) { this.#overrides.set(cmd, fn); }
  callsOf(cmd) { return this.calls.filter(([c]) => c === cmd).map(([, a]) => a); }

  setting(key, value) {
    this.db.prepare('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value));
  }
  getSetting(key) {
    const row = this.db.prepare('select value from settings where key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  /** Skips onboarding: English UI, the fake provider configured and selected, no standing command allowances. */
  seedReady() {
    const cfg = { id: 'custom-fake', kind: 'custom', name: 'Fake LLM', baseUrl: FAKE_BASE_URL };
    this.setting('locale', 'en');
    this.setting('onboarded', true);
    this.setting('providers', [cfg]);
    this.setting('selection', { providerId: cfg.id, model: 'fake-model' });
    this.setting('cmdAllowlist', []);
    this.secrets.set(`provider:${cfg.id}`, '');
  }

  seedProject(name, path = null) {
    return Number(this.db.prepare('insert into projects(name, path, source_id, created_at) values(?, ?, ?, ?)').run(name, path, path ? `local:${path}` : null, Date.now()).lastInsertRowid);
  }

  /** `messages`: [role, text, meta?]. Returns the new chat and message ids. */
  seedChat(title, messages, projectId = null) {
    const now = Date.now();
    const chatId = Number(this.db.prepare('insert into chats(project_id, title, created_at, updated_at) values(?, ?, ?, ?)').run(projectId, title, now, now).lastInsertRowid);
    const messageIds = messages.map(([role, text, meta]) =>
      Number(this.db.prepare('insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)').run(chatId, role, JSON.stringify({ role, parts: [{ type: 'text', text }], meta }), now).lastInsertRowid));
    return { chatId, messageIds };
  }

  rows(sql, ...params) { return this.db.prepare(sql).all(...params).map((r) => ({ ...r })); }

  async invoke(cmd, args = {}) {
    this.calls.push([cmd, args]);
    const override = this.#overrides.get(cmd);
    if (override) return override(args);
    switch (cmd) {
      case 'db_select': return this.rows(args.sql, ...bind(args.params));
      case 'db_execute': {
        const r = this.db.prepare(args.sql).run(...bind(args.params));
        return [Number(r.changes), Number(r.lastInsertRowid)];
      }
      case 'secret_get': return this.secrets.get(args.id) ?? null;
      case 'secret_set': this.secrets.set(args.id, args.value); return null;
      case 'secret_delete': this.secrets.delete(args.id); return null;
      case 'search_messages': return this.searchMessages(args);
      case 'search_models': return [];
      case 'plugin:http|fetch': return this.httpFetch(args.clientConfig);
      case 'plugin:http|fetch_send': return this.httpSend(args.rid);
      case 'plugin:http|fetch_read_body': return this.httpRead(args.rid);
      case 'plugin:http|fetch_cancel':
      case 'plugin:http|fetch_cancel_body':
        this.#fetches.get(args.rid)?.cancel?.();
        return null;
      case 'run_command':
      case 'review_run':
        this.shellCommands.push(args.command);
        return { code: 0, output: 'ok\n', timed_out: false };
      case 'plugin:dialog|save': return this.savePath;
      case 'fs_write': {
        const path = `${args.root.replace(/\/$/, '')}/${args.path}`;
        this.files.set(path, args.content);
        return `wrote ${path}`;
      }
      case 'review_prepare': return { id: 'review-1', root: args.root, workspace: `${args.root}/.ws` };
      case 'review_list': case 'fs_files': case 'import_scan': case 'cursor_scan': case 'read_instructions': case 'import_chatgpt_scan': return [];
      case 'git_status': return { branch: 'main', files: [] };
      case 'cu_permissions': return { accessibility: true, screen: true };
      case 'cu_screen_size': return { width: 1440, height: 900 };
      case 'mcp_status': return [];
      default:
        // Plugin plumbing (window, event, opener, notification, shortcut) is accepted and ignored. Any other command the
        // fake backend does not implement answers empty, so a screen renders its empty state.
        return null;
    }
  }

  // ---- full-text search stand-in ------------------------------------------------------------------------------------
  searchMessages({ query, projectId, model, limit }) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits = [];
    const rows = this.rows(`select m.id, m.chat_id, m.role, m.content, m.created_at, c.title, c.project_id, c.archived, p.name as project_name
      from messages m join chats c on c.id = m.chat_id left join projects p on p.id = c.project_id order by m.id desc`);
    for (const r of rows) {
      if (projectId != null && r.project_id !== projectId) continue;
      const msg = JSON.parse(r.content);
      if (model && msg.meta?.model !== model) continue;
      const text = (msg.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const low = text.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      const at = low.indexOf(words[0]);
      const start = Math.max(0, at - 40);
      const snippet = text.slice(start, at) + MARK_OPEN + text.slice(at, at + words[0].length) + MARK_CLOSE + text.slice(at + words[0].length, at + 80);
      hits.push({ messageId: r.id, chatId: r.chat_id, chatTitle: r.title, projectId: r.project_id, projectName: r.project_name, archived: !!r.archived, role: r.role, model: msg.meta?.model ?? null, createdAt: r.created_at, snippet });
    }
    return hits.slice(0, limit ?? 50);
  }

  // ---- plugin-http protocol (see node_modules/@tauri-apps/plugin-http/dist-js/index.js) -------------------------------
  httpFetch(cfg) {
    const rid = this.#nextRid++;
    this.#fetches.set(rid, { cfg });
    return rid;
  }
  httpSend(rid) {
    const f = this.#fetches.get(rid);
    const body = f.cfg.data ? Buffer.from(f.cfg.data).toString('utf8') : null;
    const res = this.provider.handle(f.cfg.method, f.cfg.url, body);
    f.iter = res.chunks[Symbol.asyncIterator]();
    f.cancel = () => { f.cancelled = true; f.iter.return?.(); };
    return { status: res.status, statusText: res.status === 200 ? 'OK' : 'Error', url: f.cfg.url, headers: res.headers, rid };
  }
  /** One body chunk followed by a 0 byte, or a lone 1 byte at the end of the stream (the plugin's framing). */
  async httpRead(rid) {
    const f = this.#fetches.get(rid);
    if (f.cancelled) return [1];
    const { value, done } = await f.iter.next();
    if (done || f.cancelled) return [1];
    return [...value, 0];
  }
}
