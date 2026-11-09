import {
  MessageId,
  NonNegativeInt,
  OrchestrationV2ProviderCapabilities,
  PositiveInt,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TextGenerationError,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import type { ProviderAdapterDriver } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { modelsFromTags, ollamaBaseUrl, readGenerateResponse } from "../http.ts";
import { OllamaSettings } from "../settings.ts";

export const OLLAMA_DRIVER_KIND = ProviderDriverKind.make("ollama");

const decodePositive = Schema.decodeSync(PositiveInt);
const decodeNonNegative = Schema.decodeSync(NonNegativeInt);

export class OllamaRequestError extends Schema.TaggedError<OllamaRequestError>()(
  "OllamaRequestError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OLLAMA_CAPABILITIES = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "weak",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export function providerModels(names: ReadonlyArray<string>): ReadonlyArray<ServerProviderModel> {
  return names.map((name, index) => ({
    slug: name,
    name,
    isCustom: false,
    capabilities: null,
    ...(index === 0 ? { isDefault: true } : {}),
  }));
}

type Http = HttpClient.HttpClient;

const executeJson = Effect.fn("Ollama.executeJson")(function* (
  http: Http,
  request: HttpClientRequest.HttpClientRequest,
) {
  const response = yield* http.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new OllamaRequestError({
          detail: "Couldn't reach Ollama. Check that it is running.",
          cause,
        }),
    ),
  );
  const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof body === "string" ? body : `Ollama returned ${response.status}.`;
    return yield* new OllamaRequestError({ detail: detail.slice(0, 500) });
  }
  return body;
});

export const listOllamaModels = Effect.fn("Ollama.listModels")(function* (
  http: Http,
  baseUrl: string,
) {
  const body = yield* executeJson(http, HttpClientRequest.get(`${baseUrl}/api/tags`));
  return modelsFromTags(body);
});

const resolveModel = Effect.fn("Ollama.resolveModel")(function* (
  http: Http,
  baseUrl: string,
  model: string,
) {
  if (model.length > 0 && model !== "default") return model;
  const names = yield* listOllamaModels(http, baseUrl);
  const first = names[0];
  if (first === undefined) {
    return yield* new OllamaRequestError({
      detail: `No models are installed at ${baseUrl}.`,
    });
  }
  return first;
});

const chat = Effect.fn("Ollama.chat")(function* (
  http: Http,
  input: {
    readonly baseUrl: string;
    readonly model: string;
    readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>;
  },
) {
  const body = yield* executeJson(
    http,
    HttpClientRequest.post(`${input.baseUrl}/api/chat`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: input.model,
        messages: input.messages,
        stream: false,
      }),
    ),
  );
  const text = readGenerateResponse(
    typeof body === "object" && body !== null && "message" in body
      ? { response: messageContent(body.message) }
      : body,
  );
  if (text.length === 0) {
    return yield* new OllamaRequestError({ detail: "Ollama returned an empty reply." });
  }
  return text;
});

function messageContent(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  return typeof message.content === "string" ? message.content : "";
}

