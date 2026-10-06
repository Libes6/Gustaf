import { resolveKey, type KeySource } from "../lib/keys";
import { nativeActivities, applyActivity, isBareCollabWait, type Activity } from "./activities";
import { createRolloutTracker, rolloutEnabled } from "./codexRollout";
import { claudeArgs, parseClaudeEvent } from "./claudeCli";
import { cursorAccountEnv } from "./cursorAccounts";
import { resolveResource } from "@tauri-apps/api/path";
declare const __SIDECAR__: string;
import { codexArgs, cursorArgs, resumePoint, withImagePaths } from "./cliArgs";
import { claudeCliLevels, codexLevels, cursorLevels, pickLevel } from "./reasoning";
import { attachments, cursorProfiles } from "../lib/api";
import { tokenUsage, claudeLimit } from "./usage";
import { createRawLogger, rawLogEnabled } from "../lib/rawCliLog";
import { Command } from "@tauri-apps/plugin-shell";
import { currentPlatform } from "../lib/platform";
import { detectScript, findCliScript, invocationScript, shellFor, type CliName, type Invocation } from "./shell";
import type { Adapter, CliId, ProviderConfig, Reasoning, TurnInput } from "./types";

export { shq } from "./shell";

/** Runs a script in the OS shell (zsh on macOS, bash on Linux, PowerShell on Windows; see shell.ts). */
export function shellCommand(script: string, options?: Parameters<typeof Command.create>[2]) {
  const sh = shellFor(currentPlatform());
  return Command.create(sh.name, sh.args(script), options);
}

/** Script running `executable` with the platform's quoting (see `invocationScript`). */
export const runScript = (inv: Invocation) => invocationScript(shellFor(currentPlatform()).kind, inv);

const findScript = (id: CliName, verify = false) => findCliScript(currentPlatform(), id, verify);

let codexPath: Promise<string> | undefined;
export function codexExecutable() {
  return codexPath ??= (async () => {
    const probe = await shellCommand(findScript("codex", true)).execute();
    if (probe.code !== 0 || !probe.stdout.trim()) throw new Error("Codex CLI is unavailable");
    return probe.stdout.trim();
  })().catch((e) => {
    // Not remembered: Codex installed (or logged in) after a failed probe must work without restarting the app.
    codexPath = undefined;
    throw e;
  });
}

export async function cursorExecutable() {
  const probe = await shellCommand(findScript("cursor-agent")).execute();
  if (probe.code || !probe.stdout.trim()) throw new Error('Cursor CLI is unavailable.');
  return probe.stdout.trim();
}

async function claudeExecutable() {
  const probe = await shellCommand(findScript("claude")).execute();
  if (!probe.stdout.trim()) throw new Error('Claude CLI is unavailable. Install Claude Code and run claude auth login.');
  return probe.stdout.trim();
}

/** Kills a child process and everything below it (src-tauri/src/proc_tree.rs); never throws. */
async function killProcessTree(pid: number) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("process_kill_tree", { pid });
  } catch { /* the plain kill that follows still ends the process itself */ }
}

/** Runs a login-shell script and feeds each stdout JSON line to onLine; non-JSON lines are skipped. */
export async function spawnLines(
  script: string,
  onLine: (e: any) => void,
  o: { signal?: AbortSignal; cwd?: string; stdin?: string; env?: Record<string, string>; /** Every non-empty stdout line, before it is parsed. */ onRaw?: (line: string) => void; /** On abort kill the whole process tree, not only the child. */ killTree?: boolean } = {},
) {
  if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cmd = shellCommand(script, { cwd: o.cwd, ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}) });
  let buf = "";
  let stderr = "";
  const line = (s: string) => {
    s = s.trim();
    if (!s) return;
    try { o.onRaw?.(s); } catch { /* debugging aid only */ }
    try {
      onLine(JSON.parse(s));
    } catch {
      /* banners and warnings */
    }
  };
  const done = new Promise<number | null>((resolve) => cmd.on("close", (e) => resolve(e.code)));
  cmd.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  cmd.stderr.on("data", (s: string) => (stderr += s));
  const child = await cmd.spawn();
  const kill = () => { void (o.killTree ? killProcessTree(child.pid) : Promise.resolve()).then(() => child.kill()).catch(() => {}); };
  o.signal?.addEventListener("abort", kill, { once: true });
  if (o.signal?.aborted) kill();
  if (o.stdin != null) await child.write(o.stdin);
  let code: number | null;
  try { code = await done; } finally { o.signal?.removeEventListener("abort", kill); }
  line(buf);
  return { code, stderr };
}

export { resumePoint } from "./cliArgs";

