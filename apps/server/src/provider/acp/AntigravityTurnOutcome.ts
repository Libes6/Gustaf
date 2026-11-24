// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
// Status is a gRPC code, or an HTTP status line such as "502 Bad Gateway". A message
// stops at the next error, so each start scans its own span and the match stays linear.
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
// Claude rejects a saved thinking block without a valid signature. It sits in the native
// history, so every later prompt to that session fails the same way.
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;
// The executor error of a session whose MCP server did not start (agy 1.4.x).
const MCP_LOAD_FAILED = /\bMCP load failed for ['"]?([^'"\s:,]+)/;

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
  readonly reachedModel: boolean;
}

class AntigravitySessionLogError extends Schema.TaggedError<AntigravitySessionLogError>()(
  "AntigravitySessionLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session log.";
  }
}

const sessionLogError = (cause: unknown) => new AntigravitySessionLogError({ cause });

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: sessionLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    const reachedModel =
      database
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(index, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    return {
      type: row.type,
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      reachedModel,
    };
  };

function resetAtFrom(text: string, now: DateTime.Utc | undefined): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Option.isSome(DateTime.make(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined || now === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : undefined;
}

const MCP_SERVER_FAILED_CODE = "ANTIGRAVITY_MCP_SERVER_FAILED";
const MCP_SERVER_NEEDS_AUTH_CODE = "ANTIGRAVITY_MCP_SERVER_NEEDS_AUTH";
const MCP_SERVER_FAILED_MESSAGE = /^Antigravity could not start the MCP server "([^"]+)"/;
const UNAUTHORIZED = /\b401\b|unauthori[sz]ed/i;

/**
 * agy refuses every turn, without asking the model, while one of its MCP servers fails to start.
 * `reason` is the harness's own text; a server that refused without sign-in needs one.
 */
export const antigravityMcpServerFailure = (server: string, reason: string) =>
  UNAUTHORIZED.test(reason)
    ? makeProviderFailure({
        class: "provider_error",
        code: MCP_SERVER_NEEDS_AUTH_CODE,
        message: `Antigravity could not start the MCP server "${server}" because it needs sign-in, and refuses every turn while it is in the session. Sign in to it or turn it off for Antigravity in Settings → MCP, then send the message again.`,
        retryable: false,
      })
    : makeProviderFailure({
        class: "provider_error",
        code: MCP_SERVER_FAILED_CODE,
        message: `Antigravity could not start the MCP server "${server}" and refuses every turn while it is in the session. Fix the server or turn it off for Antigravity in Settings → MCP, then send the message again.`,
        retryable: false,
      });

/** The server an `antigravityMcpServerFailure` names. */
export const antigravityFailedMcpServer = (failure: OrchestrationV2ProviderFailure) => {
  if (failure.code !== MCP_SERVER_FAILED_CODE && failure.code !== MCP_SERVER_NEEDS_AUTH_CODE) {
    return undefined;
  }
  const id = MCP_SERVER_FAILED_MESSAGE.exec(failure.message)?.[1];
  return id === undefined
    ? undefined
    : { id, needsAuth: failure.code === MCP_SERVER_NEEDS_AUTH_CODE };
};

// Reorders STATUS_ERROR's groups to API_ERROR's: HTTP status, message, status name.
function statusError(text: string) {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

const quotaFailure = (
  text: string,
  apiError: ReturnType<typeof statusError> | RegExpExecArray | null,
  now: DateTime.Utc | undefined,
) =>
  makeProviderFailure({
    class: "usage_limit",
    message: "You have reached your Antigravity quota for this period.",
    code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
    retryable: true,
    resetAt: resetAtFrom(text, now) ?? null,
  });

/** The quota or rate limit in a harness error, as its chat message carries it. */
export function antigravityLimitFailure(
  text: string,
  now: DateTime.Utc,
): OrchestrationV2ProviderFailure | undefined {
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  if (QUOTA_EXHAUSTED.test(text)) return quotaFailure(text, apiError, now);
  if (apiError === null) return undefined;
  const [, httpStatus, message, status] = apiError;
  if (httpStatus !== "429" && status !== "RESOURCE_EXHAUSTED") return undefined;
  return makeProviderFailure({
    class: "usage_limit",
    message: message!.trim(),
    code: status ?? null,
    retryable: true,
    resetAt: resetAtFrom(text, now) ?? null,
  });
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc | undefined,
):
  | {
      readonly failure: OrchestrationV2ProviderFailure;
      readonly threadDisposition: "reusable" | "broken";
      readonly resumeWith?: string;
    }
  | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  const reusable = (failure: OrchestrationV2ProviderFailure) =>
    ({ failure, threadDisposition: "reusable" }) as const;
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return reusable(quotaFailure(text, apiError, now));
  }
  const mcpServer = MCP_LOAD_FAILED.exec(text)?.[1];
  if (mcpServer !== undefined) return reusable(antigravityMcpServerFailure(mcpServer, text));
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return {
      failure: makeProviderFailure({
        class: "provider_error",
        message:
          "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
        code: "INVALID_THINKING_SIGNATURE",
        retryable: true,
      }),
      threadDisposition: "broken",
    };
  }
  if (apiError === null) {
    return reusable(
      makeProviderFailure({
        class: "provider_error",
        message: "Antigravity stopped this turn because of an error.",
      }),
    );
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  // A 404 before the model answered is an unknown or unentitled model; after, a transient edge error.
  const transientNotFound = httpStatus === "404" && step?.reachedModel === true;
  const failure = makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: message!.trim(),
    code: status ?? null,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, now) ?? null,
  });
  return transientNotFound
    ? { failure, threadDisposition: "reusable", resumeWith: "continue" }
    : reusable(failure);
}

const conversationSegments = ["antigravity-acp", "conversations"];

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
) {
  const typedOnly = (result: EffectAcpSchema.PromptResponse) =>
    DateTime.now.pipe(Effect.map((now) => turnFailure(result.stopReason, undefined, now)));
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      // A path that exists but fails the proof is a link or other foreign entry.
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, startIndex: -1 };
      }
      return { root, identity: database.info, startIndex: undefined };
    },
    catch: sessionLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return typedOnly;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return typedOnly;
  }
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean },
  ) {
    // The same file as before the prompt, or one this prompt created, still unlinked.
    const after = yield* Effect.tryPromise({
      try: () => antigravityManagedPath(before.root, segments, "file"),
      catch: sessionLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const sameFile =
      after !== undefined &&
      (before.identity === undefined ||
        (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    const step = sameFile
      ? yield* readSteps(after.path, lastStepAfter(startIndex)).pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not read the Antigravity session log after the prompt."),
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    // A retired prompt's check runs long after the error, so a relative delay has no anchor.
    const now = options?.retired === true ? undefined : yield* DateTime.now;
    return turnFailure(result.stopReason, step, now);
  });
});
