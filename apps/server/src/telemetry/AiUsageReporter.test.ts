import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { AiUsageLedger, AiUsageReporter, layer, usageTurn } from "./AiUsageReporter.ts";
import type { ProviderTurnReport } from "./ProviderUsageAnalytics.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const label = (model: string) => (model.startsWith("gpt-") ? model : undefined);

const turn = (
  id: string,
  usage: Partial<TurnTokenUsage> | undefined,
  completedAt = NOW,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(id),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make(`node:${id}`),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: DateTime.makeUnsafe(completedAt - 1_000),
  completedAt: DateTime.makeUnsafe(completedAt),
  ...(usage === undefined
    ? {}
    : {
        turnTokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          ...usage,
        } as TurnTokenUsage,
      }),
});

const report = (
  providerTurn: OrchestrationV2ProviderTurn,
  model = "gpt-6.1",
  segment: "initial" | "native_child" = "initial",
): ProviderTurnReport => ({
  driver: "codex",
  providerTurn,
  context: {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
    segment,
  },
});

describe("usageTurn", () => {
  it("keeps unknown token counts apart from zero", () => {
    const counted = (usage: Partial<TurnTokenUsage> | undefined) => {
      const bucket = usageTurn(report(turn("t", usage)), label, NOW)!;
      return [bucket.measuredTurns, bucket.inputTokens, bucket.outputTokens];
    };
    expect(counted({ inputTokens: 0, outputTokens: 0 })).toEqual([1, 0, 0]);
    expect(counted({ inputTokens: 120, outputTokens: 30 })).toEqual([1, 120, 30]);
    expect(counted(undefined)).toEqual([0, 0, 0]);
    expect(counted({ usageStatus: "partial", inputTokens: 120 })).toEqual([0, 0, 0]);
    expect(counted({ inputTokens: 5, outputTokens: 5, localCommand: true })).toEqual([0, 0, 0]);
  });

  it("names only catalog models, skips native subagent turns and days by completion", () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    expect(usageTurn(report(turn("t", undefined, yesterday)), label, NOW)).toMatchObject({
      day: "2026-11-12",
      provider: "codex",
      model: "gpt-6.1",
      turns: 1,
    });
    // A user-defined model name stays on the machine.
    expect(usageTurn(report(turn("t", undefined), "my-private-finetune"), label, NOW)?.model).toBe(
      null,
    );
    // The observed model wins over the selected one when the provider names exactly one.
    expect(
      usageTurn(report(turn("t", { models: ["gpt-6.1-mini"] }), "gpt-6.1"), label, NOW)?.model,
    ).toBe("gpt-6.1-mini");
    expect(usageTurn(report(turn("t", undefined), "gpt-6.1", "native_child"), label, NOW)).toBe(
      undefined,
    );
  });
});

describe("AiUsageLedger", () => {
  const bucket = (overrides: Partial<Parameters<AiUsageLedger["add"]>[2]> = {}) => ({
    day: "2026-11-13",
    provider: "codex",
    model: "gpt-6.1",
    turns: 1,
    measuredTurns: 1,
    inputTokens: 100,
    outputTokens: 10,
    ...overrides,
  });

  it("resends an unsettled batch under the same id and counts a replayed turn once", () => {
    const ledger = new AiUsageLedger();
    let ids = 0;
    const nextId = () => `batch-${++ids}`;
    ledger.add("device-a", "turn-1", bucket());
    ledger.add("device-a", "turn-1", bucket());
    ledger.add("device-a", "turn-2", bucket({ measuredTurns: 0, inputTokens: 0, outputTokens: 0 }));
    const first = ledger.nextBatch("device-a", nextId, NOW)!;
    expect(first.buckets).toEqual([
      bucket({ turns: 2, measuredTurns: 1, inputTokens: 100, outputTokens: 10 }),
    ]);
    // Counts arriving while the batch is unanswered wait for the next one.
    ledger.add("device-a", "turn-3", bucket());
    expect(ledger.nextBatch("device-a", nextId, NOW)).toBe(first);
    ledger.settle(first.batchId);
    const second = ledger.nextBatch("device-a", nextId, NOW)!;
    expect(second.batchId).toBe("batch-2");
    expect(second.buckets).toEqual([bucket()]);
    ledger.settle(second.batchId);
    expect(ledger.nextBatch("device-a", nextId, NOW)).toBe(undefined);
  });

  it("drops counts of another credential and days the cloud would refuse", () => {
    const ledger = new AiUsageLedger();
    ledger.add("device-a", "turn-1", bucket());
    ledger.add("device-a", "turn-2", bucket({ day: "2026-10-01" }));
    expect(ledger.nextBatch("device-b", () => "b", NOW)).toBe(undefined);
    ledger.add("device-a", "turn-3", bucket({ day: "2026-10-01" }));
    ledger.add("device-a", "turn-4", bucket());
    expect(ledger.nextBatch("device-a", () => "a", NOW)?.buckets).toEqual([bucket()]);
  });
});