export const completeOllama = Effect.fn("Ollama.complete")(function* (
  http: Http,
  input: { readonly baseUrl: string; readonly model: string; readonly prompt: string },
) {
  const model = yield* resolveModel(http, input.baseUrl, input.model);
  const body = yield* executeJson(
    http,
    HttpClientRequest.post(`${input.baseUrl}/api/generate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model, prompt: input.prompt, stream: false }),
    ),
  );
  const text = readGenerateResponse(body);
  if (text.length === 0) {
    return yield* new OllamaRequestError({ detail: "Ollama returned an empty reply." });
  }
  return text;
});

function makeAdapter(input: {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
  readonly baseUrl: string;
  readonly http: Http;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: OLLAMA_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(OLLAMA_CAPABILITIES),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: Effect.fn("Ollama.openSession")(function* (sessionInput) {
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const scope = yield* Scope.Scope;
      yield* Effect.addFinalizer(() => Queue.shutdown(events));
      const history = new Map<
        string,
        Array<{ role: "user" | "assistant"; content: string }>
      >();
      const turns = new Map<string, Fiber.Fiber<void, never>>();
      const now = yield* DateTime.now;
      const providerSession = {
        id: sessionInput.providerSessionId,
        driver: OLLAMA_DRIVER_KIND,
        providerInstanceId: input.instanceId,
        status: "ready" as const,
        cwd: sessionInput.runtimePolicy.cwd ?? "",
        model: sessionInput.modelSelection.model,
        capabilities: OLLAMA_CAPABILITIES,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const offer = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event);
      const ensureThread = Effect.fn("Ollama.ensureThread")(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const createdAt = yield* DateTime.now;
        return {
          id: ProviderThreadId.make(`provider-thread:ollama:${threadInput.threadId}`),
          driver: OLLAMA_DRIVER_KIND,
          providerInstanceId: input.instanceId,
          providerSessionId: sessionInput.providerSessionId,
          appThreadId: threadInput.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: OLLAMA_DRIVER_KIND,
            nativeId: `ollama:${threadInput.threadId}`,
            strength: "weak" as const,
          },
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          contextUsage: null,
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
        } satisfies OrchestrationV2ProviderThread;
      });
      const startTurn = Effect.fn("Ollama.startTurn")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const providerTurnId = ProviderTurnId.make(
          `provider-turn:ollama:${turnInput.threadId}:${turnInput.runOrdinal}`,
        );
        const prior = history.get(turnInput.providerThread.id) ?? [];
        const messages = [...prior, { role: "user" as const, content: turnInput.message.text }];
        history.set(turnInput.providerThread.id, messages);
        const run = Effect.gen(function* () {
          const model = yield* resolveModel(
            input.http,
            input.baseUrl,
            turnInput.modelSelection.model,
          );
          const text = yield* chat(input.http, {
            baseUrl: input.baseUrl,
            model,
            messages,
          });
              const eventTime = yield* DateTime.now;
              const providerTurn = {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: null,
                ordinal: decodePositive(turnInput.runOrdinal),
                status: "completed" as const,
                startedAt: eventTime,
                completedAt: eventTime,
              } satisfies OrchestrationV2ProviderTurn;
              history.set(turnInput.providerThread.id, [
                ...messages,
                { role: "assistant" as const, content: text },
              ]);
              yield* offer({
                type: "provider_turn.updated",
                driver: OLLAMA_DRIVER_KIND,
                providerTurn,
              });
              yield* offer({
                type: "turn_item.updated",
                driver: OLLAMA_DRIVER_KIND,
                turnItem: {
                  id: TurnItemId.make(
                    `turn-item:ollama:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: decodeNonNegative(turnInput.runOrdinal),
                  status: "completed",
                  title: null,
                  startedAt: eventTime,
                  completedAt: eventTime,
                  updatedAt: eventTime,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:ollama:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  text,
                  streaming: false,
                },
              });
              yield* offer({
                type: "turn.terminal",
                driver: OLLAMA_DRIVER_KIND,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: decodePositive(turnInput.runOrdinal),
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
          }).pipe(
          Effect.catch((error) =>
            offer({
              type: "turn.terminal",
              driver: OLLAMA_DRIVER_KIND,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              runOrdinal: decodePositive(turnInput.runOrdinal),
              status: "failed",
              failureItemOrdinal: decodePositive(1),
              failure: {
                class: "provider_error",
                message: error.detail.slice(0, 4_000) || "Ollama request failed.",
                code: "ollama_error",
                retryable: true,
              },
              threadDisposition: "reusable",
            }).pipe(Effect.asVoid),
          ),
          Effect.onInterrupt(() =>
            offer({
              type: "turn.terminal",
              driver: OLLAMA_DRIVER_KIND,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              runOrdinal: decodePositive(turnInput.runOrdinal),
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            }).pipe(Effect.asVoid),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              turns.delete(turnInput.providerThread.id);
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(scope)(run);
        turns.set(turnInput.providerThread.id, fiber);
      });
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: input.instanceId,
        driver: OLLAMA_DRIVER_KIND,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        canResumeAfterRestart: false,
        events: Stream.fromQueue(events),
        ensureThread,
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        injectHistory: (historyInput) =>
          Effect.sync(() => {
            const grouped = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
            for (const message of historyInput.messages) {
              const key = message.providerThreadId ?? sessionInput.providerSessionId;
              const current = grouped.get(key) ?? [];
              current.push({ role: message.role, content: message.text });
              grouped.set(key, current);
            }
            for (const [key, messages] of grouped) history.set(key, messages);
            return true;
          }),
        startTurn,
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: OLLAMA_DRIVER_KIND,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) => {
          const fiber = turns.get(interruptInput.providerThread.id);
          return fiber ? Fiber.interrupt(fiber) : Effect.void;
        },
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({
            providerThread: snapshotInput.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: OLLAMA_DRIVER_KIND,
              providerThreadId: rollbackInput.providerThread.id,
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: OLLAMA_DRIVER_KIND,
              providerThreadId: forkInput.sourceProviderThread.id,
            }),
          ),
      };
      return runtime;
    }),
  };
}