async function listCodexModels() {
  const script = import.meta.env.DEV ? __SIDECAR__.replace(/cursor-agent\.mjs$/, 'codex-limits.mjs') : await resolveResource('sidecar/codex-limits.mjs');
  const executable = await codexExecutable();
  let models: { id: string; name: string }[] = [];
  let error = '';
  const result = await spawnLines(runScript({ executable: "node", args: [script, "--models"], env: { GUSTAF_CODEX_BINARY: executable } }), e => {
    if (e.type === 'models') models = e.result;
    if (e.type === 'error') error = e.message;
  });
  if (error || result.code || !models.length) throw new Error(error || 'Codex did not return available models.');
  return [{ id: 'default', name: 'Default' }, ...models.filter(m => m.id !== 'default')];
}

type Ev = { text?: string; session?: string; final?: string; error?: string };
type Spec = {
  name: string;
  models: string[] | (() => Promise<{ id: string; name: string }[]>);
  /** `images`: absolute attachment paths for this turn; `attachDir`: the folder holding them. */
  args(o: { model?: string; session?: string; access: TurnInput["access"]; mode?: TurnInput["mode"]; images?: string[]; attachDir?: string; reasoning?: Reasoning }): string[];
  /** Effort levels the CLI can pass for this model (providers/reasoning.ts); `listed`: ids of the provider's model list. */
  levels(model: string, listed?: readonly string[]): readonly Reasoning[];
  /** True when the CLI takes images as flags; otherwise the paths go into the prompt. */
  imageFlag?: boolean;
  parse(e: any): Ev;
  loginHint: string;
};

// ponytail: event shapes checked against claude 2.1 and cursor-agent 2026.08; codex exec --json follows its docs and is untested here.
const SPECS: Record<CliId, Spec> = {
  claude: {
    name: "Claude Code",
    models: ["default", "opus", "sonnet", "haiku"],
    args: ({ attachDir, ...o }) => claudeArgs({ ...o, addDir: attachDir }),
    levels: claudeCliLevels,
    parse: parseClaudeEvent,
    loginHint: "claude auth login",
  },
  "cursor-agent": {
    name: "Cursor Agent",
    models: async () => {
      const out: { id: string; name: string }[] = [];
      const cmd = await shellCommand("cursor-agent --list-models").execute();
      for (const l of cmd.stdout.split("\n")) {
        const m = /^(\S+) - (.+?)(?: \((?:current|default)\))?$/.exec(l.trim());
        if (m) out.push({ id: m[1], name: m[2] });
      }
      if (!out.length) throw new Error(cmd.stderr || cmd.stdout || "cursor-agent --list-models: empty");
      return out;
    },
    args: cursorArgs,
    levels: cursorLevels,
    parse: (e) => {
      // With --stream-partial-output the deltas carry timestamp_ms; the aggregate repeats without it.
      if (e.type === "assistant" && e.timestamp_ms) return { text: (e.message?.content ?? []).map((c: any) => c.text ?? "").join(""), session: e.session_id };
      if (e.type === "result") return { session: e.session_id, final: e.result, error: e.is_error ? String(e.result) : undefined };
      return { session: e.session_id };
    },
    loginHint: "cursor-agent login",
  },
  codex: {
    name: "Codex",
    models: listCodexModels,
    args: codexArgs,
    levels: codexLevels,
    imageFlag: true,
    parse: (e) => {
      if (e.type === "thread.started") return { session: e.thread_id };
      const it = e.item;
      if (e.type === "item.completed" && it?.type === "agent_message") return { text: it.text + "\n\n" };
      if (e.type === "turn.failed" || e.type === "error") return { error: e.error?.message ?? e.message };
      return {};
    },
    loginHint: "codex login",
  },
};

export const cliName = (id: CliId) => SPECS[id].name;

/** CLIs that are on the login-shell PATH and actually start (`--version` succeeds). */
export async function detectClis(): Promise<{ id: CliId; version: string }[]> {
  const ids = Object.keys(SPECS) as CliId[];
  const out = await shellCommand(detectScript(currentPlatform(), ids)).execute();
  return out.stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, "").split("\t"))
    .filter(([id]) => ids.includes(id as CliId))
    .map(([id, version]) => ({ id: id as CliId, version: (version ?? "").trim() }));
}

