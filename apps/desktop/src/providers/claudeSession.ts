import { applyActivity, nativeActivities, type Activity } from "./activities";
import { claudeArgs, parseClaudeEvent } from "./claudeCli";
import { resumePoint, withImagePaths } from "./cliArgs";
import { followUpPump, interrupted } from "./lifecycle";
import { openJsonProcess, type JsonLine, type JsonProcess } from "./processHost";
import { pickLevel } from "./reasoning";
import { liveSessions, sessionKey, type Lease, type ManagedSession } from "./sessionManager";
import { invocationScript, shellFor } from "./shell";
import { textOf, type Msg, type Reasoning, type TokenUsage, type TurnInput, type TurnOutput } from "./types";
import { claudeLimit, tokenUsage } from "./usage";
import { currentPlatform } from "../lib/platform";
import { createRawLogger, rawLogEnabled, type RawLogger } from "../lib/rawCliLog";

// Claude Code as a live session (T3 Code's ClaudeAdapterV2 does the same through the Agent SDK; MIT,
// github.com/pingdotgg/t3code). One `claude -p --input-format stream-json` process serves every turn of a chat while
// its launch flags stay the same (sessionManager.ts); a flag change (model, mode, access, effort, a new --add-dir)
// starts a new process that resumes the same Claude session. Protocol facts, checked against claude 2.1.292
// (tests/fixtures/claude-live-session.jsonl):
// - A turn is one stream-json user message; it ends on a `result` event, the process stays up for the next one.
//   Every model run starts with `system/init` and ends with its own `result`.
// - `--replay-user-messages` echoes each stdin user message (`isReplay`, same `uuid`) when the CLI takes it; the
//   `system/status` of a run lists the uuids it answers (`user_message_uuids`). Plain messages sent while a run is busy
//   are queued and then MERGED into one run, so counting results is wrong: a turn ends on the first `result` once every
//   message it wrote has been taken.
// - Follow-ups use `priority: "next"`: the CLI injects the message at the next tool boundary of the running run (one
//   result for both). `"now"` would abort the running tool (`terminal_reason: "aborted_tools"`) and is not used.
// - Stop sends `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`; the CLI answers with a
//   `control_response` and ends the run with `result` `error_during_execution` / `aborted_streaming`, and the process
//   takes the next message normally.
// - Background work: `system/background_tasks_changed` carries the full list of running background tasks (shells,
//   background agents); `task_started` (`is_backgrounded`) / `task_notification` are the increments. When a background
//   task ends after the turn, the CLI wakes the model on its own (`system/init` ... `result` with no user message).
// The old one-process-per-turn path in cli.ts stays as the fallback when the live process cannot start at all (a CLI
// that rejects the stream-json input flags exits before printing any JSON): see `LiveSessionUnavailable`.

/** How long Stop waits for the interrupted run's `result` before the process is killed. */
export const INTERRUPT_GRACE_MS = 5000;

/** The live process could not start (an old CLI without stream-json input): the caller runs the per-turn path. */
export class LiveSessionUnavailable extends Error {}

/** Executables that failed to start a live session in this app session; they go straight to the per-turn path. */
const unsupported = new Set<string>();
/** The attachments folder of a chat, once it was used: kept in the launch flags so later turns do not respawn. */
const attachDirs = new Map<number, string>();

/** Launch arguments of a live session. `session`: the Claude session to resume. */
export function claudeLiveArgs(o: Parameters<typeof claudeArgs>[0]): string[] {
  return [...claudeArgs(o), "--input-format", "stream-json", "--replay-user-messages"];
}

const TERMINAL_TASK = /^(completed|failed|killed|stopped|cancell?ed|error)$/i;

/** One running `claude` process (a `ManagedSession` for sessionManager.ts). */
export class ClaudeLiveSession implements ManagedSession {
  /** The Claude session id the process works on (from its events). */
  sessionId?: string;
  /** Receives every event while a turn runs. */
  sink?: (e: JsonLine) => void;
  /** Raw stdout lines go to the current turn's raw log. */
  raw?: (line: string) => void;
  /** True once the process printed any JSON (it started, so a failure is not "CLI too old"). */
  started = false;
  /** Background tasks (shells, background agents) the CLI reports as running. */
  readonly background = new Set<string>();
  /** A model run is in progress (between `system/init` and `result`). */
  running = false;