describe("AiUsageReporter", () => {
  const credential = {
    relayUrl: "https://cloud.example.test",
    deviceId: "device-a",
    token: "gdt_x",
  };
  const setup = (options: { enabled?: boolean; signedIn?: boolean; statuses: number[] }) => {
    const sent: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        sent.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(new TextDecoder().decode(body)),
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: options.statuses.shift() ?? 200 }),
        );
      }),
    );
    const secret = new TextEncoder().encode(JSON.stringify(credential));
    const layerTest = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () =>
              Effect.succeed(options.signedIn === false ? Option.none() : Option.some(secret)),
          }),
          ManagedPolicy.layerTest(),
          NodeCrypto.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: options.enabled ?? true }),
          ),
        ),
      ),
    );
    return { sent, layerTest };
  };

  const recordTwoTurns = Effect.gen(function* () {
    const reporter = yield* AiUsageReporter;
    const today = DateTime.toEpochMillis(yield* DateTime.now);
    yield* reporter.record(report(turn("t1", { inputTokens: 10, outputTokens: 1 }, today)), label);
    yield* reporter.record(report(turn("t2", undefined, today)), label);
    return reporter;
  });

  it.effect("retries a failed upload with the same batch id and stops once it is stored", () => {
    const { sent, layerTest } = setup({ statuses: [503, 200] });
    return Effect.gen(function* () {
      const reporter = yield* recordTwoTurns;
      yield* reporter.flush;
      yield* reporter.flush;
      yield* reporter.flush;
      expect(sent).toHaveLength(2);
      expect(sent[0]!.url).toBe("https://cloud.example.test/v1/usage/reports");
      expect(sent[0]!.authorization).toBe("Bearer gdt_x");
      expect(sent[1]!.body).toEqual(sent[0]!.body);
      expect(sent[0]!.body).toMatchObject({
        buckets: [
          {
            provider: "codex",
            model: "gpt-6.1",
            turns: 2,
            measuredTurns: 1,
            inputTokens: 10,
            outputTokens: 1,
          },
        ],
      });
      // Only the allowed fields leave the machine.
      expect(Object.keys((sent[0]!.body as { buckets: object[] }).buckets[0]!).toSorted()).toEqual([
        "day",
        "inputTokens",
        "measuredTurns",
        "model",
        "outputTokens",
        "provider",
        "turns",
      ]);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("drops a batch the cloud refuses instead of resending it", () => {
    const { sent, layerTest } = setup({ statuses: [401] });
    return Effect.gen(function* () {
      const reporter = yield* recordTwoTurns;
      yield* reporter.flush;
      yield* reporter.flush;
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("counts nothing when telemetry is off or the computer is not registered", () =>
    Effect.gen(function* () {
      for (const options of [{ enabled: false }, { signedIn: false }]) {
        const { sent, layerTest } = setup({ ...options, statuses: [] });
        yield* Effect.gen(function* () {
          const reporter = yield* recordTwoTurns;
          yield* reporter.flush;
        }).pipe(Effect.provide(layerTest));
        expect(sent).toHaveLength(0);
      }
    }),
  );
});