/** An installed agent CLI: it runs its own tools and auth in the project folder; we relay text and tool activity. */
export function cliAdapter(cfg: ProviderConfig, key: KeySource = ""): Adapter {
  // Only Cursor API-key accounts need the key; other CLIs keep their own auth and never touch the Keychain.
  const accountKey = async () => (cfg.cliAuth === "key" ? resolveKey(key) : "");
  const id = cfg.cli!;
  const spec = SPECS[id];
  // The provider's model ids (from the last listing or from the UI): Cursor decides effort support by its siblings.
  let listed: string[] | undefined;
  return {
    supportsComputer: false,
    supportsReasoning: (model) => spec.levels(model, listed).length > 0,
    reasoningLevels: (model, ids) => {
      if (ids) listed = [...ids];
      return spec.levels(model, listed);
    },

    async listModels() {
      if (id === 'cursor-agent') {
        const executable = await cursorExecutable();
        const env = cursorAccountEnv(cfg, await accountKey(), cfg.cliProfile ? await cursorProfiles.dir(cfg.cliProfile) : undefined);
        const cmd = await shellCommand(runScript({ executable, args: ["--list-models"] }), Object.keys(env).length ? { env } : {}).execute();
        const models = cmd.stdout.split('\n').flatMap(l => {
          const m = /^(\S+) - (.+?)(?: \((?:current|default)\))?$/.exec(l.trim());
          return m ? [{ id: m[1], name: m[2], providerId: cfg.id, created: 0, tools: true, images: true }] : [];
        });
        if (cmd.code || !models.length) throw new Error(cmd.stderr || 'Cursor did not return models.');
        listed = models.map((m) => m.id);
        return models;
      }
      const list = typeof spec.models === "function" ? await spec.models() : spec.models.map((id) => ({ id, name: id }));
      return list.map((m) => ({ ...m, providerId: cfg.id, created: 0, tools: true, images: true }));
    },

    async turn(t: TurnInput) {
      const point = resumePoint(t, cfg.id, false);
      const log = createRawLogger(await rawLogEnabled(), id, t.chatId ?? null);
      let session = point.session;
      // Attached images go to disk for the CLI to read; they are removed when the turn ends (also on error or stop).
      const saved = point.images.length && t.chatId ? await attachments.save(t.chatId, point.images) : undefined;
      try {
      const args = spec.args({ model: t.model === "default" ? undefined : t.model, session, access: t.access ?? "auto", mode: t.mode, images: saved?.files, attachDir: saved?.dir, reasoning: pickLevel(t.reasoning, spec.levels(t.model, listed)) });
      const prompt = saved && !spec.imageFlag ? withImagePaths(point.prompt, saved.files) : point.prompt;
      let text = "";
      const actions = new Map<string, Activity>();
      let final = "";
      let usage: ReturnType<typeof tokenUsage>;
      let error = "";
      const emit = (s: string) => {
        text += s;
        t.onText(s);
      };
      const executable = id === "codex" ? await codexExecutable() : id === "cursor-agent" ? await cursorExecutable() : await claudeExecutable();
      // Codex does not report its subagents on stdout: read them from its rollout files while the turn runs (codexRollout.ts).
      const rollout = id === "codex" && (await rolloutEnabled())
        ? createRolloutTracker({ startedAt: Date.now(), onActivity: (a) => t.onActivity?.(applyActivity(actions, a)), onDebug: log.debug })
        : undefined;
      let res: Awaited<ReturnType<typeof spawnLines>>;
      try {
      res = await spawnLines(
        // Prompt goes last as one quoted argument; all three CLIs take it positionally (on Windows `.cmd` shims it is piped on stdin instead).
        runScript({ executable, args, prompt, prependExecutableDir: id === "claude", nullStdin: true }),
        (e) => {
          if (e.type === "result" || e.type === "turn.completed") usage = tokenUsage(e.usage, id === "claude") ?? usage;
          const limit = claudeLimit(e);
          if (limit) t.onLimits?.([limit]);
          const ev = spec.parse(e);
          if (ev.session) session = ev.session;
          if (ev.text) emit(ev.text);
          if (e.type === "thread.started" && typeof e.thread_id === "string") rollout?.begin(e.thread_id);
          const acts = nativeActivities(id, e, log.unmapped);
          // Waits that name no agent are held back: the rollout scan shows the agents, and a merged card replaces them if it finds none.
          if (rollout && isBareCollabWait(e)) rollout.hold(acts);
          else for (const action of acts) t.onActivity?.(applyActivity(actions, action));
          if (ev.final) final = ev.final;
          if (ev.error) error = ev.error;
        },
        { signal: t.signal, cwd: t.cwd, onRaw: log.raw, killTree: t.killTree, env: cursorAccountEnv(cfg, await accountKey(), cfg.cliProfile ? await cursorProfiles.dir(cfg.cliProfile) : undefined) },
      );
      } finally {
        // The turn is over: one last scan unless it was stopped, then the polling ends.
        for (const action of (await rollout?.finish(!t.signal.aborted)) ?? []) t.onActivity?.(applyActivity(actions, action));
      }
      if (t.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!error && res.code !== 0) error = res.stderr.trim().slice(-600) || `${id} exited with ${res.code}`;
      if (error) {
        const auth = /401|auth|login|unauthori[sz]ed|api key/i.test(error);
        throw new Error(auth ? `${error}\n\n${spec.name}: ${spec.loginHint}` : error);
      }
      if (!text.trim() && final) emit(final);
      return { parts: [...[...actions.values()].map(a => a.status === "running" ? { ...a, status: "unknown" as const } : a), ...(text ? [{ type: "text" as const, text }] : [])], responseId: session, usage };
      } finally {
        await log.flush();
        if (saved && t.chatId) await attachments.clear(t.chatId).catch(() => {});
      }
    },
  };
}
