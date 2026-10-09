// Antigravity as a live session: one `agy_acp_server` process with its ACP session per chat (kept by `liveSessions`), so
// the next turn is a `session/prompt` on a session that is already loaded. Pure of Tauri (the process comes from the
// injected `open`), unit-tested in tests/antigravitySession.test.mjs against a fake ACP agent.
//
// Lifecycle (from T3 Code's AcpSessionRuntime, MIT, github.com/pingdotgg/t3code): spawn -> `initialize` -> eager
// `authenticate` with the configured method -> `session/resume` (or `session/load`, history replay muted) -> else
// `session/new`. A non-interactive start never signs in: when the agent prints a Google authorization link the start
// fails with "sign in required" (only the explicit `signIn` flow shows the link to the user).
//
// Turn semantics: Stop = `session/cancel`, wait for the prompt to end with `stopReason: "cancelled"` (the session
// stays usable), kill the process only when it does not answer within `interruptMs`. ACP has no steer, so a follow-up
// is the soft-restart style (providers/turnRestart.ts): the running turn is cancelled, keeps what it produced and the
// message is sent as the next prompt on the same live session.
import {
  createAcpClient,
  parseConfigOptions,
  type AcpClient,
  type ConfigOption,
  type InitializeResult,
  type PermissionAnswer,
  type PermissionRequest,
  type PromptUsage,
  type SessionSetup,
} from "./acp/client.ts";
import { isAcpError, type Duplex, type Json } from "./acp/rpc.ts";
import { createUpdateMapper, planText, type PlanEntry, type ToolCard, type UpdateEvent } from "./acp/updates.ts";
import { applyActivity, type Activity } from "./activities.ts";
import { resumePoint } from "./cliArgs.ts";
import { capabilitiesOf, interrupted } from "./lifecycle.ts";
import { liveSessions, sessionKey, type Lease, type ManagedSession } from "./sessionManager.ts";
import { restartableTurn } from "./turnRestart.ts";
import type { ModelInfo, Reasoning, TokenUsage, TurnInput, TurnOutput } from "./types.ts";
import {
  modelOption,
  modelsFromSession,
  safeMessage,
  thoughtLevels,
  thoughtOption,
  usesBrowser,
  type AntigravityAuthMethod,
} from "./antigravitySupport.ts";

export type AntigravityErrorCode =
  "not-installed" | "signin-required" | "auth-failed" | "model-unavailable" | "refused" | "unavailable";

/** Typed failure of the Antigravity integration; `message` is safe to show (no credentials, bounded). */
export class AntigravityError extends Error {
  readonly code: AntigravityErrorCode;
  constructor(code: AntigravityErrorCode, message: string) {
    super(message);
    this.name = "AntigravityError";
    this.code = code;
  }
}

export const SIGN_IN_REQUIRED_MESSAGE = "Sign in to Antigravity in Settings, Model providers, before you continue.";
export const NOT_INSTALLED_MESSAGE =
  "Antigravity is not installed or its executable was not found. Set the binary path in the provider settings.";

/** How long Stop waits for the cancelled prompt to end before the process is killed. */
export const INTERRUPT_MS = 5000;
/** Limit of the explicit browser sign-in. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Starts the agent process in `cwd`. `onAuthUrl` receives every authorization link the process reports. */
export type OpenAgent = (o: { cwd: string; onAuthUrl: (url: string) => void }) => Promise<Duplex>;

export type AgentDeps = {
  open: OpenAgent;
  method: AntigravityAuthMethod;
  /** Credentials to scrub from every message. */
  secrets?: () => string[];
  requestTimeoutMs?: number;
};

