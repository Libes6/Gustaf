import { nativeActivities, mergeActivity, type Activity } from "./activities";
import { claudeArgs, parseClaudeEvent } from "./claudeCli";
import { cursorAccountEnv } from "./cursorAccounts";
import { resolveResource } from "@tauri-apps/api/path";
declare const __SIDECAR__: string;
import { codexArgs, turnImages, withImagePaths } from "./cliArgs";
import { attachments } from "../lib/api";
import { tokenUsage, claudeLimit } from "./usage";
import { Command } from "@tauri-apps/plugin-shell";
import { flattenMsg, textOf, type Adapter, type CliId, type ProviderConfig, type TurnInput } from "./types";

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
let codexPath: Promise<string> | undefined;
export function codexExecutable() {
  return codexPath ??= (async () => {
    const probe = await Command.create("zsh", ["-lc", `if codex --version >/dev/null 2>&1; then echo codex; elif ${shq(BUNDLED_CODEX)} --version >/dev/null 2>&1; then echo ${shq(BUNDLED_CODEX)}; else exit 1; fi`]).execute();
    if (probe.code !== 0 || !probe.stdout.trim()) throw new Error("Codex CLI is unavailable");
    return probe.stdout.trim();
  })();
}

async function cursorExecutable() {
  const probe = await Command.create('zsh', ['-lc', 'command -v cursor-agent || { test -x "$HOME/.local/bin/cursor-agent" && echo "$HOME/.local/bin/cursor-agent"; }']).execute();
  if (probe.code || !probe.stdout.trim()) throw new Error('Cursor CLI is unavailable.');
  return probe.stdout.trim();
}

async function claudeExecutable() {
  const probe = await Command.create('zsh', ['-lc', 'command -v claude || { for candidate in "$HOME/.local/bin/claude" "$HOME"/.nvm/versions/node/*/bin/claude(N); do if test -x "$candidate"; then echo "$candidate"; break; fi; done; }']).execute();
  if (!probe.stdout.trim()) throw new Error('Claude CLI is unavailable. Install Claude Code and run claude auth login.');
  return probe.stdout.trim();
}

/** Runs a login-shell script and feeds each stdout JSON line to onLine; non-JSON lines are skipped. */
export async function spawnLines(
  script: string,
  onLine: (e: any) => void,
  o: { signal?: AbortSignal; cwd?: string; stdin?: string; env?: Record<string, string> } = {},
) {
  if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cmd = Command.create("zsh", ["-lc", script], { cwd: o.cwd, ...(o.env && Object.keys(o.env).length ? { env: o.env } : {}) });
  let buf = "";
  let stderr = "";
  const line = (s: string) => {
    s = s.trim();
    if (!s) return;
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
  const kill = () => { child.kill().catch(() => {}); };
  o.signal?.addEventListener("abort", kill, { once: true });
  if (o.signal?.aborted) kill();
  if (o.stdin != null) await child.write(o.stdin);
  let code: number | null;
  try { code = await done; } finally { o.signal?.removeEventListener("abort", kill); }
  line(buf);
  return { code, stderr };
}

/** Finds the last session this provider left in the history and the prompt to continue it with. */
export function resumePoint(t: TurnInput, providerId: string, withSystem: boolean) {
  let from = 0;
  let session: string | undefined;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role === "assistant" && m.meta?.provider === providerId && m.meta.responseId) {
      session = m.meta.responseId;
      from = i + 1;
      break;
    }
  }
  const rest = t.messages.slice(from);
  const prompt = session
    ? rest.filter((m) => m.role === "user").map(textOf).join("\n\n")
    : (withSystem ? `${t.system}\n\n` : "") +
      (rest.length === 1 ? textOf(rest[0]) : rest.map((m) => `${m.role.toUpperCase()}:\n${flattenMsg(m)}`).join("\n\n"));
  // Resumed CLI sessions may predate canvas support and don't receive the API system message.
  return { session, prompt: session || !withSystem ? `${t.system}\n\n${prompt}` : prompt, images: turnImages(rest, !!session) };
}

async function listCodexModels() {
  const script = import.meta.env.DEV ? __SIDECAR__.replace(/cursor-agent\.mjs$/, 'codex-limits.mjs') : await resolveResource('sidecar/codex-limits.mjs');
  const executable = await codexExecutable();
  let models: { id: string; name: string }[] = [];
  let error = '';
  const result = await spawnLines(`exec env MCODE_CODEX_BINARY=${shq(executable)} node ${shq(script)} --models`, e => {
    if (e.type === 'models') models = e.result;
    if (e.type === 'error') error = e.message;
  });
  if (error || result.code || !models.length) throw new Error(error || 'Codex did not return available models.');
  return [{ id: 'default', name: 'По умолчанию' }, ...models.filter(m => m.id !== 'default')];
}

