// Model comparison: one prompt sent to 2-4 models at once, each answer streamed into its own column.
// Pure logic only (no Tauri, no DOM, no React) so it is unit-tested in tests/compare.test.mjs with fake adapters:
// the column state reducer, target selection with the column limit, and parallel run orchestration with an
// injectable adapter and clock. Only `import type` from non-pure modules (Node runs this file directly).
//
// Contract:
//  - Runs are read-only: `adapter.turn` is called with `tools: []` and `access: "readonly"`, never with computer use.
//  - Comparison text lives in memory only. It is stored nowhere unless the user continues one answer in a chat
//    (`continueMessages`), which is the only thing that becomes persistent.
//  - Every column has its own AbortController; stopping one never touches the others, and events of a superseded
//    or stopped run are dropped, so a late `onText` can not reopen a stopped column.
import type { Adapter, Msg, Part, TokenUsage } from "../providers/types.ts";
import { ProviderError, isAbortError, type ErrorKind, type RetryInfo } from "../providers/retry.ts";

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;
/** Same estimate as the chat live meter: roughly three characters per token. */
export const CHARS_PER_TOKEN = 3;

export const COMPARE_SYSTEM =
  "Answer the user's message directly and completely. This is a side-by-side model comparison: no tools, commands or file access are available, so do not try to use any.";

export type CompareTarget = { key: string; providerId: string; model: string; label: string };

export type ColumnStatus = "running" | "done" | "error" | "stopped";

/** A classified failure (see providers/retry.ts); `kind` is absent for errors that are not `ProviderError`s. */
export type ColumnError = {
  message: string;
  kind?: ErrorKind;
  status?: number;
  retryable?: boolean;
  attempts?: number;
};

export type Column = CompareTarget & {
  status: ColumnStatus;
  text: string;
  start: number;
  end?: number;
  /** Characters streamed so far, the basis of the live output estimate. */
  chars: number;
  /** Estimated prompt tokens, shown until the provider reports its own usage. */
  input: number;
  usage?: TokenUsage;
  error?: ColumnError;
  /** Set while an API provider waits to retry a transient failure; cleared by the next text. */
  retry?: RetryInfo;
};

export type CompareState = { prompt: string; columns: Column[] };
export const emptyCompare: CompareState = { prompt: "", columns: [] };

export type CompareAction =
  | { type: "init"; prompt: string; targets: CompareTarget[]; now: number; input: number }
  | { type: "begin"; key: string; now: number }
  | { type: "text"; key: string; delta: string }
  | { type: "retry"; key: string; info: RetryInfo }
  | { type: "done"; key: string; now: number; text: string; usage?: TokenUsage }
  | { type: "fail"; key: string; now: number; error: ColumnError }
  | { type: "stop"; key: string; now: number }
  | { type: "reset" };

const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
/** Estimated tokens of the request (system prompt + user prompt + per-message overhead). */
export const estimateInput = (system: string, prompt: string) => estimateTokens(system.length + prompt.length + 32);
/** Estimated output tokens of a column from the characters received so far. */
export const estimateOutput = (c: Pick<Column, "chars">) => estimateTokens(c.chars);

const freshColumn = (t: CompareTarget, now: number, input: number): Column => ({
  key: t.key,
  providerId: t.providerId,
  model: t.model,
  label: t.label,
  status: "running",
  text: "",
  start: now,
  chars: 0,
  input,
});

function patch(s: CompareState, key: string, f: (c: Column) => Column): CompareState {
  let changed = false;
  const columns = s.columns.map((c) => {
    if (c.key !== key) return c;
    const next = f(c);
    changed ||= next !== c;
    return next;
  });
  return changed ? { ...s, columns } : s;
}

/** Events for a column that already finished are ignored (a late chunk after Stop, a duplicate completion). */
const live = (f: (c: Column) => Column) => (c: Column) => (c.status === "running" ? f(c) : c);