const CANCELLED: PermissionAnswer = { outcome: "cancelled" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MISSING = /not found|ENOENT|No such file|exit 127|exit 126|cannot find|is not recognized/i;

/** Maps a failure of the start sequence to a typed error. */
export function startFailure(e: unknown, secrets: readonly string[] = []): AntigravityError {
  if (e instanceof AntigravityError) return e;
  if (isAcpError(e)) {
    if (e.kind === "rpc" && e.code === -32000) return new AntigravityError("signin-required", SIGN_IN_REQUIRED_MESSAGE);
    if (e.kind === "closed" && MISSING.test(e.message))
      return new AntigravityError("not-installed", NOT_INSTALLED_MESSAGE);
    if (e.kind === "timeout") return new AntigravityError("unavailable", safeMessage(e, secrets));
  }
  if (e instanceof Error && MISSING.test(e.message) && !isAcpError(e))
    return new AntigravityError("not-installed", NOT_INSTALLED_MESSAGE);
  return new AntigravityError("unavailable", safeMessage(e, secrets));
}

type Turn = {
  access: TurnInput["access"];
  mode: TurnInput["mode"];
  approve: TurnInput["approve"];
  cancelled: Promise<void>;
};

/** What an incoming permission request resolves to. Exported for tests. */
export type Decision = "allow" | "deny" | "cancel";

/**
 * Policy for `session/request_permission`: native questions (`interaction_*` ids, options that are not allow/reject)
 * cannot be answered from an approval card and are cancelled; read-only access and Plan/Ask chats deny; Full access
 * allows; otherwise the user decides. "Allow always" is never chosen: every approval is for this one call.
 */
export async function decide(
  req: PermissionRequest,
  turn: Pick<Turn, "access" | "mode" | "approve">,
): Promise<Decision> {
  const kinds = new Set(req.options.map((o) => o.kind));
  if (req.toolCallId.startsWith("interaction_") || (!kinds.has("allow_once") && !kinds.has("reject_once")))
    return "cancel";
  if (turn.access === "readonly" || turn.mode === "plan" || turn.mode === "ask") return "deny";
  if (turn.access === "full") return "allow";
  if (!turn.approve) return "deny";
  const ok = await turn.approve({
    kind: "command",
    command: req.title || req.kind || "Antigravity action",
    reason: req.detail || undefined,
  });
  return ok ? "allow" : "deny";
}

/** The offered option for a decision, or "cancelled" when the agent offered none that fits. */
export function answerFor(req: PermissionRequest, d: Decision): PermissionAnswer {
  const want = d === "allow" ? "allow_once" : d === "deny" ? "reject_once" : "";
  const option = want ? req.options.find((o) => o.kind === want) : undefined;
  return option ? { outcome: "selected", optionId: option.optionId } : CANCELLED;
}

/** One running agent process with its ACP session (a `ManagedSession`). */
export class AgySession implements ManagedSession {
  sessionId = "";
  setup: SessionSetup = { sessionId: "", configOptions: [] };
  initialized!: InitializeResult;
  /** The session continued an earlier one (`session/resume` or `session/load`) instead of starting empty. */
  resumed = false;
  /** Receives the updates of the running turn. */
  sink?: (update: Json) => void;
  /** History replay of `session/load` is dropped. */
  muted = false;
  turn?: Turn;
  readonly client: AcpClient;
  readonly duplex: Duplex;
  private released = false;

  constructor(duplex: Duplex, deps: AgentDeps, fs?: Parameters<typeof createAcpClient>[0]["fs"]) {
    this.duplex = duplex;
    this.client = createAcpClient({
      duplex,
      fs,
      requestTimeoutMs: deps.requestTimeoutMs,
      redact: deps.secrets,
      clientInfo: { name: "gustaf", title: "Gustaf", version: "0" },
      permission: (req) => this.permission(req),
      onUpdate: (sid, update) => this.deliver(sid, update),
    });
  }

  private deliver(sessionId: string, update: Json) {
    if (sessionId !== this.sessionId || this.muted) return;
    if (update.sessionUpdate === "config_option_update") {
      const options = parseConfigOptions(update.configOptions);
      if (options.length) this.setup = { ...this.setup, configOptions: options };
    }
    this.sink?.(update);
  }

  private async permission(req: PermissionRequest): Promise<PermissionAnswer> {
    const turn = this.turn;
    if (!turn || req.sessionId !== this.sessionId) return CANCELLED;
    const result = decide(req, turn).then((d) => answerFor(req, d));
    return Promise.race([result, turn.cancelled.then(() => CANCELLED)]);
  }

  alive() {
    return !this.released && !this.duplex.exited() && !this.client.closedError;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    this.sink = undefined;
    this.client.close();
    await this.duplex.stop();
  }
}

/**
 * Starts the process, initializes it, authenticates with the configured method and opens a session (resuming
 * `resumeId` when the agent can). Never interactive: a sign-in link ends it with `signin-required`.
 */
export async function openAgentSession(
  deps: AgentDeps,
  o: { cwd: string; resumeId?: string; session?: boolean },
): Promise<AgySession> {
  const secrets = () => deps.secrets?.() ?? [];
  let reject!: (e: unknown) => void;
  const signInRequired = new Promise<never>((_, r) => (reject = r));
  signInRequired.catch(() => {});
  let duplex: Duplex;
  try {
    duplex = await deps.open({
      cwd: o.cwd,
      onAuthUrl: () => reject(new AntigravityError("signin-required", SIGN_IN_REQUIRED_MESSAGE)),
    });
  } catch (e) {
    throw startFailure(e, secrets());
  }
  const session = new AgySession(duplex, deps);
  const guard = <T>(p: Promise<T>) => Promise.race([p, signInRequired]);
  try {
    session.initialized = await guard(session.client.initialize());
    try {
      await guard(session.client.authenticate(deps.method, { timeoutMs: usesBrowser(deps.method) ? 30_000 : 60_000 }));
    } catch (e) {
      if (isAcpError(e) && e.kind === "rpc" && e.code !== -32000)
        throw new AntigravityError("auth-failed", `Antigravity could not authenticate: ${safeMessage(e, secrets())}`);
      throw e;
    }
    if (o.session === false) return session;
    const caps = session.initialized.capabilities;
    let setup: SessionSetup | undefined;
    if (o.resumeId && (caps.resume || caps.loadSession)) {
      try {
        session.sessionId = o.resumeId;
        session.muted = true;
        setup = await guard(
          caps.resume ? session.client.resumeSession(o.resumeId, o.cwd) : session.client.loadSession(o.resumeId, o.cwd),
        );
        session.resumed = true;
      } catch (e) {
        // The agent no longer knows that session (or cannot continue it): start a new one and replay the history.
        if (isAcpError(e) && (e.kind === "closed" || e.kind === "timeout")) throw e;
        if (e instanceof AntigravityError) throw e;
        setup = undefined;
      } finally {
        session.muted = false;
      }
    }
    if (!setup) setup = await guard(session.client.newSession(o.cwd));
    session.setup = setup;
    session.sessionId = setup.sessionId;
    return session;
  } catch (e) {
    await session.release();
    throw startFailure(e, secrets());
  }
}

// ---- probe, models, sign in, sign out --------------------------------------------------------------------------------

export type Probe = { version?: string; title?: string; methods: string[]; logout: boolean };

/**
 * The cheap health check: starts the agent and runs `initialize` only. It never authenticates, so it can never start a
 * login, and it opens no session (no MCP servers boot).
 */
export async function probeAgent(deps: AgentDeps, cwd: string): Promise<Probe> {
  let duplex: Duplex;
  try {
    duplex = await deps.open({ cwd, onAuthUrl: () => {} });
  } catch (e) {
    throw startFailure(e, deps.secrets?.());
  }
  const session = new AgySession(duplex, { ...deps, requestTimeoutMs: deps.requestTimeoutMs ?? 20_000 });
  try {
    const init = await session.client.initialize();
    return {
      version: init.agentInfo?.version || undefined,
      title: init.agentInfo?.title || init.agentInfo?.name || undefined,
      methods: init.authMethods.map((m) => m.id),
      logout: init.capabilities.logout,
    };
  } catch (e) {
    throw startFailure(e, deps.secrets?.());
  } finally {
    await session.release();
  }
}

export type SessionInfo = { models: ModelInfo[]; levels: Partial<Record<Reasoning, string>>; version?: string };

const infoOf = (s: AgySession, providerId: string): SessionInfo => ({
  models: modelsFromSession(s.setup, providerId),
  levels: thoughtLevels(s.setup.configOptions),
  version: s.initialized.agentInfo?.version || undefined,
});

/** Models of the signed-in account: a short-lived session (non-interactive). */
export async function listAgentModels(deps: AgentDeps, cwd: string, providerId: string): Promise<SessionInfo> {
  const s = await openAgentSession(deps, { cwd });
  try {
    return infoOf(s, providerId);
  } finally {
    await s.release();
  }
}

export type SignInHooks = {
  /** The (validated) Google link the user has to open. Called once per distinct link. */
  onUrl(url: string): void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * The explicit sign-in: starts the agent, shows the authorization link of a browser method through `onUrl`, and waits
 * for `authenticate` to finish (the agent's own listener on 127.0.0.1 receives Google's redirect). Aborting or the
 * timeout stops the process, which also closes that listener. API-key methods authenticate without a link.
 */
export async function signInAgent(
  deps: AgentDeps,
  cwd: string,
  providerId: string,
  hooks: SignInHooks,
): Promise<SessionInfo> {
  const secrets = () => deps.secrets?.() ?? [];
  if (hooks.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const seen = new Set<string>();
  let duplex: Duplex;
  try {
    duplex = await deps.open({
      cwd,
      onAuthUrl: (url) => {
        if (seen.size >= 2 || seen.has(url)) return; // one sign-in page; a second distinct link is ignored
        seen.add(url);
        hooks.onUrl(url);
      },
    });
  } catch (e) {
    throw startFailure(e, secrets());
  }
  const session = new AgySession(duplex, deps);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    session.initialized = await session.client.initialize();
    try {
      await session.client.authenticate(deps.method, {
        timeoutMs: hooks.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
        signal: ctl.signal,
      });
    } catch (e) {
      if (hooks.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (isAcpError(e) && e.kind === "timeout")
        throw new AntigravityError("auth-failed", "Sign-in timed out. Start it again.");
      if (isAcpError(e) && e.kind === "rpc")
        throw new AntigravityError(
          "auth-failed",
          /SUBSCRIPTION_REQUIRED/.test(e.message)
            ? "Google requires an eligible Antigravity subscription for this account."
            : /access_denied|denied|cancel/i.test(e.message)
              ? "Google sign-in was not approved. Start it again."
              : `Antigravity could not authenticate: ${safeMessage(e, secrets())}`,
        );
      throw e;
    }
    // A session proves the account can use the agent and lists its models.
    session.setup = await session.client.newSession(cwd);
    session.sessionId = session.setup.sessionId;
    return infoOf(session, providerId);
  } catch (e) {
    if (e instanceof DOMException) throw e;
    throw startFailure(e, secrets());
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
    await session.release();
  }
}

/** Signs out through the agent's own `logout` request when it has one. Returns false when it has none. */
export async function signOutAgent(deps: AgentDeps, cwd: string): Promise<boolean> {
  let duplex: Duplex;
  try {
    duplex = await deps.open({ cwd, onAuthUrl: () => {} });
  } catch (e) {
    throw startFailure(e, deps.secrets?.());
  }
  const session = new AgySession(duplex, { ...deps, requestTimeoutMs: deps.requestTimeoutMs ?? 20_000 });
  try {
    const init = await session.client.initialize();
    if (!init.capabilities.logout) return false;
    await session.client.logout();
    return true;
  } catch (e) {
    throw startFailure(e, deps.secrets?.());
  } finally {
    await session.release();
  }
}

// ---- the turn ---------------------------------------------------------------------------------------------------------

export type TurnContext = AgentDeps & {
  providerId: string;
  /** Launch signature: a change (binary, method, project, key...) replaces the live process. */
  signature: string;
  /** Folder used when the chat has no project folder. */
  fallbackCwd: string;
  /** Test hooks. */
  sessions?: Pick<typeof liveSessions, "acquire">;
  interruptMs?: number;
};

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/=]+)$/;

/** ACP content blocks of a prompt: the text and, when the agent takes images, the attached ones. */
export function promptBlocks(text: string, images: string[], acceptsImages: boolean): Json[] {
  const blocks: Json[] = [];
  let skipped = 0;
  for (const img of images) {
    const m = DATA_URL.exec(img);
    if (m && acceptsImages) blocks.push({ type: "image", mimeType: m[1], data: m[2] });
    else skipped++;
  }
  const note = skipped
    ? `\n\n[${skipped} attached image${skipped > 1 ? "s were" : " was"} not sent: the agent does not accept images.]`
    : "";
  return [{ type: "text", text: text + note }, ...blocks];
}

export function usageOf(u: PromptUsage | undefined): TokenUsage | undefined {
  return u
    ? {
        input: u.inputTokens,
        output: u.outputTokens,
        cached: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
        reasoning: u.thoughtTokens ?? 0,
      }
    : undefined;
}

/** Selects the chat's model (and reasoning level) on the session when it differs from what the session runs. */
export async function applySelection(s: AgySession, model: string | undefined, level: Reasoning | undefined) {
  const configs = s.setup.configOptions;
  const set = async (opt: ConfigOption | undefined, value: string) => {
    if (!opt || opt.currentValue === value) return;
    const next = await s.client.setConfigOption(s.sessionId, opt.id, value);
    s.setup = {
      ...s.setup,
      configOptions: next.length ? next : configs.map((c) => (c.id === opt.id ? { ...c, currentValue: value } : c)),
    };
  };
  if (model && model !== "default") {
    const opt = modelOption(configs);
    if (opt) {
      if (!opt.options.some((c) => c.value === model))
        throw new AntigravityError(
          "model-unavailable",
          `Antigravity model "${model}" is not available for this Google account. Pick another model.`,
        );
      await set(opt, model);
    } else if (s.setup.models?.available.some((m) => m.id === model) && s.setup.models.current !== model) {
      await s.client.request("session/set_model", { sessionId: s.sessionId, modelId: model }).catch(() => {});
      s.setup = { ...s.setup, models: { ...s.setup.models, current: model } };
    }
  }
  const values = thoughtLevels(s.setup.configOptions);
  const want = level && values[level] ? values[level] : undefined;
  if (want) await set(thoughtOption(s.setup.configOptions), want);
}

/** Turns the tool/plan events of a turn into the activity cards the chat shows (running ones read as unknown at the end). */
function toActivity(card: ToolCard): Activity {
  return {
    type: "activity",
    id: card.id,
    name: card.name,
    args: card.args,
    status: card.status,
    ...(card.output ? { output: card.output } : {}),
  };
}

const PLAN_ID = "acp:plan";
function planActivity(entries: PlanEntry[]): Activity {
  const open = entries.some((e) => e.status !== "completed");
  return {
    type: "activity",
    id: PLAN_ID,
    name: "plan",
    args: {},
    status: open ? "running" : "success",
    output: planText(entries),
  };
}

/** One Antigravity turn on the chat's live session. */
export async function runAntigravityTurn(t: TurnInput, ctx: TurnContext): Promise<TurnOutput> {
  const cwd = t.cwd || ctx.fallbackCwd;
  const point = resumePoint(t, ctx.providerId, false);
  // Without a session of ours the whole history is replayed as text into a new agent session.
  const fresh = point.session ? resumePoint(t, "\u0000none", false) : point;
  const sessions = ctx.sessions ?? liveSessions;
  const key = sessionKey({ providerId: ctx.providerId, chatId: t.chatId, cwd });
  const secrets = () => ctx.secrets?.() ?? [];

  let lease: Lease<AgySession>;
  for (let attempt = 0; ; attempt++) {
    lease = await sessions.acquire<AgySession>(key, ctx.signature, () =>
      openAgentSession(ctx, { cwd, resumeId: point.session }),
    );
    // The live session is not the one this turn continues (history edited, chat branched): replace it.
    if (lease.reused && lease.session.sessionId !== point.session) {
      lease.done({ broken: true });
      if (attempt < 2) continue;
      throw new AntigravityError("unavailable", "Could not open an Antigravity session for this chat.");
    }
    break;
  }
  const session = lease.session;
  const continued = lease.reused || session.resumed;
  // The system prompt goes with the first prompt of an agent session only.
  let prompt = continued ? point.prompt : fresh.prompt;
  if (lease.reused && prompt.startsWith(`${t.system}\n\n`)) prompt = prompt.slice(t.system.length + 2);
  const images = continued ? point.images : fresh.images;

  const activities = new Map<string, Activity>();
  let text = "";
  const mapper = createUpdateMapper();
  const track = (a: Activity) => t.onActivity?.(applyActivity(activities, a));
  let settled = false;
  let broken = false;
  const turn = restartableTurn(t, {
    enabled: capabilitiesOf({ kind: "antigravity" }).followUp === "restart",
    ended: () => settled,
  });
  let cancel!: () => void;
  const cancelled = new Promise<void>((r) => (cancel = r));
  turn.signal.addEventListener("abort", cancel, { once: true });
  if (turn.signal.aborted) cancel();
  session.turn = { access: t.access, mode: t.mode, approve: t.approve, cancelled };
  session.sink = (update) => {
    for (const e of mapper.map(update) as UpdateEvent[]) {
      if (e.type === "text") {
        text += e.text;
        t.onText(e.text);
      } else if (e.type === "tool") track(toActivity(e.card));
      else if (e.type === "plan") track(planActivity(e.entries));
      // Thoughts are dropped like those of the other providers; commands, modes and usage updates need no card.
    }
  };
  const output = (): TurnOutput => {
    const open = new Set(mapper.openCalls().map((c) => c.id));
    const parts: TurnOutput["parts"] = [
      ...[...activities.values()].map((a) =>
        a.status === "running" && open.has(a.id) ? { ...a, status: "unknown" as const } : a,
      ),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    return { parts, responseId: session.sessionId };
  };

  try {
    await applySelection(session, t.model, t.reasoning);
    const promptRun = session.client.prompt(
      session.sessionId,
      promptBlocks(prompt, images, session.initialized.capabilities.image),
    );
    const result = promptRun.then(
      (r) => ({ r }),
      (e: unknown) => ({ e }),
    );
    const first = await Promise.race([result, cancelled.then(() => "cancel" as const)]);
    let stop: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" = "end_turn";
    let usage: TokenUsage | undefined;
    if (first === "cancel") {
      await session.client.cancel(session.sessionId);
      const done = await Promise.race([result, sleep(ctx.interruptMs ?? INTERRUPT_MS).then(() => "late" as const)]);
      if (done === "late") broken = true;
      else if ("r" in done) usage = usageOf(done.r.usage);
      else if (isAcpError(done.e) && done.e.kind === "closed") broken = true;
    } else if ("e" in first) {
      broken = isAcpError(first.e) && first.e.kind === "closed";
      throw startFailure(first.e, secrets());
    } else {
      stop = first.r.stopReason;
      usage = usageOf(first.r.usage);
    }
    settled = true;
    await turn.close();
    const out = { ...output(), ...(usage ? { usage } : {}) };
    if (turn.stopped()) throw interrupted(out);
    if (turn.restarted()) return { ...out, interrupted: true };
    if (stop === "refusal") throw new AntigravityError("refused", "Antigravity refused to continue this request.");
    if (stop === "max_tokens" || stop === "max_turn_requests") {
      const note =
        stop === "max_tokens"
          ? "\n\n[Antigravity stopped: token limit reached.]"
          : "\n\n[Antigravity stopped: turn limit reached.]";
      t.onText(note);
      text += note;
      return { ...out, parts: output().parts };
    }
    return out;
  } catch (e) {
    settled = true;
    await turn.close().catch(() => {});
    if (e instanceof AntigravityError && e.code === "signin-required") broken = true;
    throw e;
  } finally {
    session.sink = undefined;
    session.turn = undefined;
    if (broken) await session.release();
    lease.done({ broken: broken || !session.alive() });
  }
}