type Ev = { text?: string; session?: string; final?: string; error?: string };
type Spec = {
  name: string;
  models: string[] | (() => Promise<{ id: string; name: string }[]>);
  /** `images`: absolute attachment paths for this turn; `attachDir`: the folder holding them. */
  args(o: { model?: string; session?: string; access: TurnInput["access"]; images?: string[]; attachDir?: string }): string[];
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
    parse: parseClaudeEvent,
    loginHint: "claude auth login",
  },
  "cursor-agent": {
    name: "Cursor Agent",
    models: async () => {
      const out: { id: string; name: string }[] = [];
      const cmd = await Command.create("zsh", ["-lc", "cursor-agent --list-models"]).execute();
      for (const l of cmd.stdout.split("\n")) {
        const m = /^(\S+) - (.+?)(?: \((?:current|default)\))?$/.exec(l.trim());
        if (m) out.push({ id: m[1], name: m[2] });
      }
      if (!out.length) throw new Error(cmd.stderr || cmd.stdout || "cursor-agent --list-models: empty");
      return out;
    },
    args: ({ model, session, access, attachDir }) => [
      "-p", "--output-format", "stream-json", "--stream-partial-output", "--trust",
      ...(access === "readonly" ? ["--mode", "plan"] : access === "full" ? ["--force"] : []),
      ...(model ? ["--model", model] : []),
      ...(session ? ["--resume", session] : []),
      ...(attachDir ? ["--add-dir", attachDir] : []),
    ],
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
  const script = ids.map((c) => `v=$(${c === "codex" ? `codex --version 2>/dev/null || ${shq(BUNDLED_CODEX)} --version 2>/dev/null` : c === "cursor-agent" ? 'cursor-agent --version 2>/dev/null || "$HOME/.local/bin/cursor-agent" --version 2>/dev/null' : 'claude --version 2>/dev/null || { for candidate in "$HOME/.local/bin/claude" "$HOME"/.nvm/versions/node/*/bin/claude(N); do if test -x "$candidate"; then export PATH="${candidate:h}:$PATH"; "$candidate" --version 2>/dev/null && break; fi; done; }' }) && echo ${c}$'\\t'"\${v%%$'\\n'*}"`).join("; ");
  const out = await Command.create("zsh", ["-lc", `${script}; true`]).execute();
  return out.stdout
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([id]) => ids.includes(id as CliId))
    .map(([id, version]) => ({ id: id as CliId, version: version ?? "" }));
}

/** An installed agent CLI: it runs its own tools and auth in the project folder; we relay text and tool activity. */
export function cliAdapter(cfg: ProviderConfig, key = ""): Adapter {
  const id = cfg.cli!;
  const spec = SPECS[id];
  return {
    supportsComputer: false,
    supportsReasoning: () => false,

    async listModels() {
      if (id === 'cursor-agent') {
        const executable = await cursorExecutable();
        const cmd = await Command.create('zsh', ['-lc', `${shq(executable)} --list-models`], { ...(cfg.cliAuth === "key" ? { env: cursorAccountEnv(cfg, key) } : {}) }).execute();
        const models = cmd.stdout.split('\n').flatMap(l => {
          const m = /^(\S+) - (.+?)(?: \((?:current|default)\))?$/.exec(l.trim());
          return m ? [{ id: m[1], name: m[2], providerId: cfg.id, created: 0, tools: true, images: true }] : [];
        });
        if (cmd.code || !models.length) throw new Error(cmd.stderr || 'Cursor did not return models.');
        return models;
      }
      const list = typeof spec.models === "function" ? await spec.models() : spec.models.map((id) => ({ id, name: id }));
      return list.map((m) => ({ ...m, providerId: cfg.id, created: 0, tools: true, images: true }));
    },

    async turn(t: TurnInput) {
      const point = resumePoint(t, cfg.id, false);
      let session = point.session;
      // Attached images go to disk for the CLI to read; they are removed when the turn ends (also on error or stop).
      const saved = point.images.length && t.chatId ? await attachments.save(t.chatId, point.images) : undefined;
      try {
      const args = spec.args({ model: t.model === "default" ? undefined : t.model, session, access: t.access ?? "auto", images: saved?.files, attachDir: saved?.dir });
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
      const res = await spawnLines(
        // Prompt goes last as one quoted argument; all three CLIs take it positionally.
        `${id === "claude" && executable.startsWith("/") ? `export PATH=${shq(executable.slice(0, executable.lastIndexOf("/")))}:"$PATH"; ` : ""}exec ${shq(executable)} ${[...args, prompt].map(shq).join(" ")} < /dev/null`,
        (e) => {
          if (e.type === "result" || e.type === "turn.completed") usage = tokenUsage(e.usage, id === "claude") ?? usage;
          const limit = claudeLimit(e);
          if (limit) t.onLimits?.([limit]);
          const ev = spec.parse(e);
          if (ev.session) session = ev.session;
          if (ev.text) emit(ev.text);
          for (const action of nativeActivities(id, e)) {
            const merged = mergeActivity(actions.get(action.id), action);
            actions.set(action.id, merged);
            t.onActivity?.(merged);
          }
          if (ev.final) final = ev.final;
          if (ev.error) error = ev.error;
        },
        { signal: t.signal, cwd: t.cwd, env: cursorAccountEnv(cfg, key) },
      );
      if (t.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!error && res.code !== 0) error = res.stderr.trim().slice(-600) || `${id} exited with ${res.code}`;
      if (error) {
        const auth = /401|auth|login|unauthori[sz]ed|api key/i.test(error);
        throw new Error(auth ? `${error}\n\n${spec.name}: ${spec.loginHint}` : error);
      }
      if (!text.trim() && final) emit(final);
      return { parts: [...[...actions.values()].map(a => a.status === "running" ? { ...a, status: "unknown" as const } : a), ...(text ? [{ type: "text" as const, text }] : [])], responseId: session, usage };
      } finally {
        if (saved && t.chatId) await attachments.clear(t.chatId).catch(() => {});
      }
    },
  };
}
