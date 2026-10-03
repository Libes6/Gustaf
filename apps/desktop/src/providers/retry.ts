// Resilience shared by the API providers (anthropic, openaiCompatible, openaiResponses): error classification,
// Retry-After parsing, and an abortable exponential backoff with jitter. Pure logic only (no Tauri, no DOM, no
// React; fetch/sleep/clock/random are injectable) so it is unit-tested in tests/retry.test.mjs and
// tests/providerRetry.test.mjs. Only `import type` from other modules is allowed because Node runs this file directly.
//
// Contract:
//  - A failed request is retried only while NOTHING has been delivered to `onText`. Once any text reached the UI the
//    error is surfaced as is, and the existing "continue interrupted request" flow takes over.
//  - Only classified, transient failures are retried: HTTP 408/429/5xx, network errors, and stream error events of
//    the same kinds. 401/403, quota/credit exhaustion and other 4xx are never retried.
//  - Retry-After (and retry-after-ms) is honoured; waits are capped by `maxTotalWaitMs`, attempts by `maxAttempts`.
//  - Aborting the signal cancels the sleep at once and rethrows an AbortError, never a retry.

/** What went wrong, from the user's point of view. */
export type ErrorKind = "rate_limit" | "quota" | "auth" | "network" | "server" | "request";

export type RetryPolicy = {
  /** Total tries including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Cap for one computed backoff step (a server-sent Retry-After may exceed it, within `maxTotalWaitMs`). */
  maxDelayMs: number;
  /** Cap for the sum of all waits in one turn; a Retry-After that does not fit gives up immediately. */
  maxTotalWaitMs: number;
  /** 0 = no jitter, 1 = full jitter: a step lands uniformly in [step * (1 - jitter), step]. */
  jitter: number;
};

export const DEFAULT_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 16_000, maxTotalWaitMs: 30_000, jitter: 0.5 };

/** Reported before each wait so the UI can show "Retrying in 5s…". */
export type RetryInfo = {
  /** The attempt that just failed (1-based). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  kind: ErrorKind;
  status?: number;
  message: string;
};

/** Variables for the `retryingIn` i18n string: `t("retryingIn", retryNoticeVars(info))`. */
export const retryNoticeVars = (i: RetryInfo) => ({ seconds: Math.max(1, Math.ceil(i.delayMs / 1000)), attempt: i.attempt + 1, max: i.maxAttempts });

export type RetryDeps = {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Returns a number in [0, 1). */
  random: () => number;
  /** Milliseconds since the epoch; used to turn an HTTP-date Retry-After into a delay. */
  now: () => number;
};

export class ProviderError extends Error {
  kind: ErrorKind;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  /** Attempts made when this error was finally surfaced (set by `withRetry`). */
  attempts: number;
  cause?: unknown;
  constructor(kind: ErrorKind, message: string, o: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = o.status;
    this.retryable = o.retryable ?? false;
    this.retryAfterMs = o.retryAfterMs;
    this.attempts = 1;
    this.cause = o.cause;
  }
}

// ---- Errors -----------------------------------------------------------------------------------------------------

export const abortError = (signal?: AbortSignal) =>
  signal?.reason instanceof Error && signal.reason.name === "AbortError" ? signal.reason : new DOMException("Aborted", "AbortError");

export const isAbortError = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : s + ".");