  readonly proc: JsonProcess;
  /** Launch facts: the session it resumed and the attachments folder it may read. */
  readonly o: { session?: string; addDir?: string };

  constructor(proc: JsonProcess, o: { session?: string; addDir?: string } = {}) {
    this.proc = proc;
    this.o = o;
    this.sessionId = o.session;
    proc.onMessage((e) => this.event(e));
  }

  private event(e: JsonLine) {
    this.started = true;
    if (typeof e?.session_id === "string" && e.session_id) this.sessionId = e.session_id;
    if (e?.type === "system") {
      if (e.subtype === "init") this.running = true;
      if (e.subtype === "background_tasks_changed" && Array.isArray(e.tasks)) {
        this.background.clear();
        for (const t of e.tasks) if (typeof t?.task_id === "string") this.background.add(t.task_id);
      }
      if (e.subtype === "task_started" && e.is_backgrounded && typeof e.task_id === "string")
        this.background.add(e.task_id);
      if (e.subtype === "task_notification" && typeof e.task_id === "string") this.background.delete(e.task_id);
      if (e.subtype === "task_updated" && TERMINAL_TASK.test(String(e.patch?.status ?? "")))
        this.background.delete(e.task_id);
    }
    if (e?.type === "result") this.running = false;
    this.sink?.(e);
  }

  alive() {
    return !this.proc.exited();
  }

  /** Background tasks still run, or the CLI woke the model on its own between turns. */
  backgroundWork() {
    return this.background.size > 0 || (this.running && !this.sink);
  }

  async release() {
    this.sink = undefined;
    await this.proc.stop();
  }

  /** Writes one stream-json user message; `priority: "next"` injects it into the running run. */
  send(text: string, uuid: string, priority?: "next") {
    return this.proc.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: this.sessionId ?? "",
        uuid,
        ...(priority ? { priority } : {}),
      }),
    );
  }

  interrupt(requestId: string) {
    return this.proc.write(
      JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }),
    );
  }
}

type Saved = { dir: string; files: string[] };
export type LiveContext = {
  providerId: string;
  executable: () => Promise<string>;
  levels: (model: string) => readonly Reasoning[];
  attachments: { save(chatId: number, images: string[]): Promise<Saved>; clear(chatId: number): Promise<void> };
};
export type LiveDeps = {
  sessions?: Pick<typeof liveSessions, "acquire">;
  /** Starts the process (default: the login shell, see processHost.ts). */
  open?: (o: {
    executable: string;
    args: string[];
    cwd?: string;
    onRaw: (line: string) => void;
  }) => Promise<JsonProcess>;
  rawLogger?: (chatId: number | null) => Promise<RawLogger>;
  interruptMs?: number;
  uuid?: () => string;
};

const defaultOpen: NonNullable<LiveDeps["open"]> = ({ executable, args, cwd, onRaw }) =>
  openJsonProcess(
    invocationScript(shellFor(currentPlatform()).kind, { executable, args, prependExecutableDir: true }),
    { cwd, onRaw },
  );

const addUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined =>
  !a
    ? b
    : !b
      ? a
      : {
          input: a.input + b.input,
          output: a.output + b.output,
          cached: a.cached + b.cached,
          cacheWrite: a.cacheWrite + b.cacheWrite,
          reasoning: a.reasoning + b.reasoning,
        };

/** What an older `claude` says about flags it does not know (`--input-format`, `--replay-user-messages`). */
const OLD_CLI = /unknown option|unrecognized|input-format|replay-user-messages/i;
const AUTH = /401|auth|login|unauthori[sz]ed|api key/i;
const imagesOf = (msgs: Msg[]) =>
  msgs.flatMap((m) => m.parts.flatMap((p) => (p.type === "image" && p.data ? [p.data] : [])));

