// Live agent sessions that outlive a turn (Claude Code with stream-json input, Codex app-server). One session per
// key (provider + chat + folder); the next turn reuses it while its launch signature (model, access, effort...) is
// the same, otherwise it is replaced and the new process resumes the native thread. An idle session is released
// after `IDLE_MS`; work still running in the background (subagents, background shells) defers that, up to
// `MAX_PIN_MS`. A generation counter keeps a stale idle timer from releasing a session that was used again.
// Modelled on T3 Code's ProviderSessionManager (MIT, apps/server/src/orchestration-v2/ProviderSessionManager.ts).

export type ReleaseReason = "idle" | "error" | "replaced" | "manual" | "shutdown";

export interface ManagedSession {
  /** Ends the session and its process tree. Must be safe to call twice. */
  release(reason: ReleaseReason): Promise<void>;
  /** False once the process is gone. */
  alive(): boolean;
  /** True while the agent still runs work after its turn (keeps the session from being released as idle). */
  backgroundWork?(): boolean;
}

export const IDLE_MS = 30 * 60_000;
export const MAX_PIN_MS = 4 * 60 * 60_000;
const RECHECK_MS = 60_000;

type Entry = {
  session: ManagedSession;
  signature: string;
  busy: boolean;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  pinnedSince?: number;
};

export type Lease<S> = {
  session: S;
  /** True when this turn got a session that already served earlier turns. */
  reused: boolean;
  /** The turn is over. `broken`: the session must not serve another turn (released now). */
  done(o?: { broken?: boolean }): void;
};

export function createSessionManager(o: { idleMs?: number; maxPinMs?: number; now?: () => number } = {}) {
  const idleMs = o.idleMs ?? IDLE_MS;
  const maxPinMs = o.maxPinMs ?? MAX_PIN_MS;
  const now = o.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const locks = new Map<string, Promise<unknown>>();

  const drop = (key: string, e: Entry, reason: ReleaseReason) => {
    clearTimeout(e.timer);
    if (entries.get(key) === e) entries.delete(key);
    return e.session.release(reason).catch(() => {});
  };

  const scheduleIdle = (key: string, e: Entry, wait: number) => {
    clearTimeout(e.timer);
    const generation = e.generation;
    e.timer = setTimeout(() => {
      if (entries.get(key) !== e || e.busy || e.generation !== generation) return;
      if (e.session.backgroundWork?.()) {
        e.pinnedSince ??= now();
        if (now() - e.pinnedSince < maxPinMs) return scheduleIdle(key, e, RECHECK_MS);
      }
      void drop(key, e, "idle");
    }, wait);
  };

  /** Runs `fn` with the per-key lock held, so two turns never open the same session at once. */
  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    locks.set(key, run);
    try {
      return await run;
    } finally {
      if (locks.get(key) === run) locks.delete(key);
    }
  }

  return {
    /** A session for one turn: the live one when it is idle, alive and launched the same way, otherwise a new one. */
    acquire<S extends ManagedSession>(key: string, signature: string, open: () => Promise<S>): Promise<Lease<S>> {
      return locked(key, async () => {
        const old = entries.get(key);
        let reused = false;
        let e: Entry;
        if (old && !old.busy && old.session.alive() && old.signature === signature) {
          e = old;
          reused = true;
        } else {
          if (old) await drop(key, old, old.session.alive() ? "replaced" : "error");
          e = { session: await open(), signature, busy: false, generation: 0 };
          entries.set(key, e);
        }
        clearTimeout(e.timer);
        e.busy = true;
        e.generation++;
        e.pinnedSince = undefined;
        let finished = false;
        return {
          session: e.session as S,
          reused,
          done(d = {}) {
            if (finished) return;
            finished = true;
            e.busy = false;
            if (d.broken || !e.session.alive()) void drop(key, e, "error");
            else scheduleIdle(key, e, idleMs);
          },
        };
      });
    },
    /** Releases one session (chat deleted, "Restart agent session"). */
    release(key: string, reason: ReleaseReason = "manual") {
      const e = entries.get(key);
      return e ? drop(key, e, reason) : Promise.resolve();
    },
    /** Releases every session whose key starts with `prefix` (all sessions of a chat). */
    releaseMatching(prefix: string, reason: ReleaseReason = "manual") {
      return Promise.all([...entries].filter(([k]) => k.startsWith(prefix)).map(([k, e]) => drop(k, e, reason)));
    },
    /** App quit: everything goes. */
    releaseAll(reason: ReleaseReason = "shutdown") {
      return Promise.all([...entries].map(([k, e]) => drop(k, e, reason)));
    },
    size: () => entries.size,
  };
}

/** The app's live sessions. */
export const liveSessions = createSessionManager();

/** Key of a chat's session with one provider in one folder. */
export const sessionKey = (o: { providerId: string; chatId?: number; cwd?: string }) =>
  `chat:${o.chatId ?? "none"}|${o.providerId}|${o.cwd ?? ""}`;