const decodeSettings = Schema.decodeSync(OllamaSettings);

export const OllamaAdapterV2Driver: ProviderAdapterDriver<OllamaSettings, HttpClient.HttpClient> = {
  driverKind: OLLAMA_DRIVER_KIND,
  configSchema: OllamaSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OllamaAdapterV2Driver.create")(
    function* (input) {
      const http = yield* HttpClient.HttpClient;
      return makeAdapter({
        instanceId: input.instanceId,
        baseUrl: ollamaBaseUrl(input.config.baseUrl),
        http,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OLLAMA_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Ollama adapter.",
              cause,
            }),
        ),
      ),
  ),
};

function ask(http: Http, baseUrl: string, modelSelection: ModelSelection, prompt: string, operation: string) {
  return completeOllama(http, { baseUrl, model: modelSelection.model, prompt }).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation,
          detail: cause.detail,
          cause,
        }),
    ),
  );
}

export function makeOllamaTextGeneration(http: Http, baseUrl: string): ProviderTextGeneration {
  return {
    generateTranscriptionPostProcessing: (input) =>
      ask(http, baseUrl, input.modelSelection, input.prompt, "generateTranscriptionPostProcessing").pipe(
        Effect.map((transcription) => ({ transcription })),
      ),
    generateCommitMessage: (input) =>
      ask(
        http,
        baseUrl,
        input.modelSelection,
        `Write a git commit subject and body for this diff.\n\n${input.stagedSummary}\n${input.stagedPatch}`,
        "generateCommitMessage",
      ).pipe(
        Effect.map((text) => {
          const [subject, ...rest] = text.split("\n");
          return { subject: subject ?? text, body: rest.join("\n").trim() };
        }),
      ),
    generatePrContent: (input) =>
      ask(
        http,
        baseUrl,
        input.modelSelection,
        `Write a pull request title and body.\n\n${input.commitSummary}\n${input.diffSummary}`,
        "generatePrContent",
      ).pipe(
        Effect.map((text) => {
          const [title, ...rest] = text.split("\n");
          return { title: title ?? text, body: rest.join("\n").trim() };
        }),
      ),
    generateBranchName: (input) =>
      ask(
        http,
        baseUrl,
        input.modelSelection,
        `Reply with one git branch name for: ${input.message}`,
        "generateBranchName",
      ).pipe(Effect.map((branch) => ({ branch: branch.split("\n")[0] ?? branch }))),
    generateThreadTitle: (input) =>
      ask(
        http,
        baseUrl,
        input.modelSelection,
        `Reply with a short chat title and nothing else.\n\n${input.message}`,
        "generateThreadTitle",
      ).pipe(
        Effect.map((title) => ({
          title: (title.split("\n")[0] ?? title).replace(/^["']|["']$/g, ""),
        })),
      ),
    generateReviewGuide: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateReviewGuide",
          detail: "Ollama does not generate pull request review guides.",
        }),
      ),
  };
}