function waitText(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.ceil(s / 60)} min`;
}

type Spec = { head: string; hint?: string; retryable: boolean };

function specFor(kind: ErrorKind, status: number | undefined, retryAfterMs: number | undefined, retryable: boolean): Spec {
  switch (kind) {
    case "rate_limit":
      return {
        head: "Rate limit reached",
        hint: retryAfterMs !== undefined ? `Try again in about ${waitText(retryAfterMs)}.` : "Wait a moment and try again.",
        retryable,
      };
    case "quota":
      return { head: "Quota or credits exhausted", hint: "Check the plan, billing and credit balance with the provider.", retryable: false };
    case "auth":
      return status === 403
        ? { head: "Access denied", hint: "Check the API key permissions and that the model is available for this account or region.", retryable: false }
        : { head: "Authentication failed", hint: "Invalid API key or sign-in expired; check it in Settings.", retryable: false };
    case "network":
      return { head: "Network error", hint: "Check your internet connection.", retryable };
    case "server":
      return {
        head: status === 529 ? "Provider is overloaded" : status === 408 ? "Request timed out" : "Provider server error",
        hint: retryable ? "This is usually temporary; try again shortly." : undefined,
        retryable,
      };
    default:
      return { head: "Request failed", retryable: false };
  }
}

/** Builds the user-facing error. `HTTP <status>` stays in the message so existing status checks (e.g. 401 sign-in detection) keep working. */
export function makeError(kind: ErrorKind, o: { status?: number; detail?: string; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {}) {
  const spec = specFor(kind, o.status, o.retryAfterMs, o.retryable ?? (kind === "rate_limit" || kind === "network" || kind === "server"));
  const detail = (o.detail ?? "").trim();
  const status = o.status !== undefined ? ` (HTTP ${o.status})` : "";
  const message = `${spec.head}${status}${detail ? `: ${detail}` : ""}`;
  return new ProviderError(kind, `${sentence(message)}${spec.hint ? " " + spec.hint : ""}`, {
    status: o.status,
    retryable: spec.retryable,
    retryAfterMs: o.retryAfterMs,
    cause: o.cause,
  });
}

const QUOTA = /insufficient_quota|exceeded your current quota|credit balance is too low|insufficient (?:credits|funds)|out of credits/i;

/** Maps an HTTP status (plus the provider's message) to a classified error. */
export function errorForStatus(status: number, detail = "", retryAfterMs?: number): ProviderError {
  if ([400, 402, 429].includes(status) && (status === 402 || QUOTA.test(detail))) return makeError("quota", { status, detail });
  if (status === 401 || status === 403) return makeError("auth", { status, detail });
  if (status === 429) return makeError("rate_limit", { status, detail, retryAfterMs });
  if (status === 408) return makeError("server", { status, detail, retryAfterMs, retryable: true });
  if (status >= 500) return makeError("server", { status, detail, retryAfterMs, retryable: status !== 501 && status !== 505 });
  return makeError("request", { status, detail });
}

/** A connection that never produced a response, or broke while streaming. */
export function networkError(e: unknown): ProviderError {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const detail = raw.slice(0, 300) || "the request failed";
  const refused = /refused|ECONNREFUSED/i.test(raw);
  const err = makeError("network", { detail, retryable: !refused, cause: e });
  // A refused connection means nothing is listening (e.g. Ollama is not running): waiting will not help.
  if (refused) err.message = `${sentence(`Network error: ${detail}`)} Check that the server is running and the base URL is correct.`;
  return err;
}

/** Error events delivered inside a 200 stream (`event: error`, `response.failed`, OpenRouter mid-stream errors). */
export function streamError(info: unknown): ProviderError {
  const o = (info && typeof info === "object" ? info : {}) as { type?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const detail = typeof info === "string" && info ? info : typeof o.message === "string" && o.message ? o.message : "stream error";
  const num = [o.status, o.code].map((v) => (typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : v)).find((v) => typeof v === "number" && v >= 400 && v < 600);
  if (typeof num === "number") return errorForStatus(num, detail);
  const tag = [o.type, o.code].filter((v): v is string => typeof v === "string").join(" ");
  if (QUOTA.test(tag) || QUOTA.test(detail)) return makeError("quota", { detail });
  if (/rate_?limit|too_many_requests|resource_exhausted/i.test(tag)) return makeError("rate_limit", { detail });
  if (/overloaded|server_error|api_error|internal|unavailable|timeout|bad_gateway|upstream/i.test(tag)) return makeError("server", { detail, retryable: true });
  if (/authentication|permission|invalid_api_key|unauthorized|forbidden/i.test(tag)) return makeError("auth", { detail });
  return makeError("request", { detail });
}

/** The provider's own message from an error body: JSON `error.message` / `error` / `message`, else short plain text. */
export function errorDetail(body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body);
    const e = j?.error;
    msg = (typeof e === "string" ? e : e?.message) ?? j?.message ?? body;
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {}
  msg = msg.trim();
  // Gateways answer 502/503 with an HTML page; that is noise, not a message.
  if (/^<(!doctype|html|head|body)/i.test(msg)) return "";
  return msg.slice(0, 500);
}

/** Retry-After in milliseconds from `retry-after-ms`, or `retry-after` as delta-seconds or an HTTP date. */
export function parseRetryAfter(headers: { get(name: string): string | null } | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\s*\d+(\.\d+)?\s*$/.test(ms)) return Math.round(Number(ms));
  const v = headers.get("retry-after");
  if (v === null) return undefined;
  if (/^\s*\d+(\.\d+)?\s*$/.test(v)) return Math.round(Number(v) * 1000);
  const at = /[a-z]/i.test(v) ? Date.parse(v) : NaN; // an HTTP date; Date.parse alone would accept "-3" or "2"
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Turns a non-2xx response into a classified error, reading its body and Retry-After. */
export async function errorFromResponse(res: Response, now = Date.now()): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  return errorForStatus(res.status, errorDetail(body), parseRetryAfter(res.headers, now));
}

export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  throw await errorFromResponse(res);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `fetch` whose rejections (other than aborts) become classified network errors. */
export async function guardedFetch(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (isAbortError(e) || init?.signal?.aborted) throw e;
    throw networkError(e);
  }
}

/** One HTTP call: network failures and non-2xx statuses both come back as `ProviderError`. */
export async function requestWith(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Response> {
  return ensureOk(await guardedFetch(fetchImpl, url, init));
}

// ---- Backoff ----------------------------------------------------------------------------------------------------

/** Delay before retry number `retry` (1 = the first retry): `base * 2^(retry-1)` capped at `maxDelayMs`, then jittered. */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number): number {
  const step = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.round(step * (1 - policy.jitter * random()));
}

/** Sleeps `ms`, rejecting with an AbortError the moment the signal aborts (and clearing the timer). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryOptions = {
  signal: AbortSignal;
  /** The consumer of streamed text. `run` must call the wrapped copy it receives, which is how output is tracked. */
  onText: (delta: string) => void;
  onRetry?: (info: RetryInfo) => void;
  policy?: Partial<RetryPolicy>;
  deps?: Partial<RetryDeps>;
};

/**
 * Runs `run` (a whole request: send, check status, read the stream) and retries transient failures that happen
 * before any output reached the user. Anything that is not a retryable `ProviderError` is rethrown untouched.
 */
export async function withRetry<T>(run: (onText: (delta: string) => void) => Promise<T>, o: RetryOptions): Promise<T> {
  const policy = { ...DEFAULT_POLICY, ...o.policy };
  const sleep = o.deps?.sleep ?? abortableSleep;
  const random = o.deps?.random ?? Math.random;
  let delivered = false;
  const onText = (delta: string) => {
    delivered = true;
    o.onText(delta);
  };
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    if (o.signal.aborted) throw abortError(o.signal);
    try {
      return await run(onText);
    } catch (e) {
      if (o.signal.aborted || !(e instanceof ProviderError)) throw e;
      e.attempts = attempt;
      if (delivered || !e.retryable || attempt >= policy.maxAttempts) throw gaveUp(e, attempt);
      const left = policy.maxTotalWaitMs - waited;
      const delay = e.retryAfterMs ?? Math.min(backoffDelay(attempt, policy, random), left);
      if (left <= 0 || delay > left) throw gaveUp(e, attempt);
      waited += delay;
      try {
        o.onRetry?.({ attempt, maxAttempts: policy.maxAttempts, delayMs: delay, kind: e.kind, status: e.status, message: e.message });
      } catch {}
      await sleep(delay, o.signal);
    }
  }
}

function gaveUp(e: ProviderError, attempt: number) {
  if (attempt > 1) e.message += ` Gave up after ${attempt} attempts.`;
  return e;
}