/** One chat turn on a live Claude Code session. Throws `LiveSessionUnavailable` when the per-turn path must run instead. */
export async function runClaudeLiveTurn(t: TurnInput, ctx: LiveContext, deps: LiveDeps = {}): Promise<TurnOutput> {
  const chatId = t.chatId;
  if (!chatId) throw new LiveSessionUnavailable("no chat");
  if (t.signal.aborted) throw interrupted();
  const executable = await ctx.executable();
  if (unsupported.has(executable)) throw new LiveSessionUnavailable("claude does not take stream-json input");
  const sessions = deps.sessions ?? liveSessions;
  const open = deps.open ?? defaultOpen;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const point = resumePoint(t, ctx.providerId, false);
  const log = await (deps.rawLogger ?? (async (c) => createRawLogger(await rawLogEnabled(), "claude", c)))(chatId);
  const saved = point.images.length ? await ctx.attachments.save(chatId, point.images) : undefined;
  if (saved) attachDirs.set(chatId, saved.dir);
  let usedAttachments = !!saved;
  let lease: Lease<ClaudeLiveSession> | undefined;
  let broken = false;
  try {
    const flags = {
      model: t.model === "default" ? undefined : t.model,
      access: t.access ?? "auto",
      mode: t.mode,
      addDir: attachDirs.get(chatId),
      reasoning: pickLevel(t.reasoning, ctx.levels(t.model)),
    } as const;
    const signature = JSON.stringify({ executable, cwd: t.cwd ?? "", args: claudeLiveArgs(flags) });
    const key = sessionKey({ providerId: ctx.providerId, chatId, cwd: t.cwd });
    const start = async () => {
      const ref: { session?: ClaudeLiveSession } = {};
      const proc = await open({
        executable,
        args: claudeLiveArgs({ ...flags, session: point.session }),
        cwd: t.cwd,
        onRaw: (line) => ref.session?.raw?.(line),
      });
      return (ref.session = new ClaudeLiveSession(proc, { session: point.session, addDir: flags.addDir }));
    };
    lease = await sessions.acquire(key, signature, start);
    // The live process continues another Claude session than the one this history resumes (an edited or branched
    // chat, or history replayed as text): start a new process on the right one.
    if (lease.reused && lease.session.sessionId !== point.session) {
      lease.done({ broken: true });
      lease = await sessions.acquire(key, signature, start);
    }
    const s = lease.session;
    const fresh = !lease.reused;
    if (t.signal.aborted) throw interrupted();

    let text = "";
    let final = "";
    let error = "";
    let usage: TokenUsage | undefined;
    let gap = false;
    const actions = new Map<string, Activity>();
    /** Messages written in this turn that the CLI has not taken yet (uuid). */
    const pending = new Set<string>();
    let ended = false;
    let stopping = false;
    let resolveEnd!: (how: "result" | "closed") => void;
    const end = new Promise<"result" | "closed">((r) => (resolveEnd = r));
    const finish = (how: "result" | "closed") => {
      if (ended) return;
      ended = true;
      resolveEnd(how);
    };
    const emit = (d: string) => {
      if (gap && text && !text.endsWith("\n\n")) {
        const sep = text.endsWith("\n") ? "\n" : "\n\n";
        text += sep;
        t.onText(sep);
      }
      gap = false;
      text += d;
      t.onText(d);
    };
    s.raw = log.raw;
    s.sink = (e) => {
      if (ended) return;
      if (e.type === "user" && e.isReplay) {
        pending.delete(e.uuid);
        return;
      }
      if (e.type === "system" && e.subtype === "status" && Array.isArray(e.user_message_uuids))
        for (const id of e.user_message_uuids) pending.delete(id);
      if (e.type === "control_response") return;
      const limit = claudeLimit(e);
      if (limit) t.onLimits?.([limit]);
      const ev = parseClaudeEvent(e);
      if (ev.text) emit(ev.text);
      for (const a of nativeActivities("claude", e, log.unmapped)) t.onActivity?.(applyActivity(actions, a));
      if (e.type !== "result") return;
      usage = addUsage(usage, tokenUsage(e.usage, true));
      if (ev.final) final = ev.final;
      // A run ended; the turn goes on while a message it wrote is still queued in the CLI (it starts another run).
      if (stopping || !pending.size) {
        error = stopping ? "" : (ev.error ?? "");
        finish("result");
      } else gap = true;
    };
    void s.proc.closed.then(() => finish("closed"));
    if (!s.alive()) finish("closed");

    const prompt = saved ? withImagePaths(point.prompt, saved.files) : point.prompt;
    const first = uuid();
    pending.add(first);
    await s.send(prompt, first).catch(() => finish("closed"));

    // Follow-ups go into the running turn. Images need the attachments folder in the launch flags: without it the
    // message waits and becomes the next turn (which starts a process with the folder).
    const closePump = followUpPump(t.followUp, async (msgs) => {
      if (ended || stopping || !s.alive()) return false;
      const images = imagesOf(msgs);
      if (images.length && !s.o.addDir) return false;
      usedAttachments ||= images.length > 0;
      const files = images.length ? (await ctx.attachments.save(chatId, images)).files : [];
      if (ended || stopping || !s.alive()) return false;
      const id = uuid();
      pending.add(id);
      await s.send(withImagePaths(msgs.map(textOf).join("\n\n"), files), id, "next");
      return true;
    });

    // Stop: ask the CLI to end the run first; the session stays usable when it does so in time.
    let stopped: Promise<void> | undefined;
    const onAbort = () => {
      if (ended || stopping) return;
      stopping = true;
      stopped = (async () => {
        void s.interrupt(`interrupt-${uuid()}`).catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">(
          (r) => (timer = setTimeout(() => r("late"), deps.interruptMs ?? INTERRUPT_GRACE_MS)),
        );
        const how = await Promise.race([end, late]);
        clearTimeout(timer);
        if (how === "late") {
          broken = true;
          finish("closed");
          await s.proc.stop();
        }
      })();
    };
    t.signal.addEventListener("abort", onAbort, { once: true });
    if (t.signal.aborted) onAbort();

    let how: "result" | "closed";
    try {
      how = await end;
      await stopped;
    } finally {
      t.signal.removeEventListener("abort", onAbort);
      await closePump();
      s.sink = undefined;
      s.raw = undefined;
    }
    const parts = () => [
      ...[...actions.values()].map((a) => (a.status === "running" ? { ...a, status: "unknown" as const } : a)),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    if (t.signal.aborted || stopping) {
      // A message the CLI still holds would run on its own after the stop: such a session is not reused.
      if (pending.size || how === "closed") broken = true;
      throw interrupted({ parts: parts(), responseId: s.sessionId, usage });
    }
    if (how === "closed") {
      broken = true;
      const code = await s.proc.closed;
      if (fresh && !s.started) {
        // Nothing was printed: the per-turn path runs this turn (and reports its own error if the CLI is broken). Only
        // a CLI that rejects the live-session flags is remembered, so a one-off start failure is retried next turn.
        const why = s.proc.stderr().trim().slice(-600);
        if (OLD_CLI.test(why)) unsupported.add(executable);
        throw new LiveSessionUnavailable(why || `claude exited with ${code}`);
      }
      error = s.proc.stderr().trim().slice(-600) || `Claude Code exited with ${code ?? "no code"} during the turn`;
    }
    if (error) {
      if (AUTH.test(error)) broken = true;
      throw new Error(AUTH.test(error) ? `${error}\n\nClaude Code: claude auth login` : error);
    }
    if (!text.trim() && final) emit(final);
    return { parts: parts(), responseId: s.sessionId, usage };
  } finally {
    lease?.done({ broken });
    await log.flush();
    if (usedAttachments) await ctx.attachments.clear(chatId).catch(() => {});
  }
}

/** Test hook: forget which executables could not start a live session. */
export function resetLiveSupport() {
  unsupported.clear();
  attachDirs.clear();
}
