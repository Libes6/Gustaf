import { Command } from "@tauri-apps/plugin-shell";
import { currentPlatform } from "../lib/platform";
import { shellFor } from "./shell";

// Every agent process (CLI turn, live session, sidecar) is started here, so all of them share one way to read JSON
// lines, one stop path and one record of what is running. Stop is graceful first (SIGTERM to the whole tree, or
// `taskkill /T` without /F on Windows), then forced after a grace period; the tree is always included, so commands an
// agent started (a dev server, a test watcher) end with it. Each pid is written to the Rust process ledger
// (src-tauri/src/proc_ledger.rs) so the app kills leftovers on quit and after a crash (next start).

/** Runs a script in the OS shell (zsh on macOS, bash on Linux, PowerShell on Windows; see shell.ts). */
export function shellCommand(script: string, options?: Parameters<typeof Command.create>[2]) {
  const sh = shellFor(currentPlatform());
  return Command.create(sh.name, sh.args(script), options);
}

async function invokeQuiet(cmd: string, args: Record<string, unknown>) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd, args);
  } catch {
    /* outside Tauri (tests) or an older backend: the plain kill still ends the process itself */
  }
}

/** Signals `pid` and everything below it (src-tauri/src/proc_tree.rs); never throws. */
export const signalTree = (pid: number, signal: "term" | "kill") => invokeQuiet("process_signal_tree", { pid, signal });

/** A parsed stdout line: its shape is the agent's own protocol, checked by each adapter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonLine = any;

export type JsonProcess = {
  pid: number;
  /** Writes one line (a newline is added). */
  write(line: string): Promise<void>;
  /** Parsed JSON objects from stdout; lines that arrived before the listener was set are replayed to it. */
  onMessage(cb: (m: JsonLine) => void): void;
  /** Resolves with the exit code once the process is gone and its last line was delivered. */
  closed: Promise<number | null>;
  exited(): boolean;
  /** The last 4000 characters of stderr. */
  stderr(): string;
  /** Graceful stop of the whole tree: SIGTERM, then SIGKILL after `graceMs` (default 2000). Resolves when it is gone. */
  stop(graceMs?: number): Promise<void>;
};

export type OpenOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to stdin right after the start. */
  stdin?: string;
  /** Every non-empty stdout line, before it is parsed (raw CLI log). */
  onRaw?: (line: string) => void;
};

const live = new Set<JsonProcess>();

/** Starts a login-shell script whose stdout is JSON lines. */
export async function openJsonProcess(script: string, o: OpenOptions = {}): Promise<JsonProcess> {
  const cmd = shellCommand(script, { cwd: o.cwd, ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}) });
  let listener: ((m: JsonLine) => void) | undefined;
  const queued: JsonLine[] = [];
  let buf = "";
  let stderr = "";
  let gone = false;
  const line = (raw: string) => {
    raw = raw.trim();
    if (!raw) return;
    try {
      o.onRaw?.(raw);
    } catch {
      /* debugging aid only */
    }
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return; // banners and warnings
    }
    if (!m || typeof m !== "object") return;
    if (listener) listener(m);
    else queued.push(m);
  };
  const closed = new Promise<number | null>((resolve) =>
    cmd.on("close", (e) => {
      line(buf);
      buf = "";
      gone = true;
      resolve(e.code);
    }),
  );
  cmd.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  cmd.stderr.on("data", (s: string) => {
    stderr = (stderr + s).slice(-4000);
  });
  const child = await cmd.spawn();
  void invokeQuiet("process_ledger_add", { pid: child.pid });
  let stopping: Promise<void> | undefined;
  const proc: JsonProcess = {
    pid: child.pid,
    write: (l) => child.write(l + "\n"),
    onMessage(cb) {
      listener = cb;
      for (const m of queued.splice(0)) cb(m);
    },
    closed,
    exited: () => gone,
    stderr: () => stderr,
    stop(graceMs = 2000) {
      return (stopping ??= (async () => {
        if (!gone) {
          await signalTree(child.pid, "term");
          const timer = new Promise<"late">((r) => setTimeout(() => r("late"), graceMs));
          if ((await Promise.race([closed, timer])) === "late") {
            await signalTree(child.pid, "kill");
            await child.kill().catch(() => {});
            await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
          } else {
            // The root ended in time; descendants that ignored SIGTERM (a dev server trapping it) are killed now, before
            // the ledger forgets the tree.
            await signalTree(child.pid, "kill");
          }
        }
      })());
    },
  };
  live.add(proc);
  void closed.then(async () => {
    live.delete(proc);
    // A stop in progress still kills the tree's leftovers by the recorded members; only then is the pid forgotten.
    await stopping;
    void invokeQuiet("process_ledger_remove", { pid: child.pid });
  });
  if (o.stdin != null) await child.write(o.stdin);
  return proc;
}

/** Stops every agent process this window started (app quit, window reload). */
export async function stopAllProcesses(graceMs = 1500) {
  await Promise.all([...live].map((p) => p.stop(graceMs)));
}

/**
 * One process per turn: runs the script, feeds each stdout JSON line to `onLine` and resolves with the exit code.
 * On abort the tree is stopped gracefully. `terminal(e)`: the event that ends the turn; a CLI that is still alive
 * `settleMs` (default 5000) after it is stopped, so a background shell or a hung MCP server cannot keep the turn open.
 */
export async function spawnLines(
  script: string,
  onLine: (e: JsonLine) => void,
  o: OpenOptions & {
    signal?: AbortSignal;
    /** Kept for callers of the old API; the tree is always stopped now. */ killTree?: boolean;
    terminal?: (e: JsonLine) => boolean;
    settleMs?: number;
    /** Grace between SIGTERM and SIGKILL on abort (default 2000). */ graceMs?: number;
  } = {},
) {
  if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const proc = await openJsonProcess(script, o);
  let settle: ReturnType<typeof setTimeout> | undefined;
  proc.onMessage((e) => {
    onLine(e);
    if (!settle && o.terminal?.(e)) settle = setTimeout(() => void proc.stop(), o.settleMs ?? 5000);
  });
  const stop = () => void proc.stop(o.graceMs);
  o.signal?.addEventListener("abort", stop, { once: true });
  if (o.signal?.aborted) stop();
  try {
    const code = await proc.closed;
    return { code, stderr: proc.stderr(), settled: !!settle };
  } finally {
    clearTimeout(settle);
    o.signal?.removeEventListener("abort", stop);
  }
}
