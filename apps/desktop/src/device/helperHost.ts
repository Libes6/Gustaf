// A client for the long-lived helper host (hostScript.ts): one process answers every helper call over JSON lines, so a
// call no longer pays for starting `node agent-device.mjs`. The transport is injected (the real one is an
// openJsonProcess process, see hostProcess.ts), so framing, ordering, crashes and timeouts are tested with fakes.
//
// Contract with the driver: `call` either returns the helper's reply as the CLI's `--json` text, says `unsupported`
// (the command is not mapped: run the CLI), or throws a HostError. A HostError says whether the request may have
// reached the helper (`dispatched`), because a mutating call must not be replayed through the CLI after a crash.

export type HostTransport = {
  write(line: string): Promise<void>;
  onMessage(cb: (m: unknown) => void): void;
  /** Resolves when the process is gone. */
  closed: Promise<unknown>;
  stop(): Promise<void>;
};

export type HostErrorCode = "host-unavailable" | "host-crashed" | "host-timeout";

export class HostError extends Error {
  readonly code: HostErrorCode;
  /** The request was written to the host: the helper may have performed it. */
  readonly dispatched: boolean;
  constructor(message: string, code: HostErrorCode, dispatched: boolean) {
    super(message);
    this.code = code;
    this.dispatched = dispatched;
  }
}

export type HostResult = { unsupported: false; reply: string } | { unsupported: true };

export type HelperHost = {
  call(argv: string[], timeoutMs: number): Promise<HostResult>;
  /** False once the host failed too often: callers use the CLI. */
  readonly available: boolean;
  close(): Promise<void>;
};

export type HelperHostOptions = {
  spawn: () => Promise<HostTransport>;
  /** How long a starting host may take to say `ready`. Default 15 s. */
  readyTimeoutMs?: number;
  /** Starts that failed or crashed before the host is given up on. Default 3. */
  maxFailures?: number;
};

type Pending = { resolve: (r: HostResult) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Live = { transport: HostTransport; pending: Map<number, Pending>; dead: boolean };

export function createHelperHost(o: HelperHostOptions): HelperHost {
  const maxFailures = o.maxFailures ?? 3;
  let failures = 0;
  let nextId = 1;
  let live: Live | undefined;
  let starting: Promise<Live> | undefined;
  let closed = false;

  const failAll = (l: Live, why: string) => {
    l.dead = true;
    if (live === l) live = undefined;
    for (const [id, p] of l.pending) {
      clearTimeout(p.timer);
      p.reject(new HostError(why, "host-crashed", true));
      l.pending.delete(id);
    }
  };

  async function start(): Promise<Live> {
    let transport: HostTransport;
    try {
      transport = await o.spawn();
    } catch (e) {
      failures++;
      throw new HostError(
        `The helper host did not start: ${e instanceof Error ? e.message : String(e)}`,
        "host-unavailable",
        false,
      );
    }
    const l: Live = { transport, pending: new Map(), dead: false };
    let ready!: () => void;
    const readyP = new Promise<void>((r) => (ready = r));
    transport.onMessage((m) => {
      if (!m || typeof m !== "object") return;
      const msg = m as { ready?: boolean; id?: unknown; reply?: unknown; unsupported?: boolean };
      if (msg.ready) return ready();
      if (typeof msg.id !== "number") return;
      const p = l.pending.get(msg.id);
      if (!p) return; // a late answer to a call that already timed out
      l.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.unsupported) p.resolve({ unsupported: true });
      else if (msg.reply !== undefined) p.resolve({ unsupported: false, reply: JSON.stringify(msg.reply) });
      else p.reject(new HostError("The helper host sent an empty answer.", "host-crashed", true));
    });
    void transport.closed.then(() => {
      if (!l.dead) {
        if (l.pending.size || !readyDone) failures++;
        failAll(l, "The helper host stopped.");
      }
    });
    let readyDone = false;
    const timeout = new Promise<"late">((r) => setTimeout(() => r("late"), o.readyTimeoutMs ?? 15_000));
    const first = await Promise.race([
      readyP.then(() => "ready" as const),
      transport.closed.then(() => "closed" as const),
      timeout,
    ]);
    if (first !== "ready") {
      failures++;
      l.dead = true;
      void transport.stop().catch(() => undefined);
      throw new HostError(
        first === "late" ? "The helper host did not become ready." : "The helper host stopped while starting.",
        "host-unavailable",
        false,
      );
    }
    readyDone = true;
    failures = 0;
    return l;
  }

  async function ensure(): Promise<Live> {
    if (closed || failures >= maxFailures)
      throw new HostError("The helper host is not available.", "host-unavailable", false);
    if (live && !live.dead) return live;
    starting ??= start()
      .then((l) => (live = l))
      .finally(() => {
        starting = undefined;
      });
    return starting;
  }

  return {
    get available() {
      return !closed && failures < maxFailures;
    },
    async call(argv, timeoutMs) {
      const l = await ensure();
      const id = nextId++;
      return new Promise<HostResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          l.pending.delete(id);
          reject(new HostError("The helper did not answer in time.", "host-timeout", true));
        }, timeoutMs);
        l.pending.set(id, { resolve, reject, timer });
        // Lines are written in call order, so the helper sees input exactly in the order it was given.
        l.transport.write(JSON.stringify({ id, argv })).catch((e) => {
          clearTimeout(timer);
          l.pending.delete(id);
          failures++;
          reject(new HostError(`Could not write to the helper host: ${String(e)}`, "host-crashed", false));
        });
      });
    },
    async close() {
      closed = true;
      const l = live;
      if (l) {
        failAll(l, "The helper host was closed.");
        await l.transport.stop().catch(() => undefined);
      }
    },
  };
}