export function compareReducer(s: CompareState, a: CompareAction): CompareState {
  switch (a.type) {
    case "init": {
      const seen = new Set<string>();
      const targets = a.targets.filter((t) => !seen.has(t.key) && seen.add(t.key)).slice(0, MAX_COLUMNS);
      return { prompt: a.prompt, columns: targets.map((t) => freshColumn(t, a.now, a.input)) };
    }
    case "begin":
      return patch(s, a.key, (c) => freshColumn(c, a.now, c.input));
    case "text":
      return patch(
        s,
        a.key,
        live((c) => ({ ...c, text: c.text + a.delta, chars: c.chars + a.delta.length, retry: undefined })),
      );
    case "retry":
      return patch(
        s,
        a.key,
        live((c) => ({ ...c, retry: a.info })),
      );
    case "done":
      return patch(
        s,
        a.key,
        live((c) => ({ ...c, status: "done", text: a.text, end: a.now, usage: a.usage, retry: undefined })),
      );
    case "fail":
      return patch(
        s,
        a.key,
        live((c) => ({ ...c, status: "error", end: a.now, error: a.error, retry: undefined })),
      );
    case "stop":
      return patch(
        s,
        a.key,
        live((c) => ({ ...c, status: "stopped", end: a.now, retry: undefined })),
      );
    case "reset":
      return emptyCompare;
  }
}

// ---- Selection ---------------------------------------------------------------------------------------------------

/** Adds or removes `target` (matched by key); adding is refused (the list is returned unchanged) at the column limit. */
export function toggleTarget(list: CompareTarget[], target: CompareTarget, max = MAX_COLUMNS): CompareTarget[] {
  if (list.some((t) => t.key === target.key)) return list.filter((t) => t.key !== target.key);
  return list.length >= max ? list : [...list, target];
}

export const canRun = (prompt: string, targets: CompareTarget[], busy = false) =>
  !busy && prompt.trim().length > 0 && targets.length >= MIN_COLUMNS && targets.length <= MAX_COLUMNS;

export const anyRunning = (s: CompareState) => s.columns.some((c) => c.status === "running");

/** Generated text of a finished answer from the turn's parts (text parts only, in order). */
export const answerText = (parts: Part[]) =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

export function columnError(e: unknown): ColumnError {
  if (e instanceof ProviderError)
    return { message: e.message, kind: e.kind, status: e.status, retryable: e.retryable, attempts: e.attempts };
  return { message: String((e as { message?: unknown } | null)?.message ?? e) };
}

/** Elapsed milliseconds of a column: frozen at `end` once finished, else measured against `now`. */
export const elapsedMs = (c: Pick<Column, "start" | "end">, now: number) => Math.max(0, (c.end ?? now) - c.start);

// ---- Orchestration -----------------------------------------------------------------------------------------------

export type CompareDeps = {
  /** Adapter for a target (the app resolves the provider config; tests pass fakes). */
  getAdapter: (t: CompareTarget) => Promise<Pick<Adapter, "turn">>;
  dispatch: (a: CompareAction) => void;
  /** Called once per started request, e.g. `app.bumpUsage(providerId)`. */
  onRequest?: (t: CompareTarget) => void;
  /** Called with provider-reported usage after a request returned, e.g. `app.recordTokens`. */
  onUsage?: (t: CompareTarget, usage: TokenUsage) => void;
  now?: () => number;
  system?: string;
  /** Working directory for CLI providers; the comparison never writes there (access is read-only). */
  cwd?: string;
};

export type CompareRun = {
  /** Stops one column; the others keep running. */
  stop: (key: string) => void;
  stopAll: () => void;
  /** Runs a finished, failed or stopped column again with the same prompt. */
  rerun: (key: string) => Promise<void>;
  /** Resolves when every column started so far has settled. */
  settled: () => Promise<void>;
};

