// Stand-in for src/lib/api.ts in Node tests: settings in memory, file tools on a real temporary folder, git through the
// real `git` binary with a shadow repo laid out like src-tauri/src/git.rs does. Commands are recorded, never executed.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const state = {
  settings: new Map(),
  instructionFiles: [],
  /** Commands the agent asked to run: { root, command }. */
  runs: [],
  runResult: { code: 0, output: 'ran', timed_out: false },
  /** (id, path) => diff text for the review panel; empty string = nothing pending. */
  reviewDiff: () => '',
  shadows: mkdtempSync(join(tmpdir(), 'apistub-shadow-')),
  reset() {
    this.settings.clear();
    this.instructionFiles = [];
    this.runs.length = 0;
    this.runResult = { code: 0, output: 'ran', timed_out: false };
    this.reviewDiff = () => '';
  },
};

const confine = (root, rel) => {
  const parts = String(rel).split('/').filter((p) => p && p !== '.');
  if (String(rel).startsWith('/') || parts.includes('..') || !parts.length && rel !== '.') throw new Error(`path escapes project: ${rel}`);
  return join(root, ...parts);
};

export const getSetting = async (key, fallback) => (state.settings.has(key) ? JSON.parse(state.settings.get(key)) : fallback);
export const setSetting = async (key, value) => void state.settings.set(key, JSON.stringify(value));
export const db = { select: async () => [], exec: async () => ({ changes: 0, lastId: 0 }) };
export const secrets = { set: async () => {}, get: async () => null, delete: async () => {} };
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
  run: async (root, command) => {
    state.runs.push({ root, command });
    return state.runResult;
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
  execute: async () => ({ png: '', width: 1, height: 1 }),
  screenSize: async () => ({ width: 1, height: 1 }),
  permissions: async () => ({ accessibility: true, screen: true }),
};
