// Stand-in for @tauri-apps/plugin-shell in Node tests (wired in hooks.mjs): `Command` hands every execute / spawn to
// `shell.handler`, which a test sets; without one it fails like the real plugin does outside Tauri. `fakeProcess` is a
// scripted child for `spawn`: the test writes stdout lines and decides when it exits. `installSignals` routes the
// `process_signal_tree` command (processHost.signalTree) to the fake child, so a graceful stop reaches it as SIGTERM.

export const shell = {
  /** { execute?(cmd) => { code, stdout, stderr }, spawn?(cmd) => FakeProcess } */
  handler: null,
  /** Every Command spawned, in order: { script, options }. */
  spawned: [],
};

class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, cb) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
    return this;
  }
  emit(event, ...args) {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

export class Command extends Emitter {
  static create(program, args = [], options = {}) {
    return new Command(program, args, options);
  }
  constructor(program, args, options) {
    super();
    this.program = program;
    this.args = args;
    this.options = options;
    /** The script run by the login shell (`zsh -lc <script>`). */
    this.script = args.at(-1);
    this.stdout = new Emitter();
    this.stderr = new Emitter();
  }
  async execute() {
    if (!shell.handler?.execute) throw new Error('shell stub: no execute handler');
    return shell.handler.execute(this);
  }
  async spawn() {
    if (!shell.handler?.spawn) throw new Error('shell stub: no spawn handler');
    shell.spawned.push({ script: this.script, options: this.options });
    const proc = shell.handler.spawn(this);
    proc.attach(this);
    return proc.child;
  }
}

let nextPid = 40_000;
const byPid = new Map();

/** A scripted child process. `onTerm`: what SIGTERM does (default: exit 143 at once). */
export function fakeProcess(o = {}) {
  let cmd;
  let gone = false;
  const p = {
    pid: nextPid++,
    signals: [],
    stdin: [],
    attach(c) {
      cmd = c;
    },
    line(obj) {
      if (!gone) cmd.stdout.emit('data', JSON.stringify(obj) + '\n');
    },
    exit(code = 0) {
      if (gone) return;
      gone = true;
      byPid.delete(p.pid);
      cmd.emit('close', { code, signal: null });
    },
    signal(sig) {
      p.signals.push(sig);
      if (sig === 'kill') return p.exit(137);
      (o.onTerm ?? (() => p.exit(143)))(p);
    },
    exited: () => gone,
    child: {
      pid: 0,
      write: async (data) => void p.stdin.push(String(data)),
      kill: async () => p.exit(137),
    },
  };
  p.child.pid = p.pid;
  byPid.set(p.pid, p);
  return p;
}

/** Routes processHost's Tauri commands to the fake processes (window.__TAURI_INTERNALS__ for @tauri-apps/api/core). */
export function installSignals() {
  globalThis.window ??= {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'process_signal_tree') byPid.get(args.pid)?.signal(args.signal);
      // @tauri-apps/api/path (resolveResource): a fixed folder.
      if (cmd.startsWith('plugin:path|')) return `/stub/resources/${args?.path ?? ''}`;
      return null;
    },
    transformCallback: () => 0,
  };
}