/** Starts all targets in parallel. Never rejects: failures become `fail` actions on their column. */
export function startCompare(targets: CompareTarget[], prompt: string, deps: CompareDeps): CompareRun {
  const now = deps.now ?? Date.now;
  const system = deps.system ?? COMPARE_SYSTEM;
  const picked = targets.slice(0, MAX_COLUMNS);
  const controllers = new Map<string, AbortController>();
  const inflight = new Set<Promise<void>>();
  const messages: Msg[] = [{ role: "user", parts: [{ type: "text", text: prompt }] }];

  deps.dispatch({ type: "init", prompt, targets: picked, now: now(), input: estimateInput(system, prompt) });

  async function runColumn(t: CompareTarget) {
    const ctl = new AbortController();
    controllers.set(t.key, ctl);
    // Only the newest run of a column may report; a stopped or restarted run is silent.
    const current = () => controllers.get(t.key) === ctl && !ctl.signal.aborted;
    try {
      const adapter = await deps.getAdapter(t);
      if (!current()) return;
      deps.onRequest?.(t);
      const out = await adapter.turn({
        system,
        messages,
        tools: [],
        model: t.model,
        cwd: deps.cwd,
        access: "readonly",
        signal: ctl.signal,
        onText: (delta) => {
          if (current()) deps.dispatch({ type: "text", key: t.key, delta });
        },
        onRetry: (info) => {
          if (current()) deps.dispatch({ type: "retry", key: t.key, info });
        },
      });
      if (out.usage) deps.onUsage?.(t, out.usage);
      if (!current()) return;
      const text = answerText(out.parts);
      if (!text)
        return deps.dispatch({
          type: "fail",
          key: t.key,
          now: now(),
          error: { message: "The model returned an empty answer." },
        });
      deps.dispatch({ type: "done", key: t.key, now: now(), text, usage: out.usage });
    } catch (e) {
      if (controllers.get(t.key) !== ctl) return;
      if (ctl.signal.aborted || isAbortError(e)) return deps.dispatch({ type: "stop", key: t.key, now: now() });
      deps.dispatch({ type: "fail", key: t.key, now: now(), error: columnError(e) });
    }
  }

  const launch = (t: CompareTarget) => {
    const p = runColumn(t).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  };

  for (const t of picked) launch(t);

  function stop(key: string) {
    const ctl = controllers.get(key);
    if (!ctl || ctl.signal.aborted) return;
    ctl.abort();
    deps.dispatch({ type: "stop", key, now: now() });
  }

  return {
    stop,
    stopAll() {
      for (const t of picked) stop(t.key);
    },
    async rerun(key) {
      const t = picked.find((x) => x.key === key);
      if (!t) return;
      controllers.get(key)?.abort();
      deps.dispatch({ type: "begin", key, now: now() });
      await launch(t);
    },
    async settled() {
      while (inflight.size) await Promise.all([...inflight]);
    },
  };
}

// ---- Continue in chat --------------------------------------------------------------------------------------------

/** Title of a chat created from a comparison: the first line of the prompt, as a normal new chat does. */
export const compareChatTitle = (prompt: string, fallback: string) =>
  prompt.trim().split("\n")[0].slice(0, 60) || fallback;

/** The two messages a new chat starts with: the prompt, and the chosen answer attributed to its model. */
export function continueMessages(
  prompt: string,
  c: Pick<Column, "providerId" | "model" | "text" | "usage" | "start" | "end">,
): Msg[] {
  return [
    { role: "user", parts: [{ type: "text", text: prompt }] },
    {
      role: "assistant",
      parts: [{ type: "text", text: c.text }],
      meta: {
        provider: c.providerId,
        model: c.model,
        ...(c.end !== undefined ? { durationMs: Math.max(0, c.end - c.start) } : {}),
        ...(c.usage ? { usage: c.usage } : {}),
      },
    },
  ];
}

/** Only a finished answer with text can be continued in a chat. */
export const canContinue = (c: Pick<Column, "status" | "text">) => c.status === "done" && c.text.length > 0;
