import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { parseSessionUpdateEvent } from "@t3tools/provider-acp/server/runtimeModel";
import { withAcpKeepAlive } from "../../provider/acp/AcpJsonRpcConnection.ts";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import { makeAntigravityPromptGuard } from "../../provider/acp/AntigravityPromptGuard.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  ANTIGRAVITY_STREAM_INTERRUPTED_MESSAGE,
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityBackgroundLogPath,
  extractAntigravityBackgroundTaskCompletion,
  extractAntigravityBackgroundTaskId,
  extractAntigravityBackgroundToolMutation,
  extractAntigravityUserInputQuestion,
  isAntigravityBackgroundCommandTool,
  isAntigravityPersistentBackgroundTool,
  isAntigravityStreamInterrupted,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
}

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * Only permission prompts carry the launch; NativeChildWorkQuery matches their ids by this text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

interface AntigravityFlavorServices {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      const watchedTasks = new Set<string>();
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          withAcpKeepAlive(
            runtime,
            Effect.gen(function* () {
              yield* Effect.sync(reads.reset);
              const runPrompt = runtime.prompt(payload, promptOptions).pipe(
                Effect.flatMap((response) => {
                  if (response.stopReason === "error") {
                    const errText =
                      typeof response.error === "string"
                        ? response.error
                        : Predicate.isObject(response.error) &&
                            "message" in response.error &&
                            typeof response.error.message === "string"
                          ? response.error.message
                          : "";
                    if (isAntigravityStreamInterrupted(errText)) {
                      return Effect.fail(
                        new EffectAcpErrors.AcpTransportError({ detail: errText, cause: errText }),
                      );
                    }
                  }
                  return Effect.succeed(response);
                }),
              );

              const isInterruptedError = (error: unknown): boolean =>
                Predicate.isObject(error) &&
                (("detail" in error &&
                  typeof error.detail === "string" &&
                  isAntigravityStreamInterrupted(error.detail)) ||
                  ("message" in error &&
                    typeof error.message === "string" &&
                    isAntigravityStreamInterrupted(error.message)));

              const retrySchedule = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);

              return yield* runPrompt.pipe(
                Effect.retry({
                  times: 3,
                  schedule: retrySchedule,
                  while: isInterruptedError,
                }),
                Effect.catchIf(isInterruptedError, (error) =>
                  Effect.succeed<EffectAcpSchema.PromptResponse>({
                    stopReason: "error",
                    error: {
                      code: -32603,
                      message:
                        ("detail" in error && typeof error.detail === "string"
                          ? error.detail
                          : undefined) ?? ANTIGRAVITY_STREAM_INTERRUPTED_MESSAGE,
                    },
                  }),
                ),
              );
            }),
          ),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            Effect.gen(function* () {
              const repaired = reads.repair(notification);
              const update = repaired.update;
              if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                for (const event of parseSessionUpdateEvent(repaired).events) {
                  if (event._tag !== "ToolCallUpdated") continue;
                  const toolCall = normalizeAntigravityToolCall(event.toolCall);
                  const bgLog = extractAntigravityBackgroundLogPath(toolCall);
                  if (bgLog !== undefined && !watchedTasks.has(bgLog.taskId)) {
                    watchedTasks.add(bgLog.taskId);
                    const logPath = bgLog.logPath;
                    const targetToolCallId = toolCall.toolCallId;
                    const sessionId = notification.sessionId;

                    yield* Effect.gen(function* () {
                      let lastSize = 0;
                      while (true) {
                        yield* Effect.sleep("1500 millis");
                        const exists = yield* options.fileSystem
                          .exists(logPath)
                          .pipe(Effect.orElseSucceed(() => false));
                        if (!exists) continue;
                        const content = yield* options.fileSystem
                          .readFileString(logPath)
                          .pipe(Effect.orElseSucceed(() => ""));
                        if (content.length > lastSize) {
                          lastSize = content.length;
                          const isDone =
                            content.includes("Command exited with code") ||
                            content.includes("finished with result");
                          const isFailed = /Command exited with code\s+([1-9]\d*)/i.test(content);
                          if (projectUpdate !== undefined) {
                            yield* projectUpdate({
                              sessionId,
                              update: {
                                sessionUpdate: "tool_call_update",
                                toolCallId: targetToolCallId,
                                status: isDone
                                  ? isFailed
                                    ? "failed"
                                    : "completed"
                                  : "in_progress",
                                rawOutput: { type: "Text", text: content },
                              },
                            }).pipe(Effect.ignore);
                          }
                          if (isDone) break;
                        }
                      }
                    }).pipe(Effect.forkIn(scope));
                  }
                }
              }
              return yield* updates.withPermit(handler(repaired));
            }),
          );
        },
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      } satisfies typeof runtime;
    },
    Effect.provideService(SecureRandom.SecureRandom, options.random),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    buildPrompt: ({
      text,
      attachments,
      resolveAttachmentPath,
      promptCapabilities,
      agentVersion,
      currentModel,
    }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
        agentVersion,
        currentModel,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    preserveRuntimeOnSettledInterrupt: true,
    deferFinalizeForBackgroundWork: true,
    isProvisionalSubagentTool: (toolCall) =>
      classifyAntigravitySubagentToolCall(toolCall) === "subagent",
    isPersistentBackgroundTool: isAntigravityPersistentBackgroundTool,
    extractBackgroundTaskId: extractAntigravityBackgroundTaskId,
    extractBackgroundToolMutation: extractAntigravityBackgroundToolMutation,
    extractBackgroundTaskCompletion: extractAntigravityBackgroundTaskCompletion,
    isBackgroundCommandTool: isAntigravityBackgroundCommandTool,
    subagentsIdleOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      const targetModel =
        modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model: targetModel,
        defaultModel,
        mapError: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Failed to switch Antigravity model immediately; deferring selection for next turn",
          ).pipe(
            Effect.annotateLogs({
              targetModel: targetModel ?? defaultModel,
              error: String(cause),
            }),
            Effect.as(targetModel ?? defaultModel),
          ),
        ),
      );
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    // ACP 1.3.0 treats /compact as ordinary model input.
    supportsCompaction: false,
    requiresSignIn: isAntigravitySignInRequiredError,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
    makePromptGuard: makeAntigravityPromptGuard,
    // 1.4.5 returns the root trajectory's Gemini usageMetadata delta; 1.4.1 returns none.
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: (sessionId: string) =>
            watchAntigravityPromptOutcome(profileDirectory, sessionId),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    random: yield* SecureRandom.SecureRandom,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
