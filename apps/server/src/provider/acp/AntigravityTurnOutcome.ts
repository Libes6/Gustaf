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

import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import { classifyAntigravitySubagentToolCall } from "./AntigravityProtocol.ts";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
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

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
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
    return { type: row.type, payload: row.payload instanceof Uint8Array ? row.payload : null };
  };

function resetAtFrom(text: string, now: DateTime.Utc): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Option.isSome(DateTime.make(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : undefined;
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc,
): OrchestrationV2ProviderFailure | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  if (stopReason === "refusal") return quotaFailure(text, now);
  const limit = antigravityLimitFailure(text, now);
  if (limit !== undefined) return limit;
  const apiError = API_ERROR.exec(text);
  if (apiError === null) {
    return makeProviderFailure({
      class: "provider_error",
      message: "Antigravity stopped this turn because of an error.",
    });
  }
  const [, httpStatus, message, status] = apiError;
  return makeProviderFailure({
    class: "provider_error",
    message: message!.trim(),
    code: status ?? null,
    retryable: Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, now) ?? null,
  });
}

const quotaFailure = (text: string, now: DateTime.Utc) =>
  makeProviderFailure({
    class: "usage_limit",
    message: "You have reached your Antigravity quota for this period.",
    code: API_ERROR.exec(text)?.[3] ?? "QUOTA_EXHAUSTED",
    retryable: true,
    resetAt: resetAtFrom(text, now) ?? null,
  });

/** The quota or rate limit in a harness error, as its session log or its chat message carries it. */
export function antigravityLimitFailure(
  text: string,
  now: DateTime.Utc,
): OrchestrationV2ProviderFailure | undefined {
  if (QUOTA_EXHAUSTED.test(text)) return quotaFailure(text, now);
  const apiError = API_ERROR.exec(text);
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

function unfinishedToolsFailure(
  result: EffectAcpSchema.PromptResponse,
  tools: ReadonlyArray<AcpToolCallState>,
): OrchestrationV2ProviderFailure | undefined {
  if (result.stopReason !== "end_turn") return undefined;
  const unfinished = tools.some(
    (tool) =>
      (tool.status === "pending" ||
        tool.status === "inProgress" ||
        tool.status === "requiresAction") &&
      classifyAntigravitySubagentToolCall(tool) !== "subagent",
  );
  return unfinished
    ? makeProviderFailure({
        class: "provider_error",
        code: "ANTIGRAVITY_UNFINISHED_TOOLS",
        message:
          "Antigravity ended the turn without completing a tool call. Background work is unconfirmed. Ask the agent to check the command or subagent status explicitly.",
        retryable: false,
      })
    : undefined;
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
  const typedOnly = (
    result: EffectAcpSchema.PromptResponse,
    tools: ReadonlyArray<AcpToolCallState> = [],
  ) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          turnFailure(result.stopReason, undefined, now) ?? unfinishedToolsFailure(result, tools),
      ),
    );
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
    tools: ReadonlyArray<AcpToolCallState> = [],
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
    return (
      turnFailure(result.stopReason, step, yield* DateTime.now) ??
      unfinishedToolsFailure(result, tools)
    );
  });
});
