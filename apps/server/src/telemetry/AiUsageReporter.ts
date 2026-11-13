/**
 * Gustaf AI usage: this host counts provider turns and tokens per UTC day, provider and model,
 * and sends the totals to the user's Gustaf account with the computer's device credential. Only
 * counts leave the machine. Each batch keeps its id until the cloud answers, so a retry counts once.
 *
 * @module AiUsageReporter
 */
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readCloudCredential } from "../relay/RelayHost.ts";
import { telemetryConsent } from "./AnalyticsService.ts";
import type { ModelLabeler, ProviderTurnReport } from "./ProviderUsageAnalytics.ts";

export interface AiUsageBucket {
  readonly day: string;
  readonly provider: string;
  /** Null when the turn's model is not in a vendor's public catalog. */
  readonly model: string | null;
  readonly turns: number;
  /** Turns whose provider reported both token counts; the token sums cover only these. */
  readonly measuredTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiUsageBatch {
  readonly batchId: string;
  readonly deviceId: string;
  readonly buckets: ReadonlyArray<AiUsageBucket>;
}

// The cloud's limits: larger batches are split, older days are refused.
const MAX_BATCH_BUCKETS = 500;
const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_TURNS = 4096;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

const FLUSH_INTERVAL = "5 minutes";
const SEND_TIMEOUT = "10 seconds";
const SHUTDOWN_FLUSH_TIMEOUT = "2 seconds";
// The cloud refused the batch itself or this computer's credential; resending cannot help.
const REJECTED_STATUSES = new Set([400, 401, 403, 413]);

const utcDay = (ms: number) => DateTime.formatIsoDate(DateTime.makeUnsafe(ms));
const bucketKey = (bucket: Pick<AiUsageBucket, "day" | "provider" | "model">) =>
  `${bucket.day}\n${bucket.provider}\n${bucket.model ?? ""}`;

/** One main-agent provider turn as a single-turn bucket, or undefined when it is not counted. */
export function usageTurn(
  report: ProviderTurnReport,
  label: ModelLabeler,
  nowMs: number,
): AiUsageBucket | undefined {
  // Native subagent turns carry their own provider turns; the main turn is the request.
  if (report.context?.segment === "native_child") return undefined;
  const { providerTurn } = report;
  const usage = providerTurn.turnTokenUsage;
  const observed = usage?.models?.length === 1 ? label(usage.models[0]!) : undefined;
  const selected =
    report.context === undefined ? undefined : label(report.context.modelSelection.model);
  const model = observed ?? selected;
  // A local command's counters describe its result, not model work.
  const measured =
    usage !== undefined &&
    usage.localCommand !== true &&
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined;
  const completedAt = providerTurn.completedAt;
  return {
    day: utcDay(completedAt ? DateTime.toEpochMillis(completedAt) : nowMs),
    provider: PROVIDER.test(report.driver) ? report.driver : "other",
    model: model !== undefined && MODEL.test(model) ? model : null,
    turns: 1,
    measuredTurns: measured ? 1 : 0,
    inputTokens: measured ? usage.inputTokens! : 0,
    outputTokens: measured ? usage.outputTokens! : 0,
  };
}

/**
 * Unsent counts of one computer credential. A batch in flight keeps its id until it is settled;
 * counts recorded meanwhile wait for the next batch. Counts of another device id are dropped,
 * so a sign-out or a new account never receives this computer's earlier usage.
 */
export class AiUsageLedger {
  private deviceId: string | null = null;
  private readonly buckets = new Map<string, AiUsageBucket>();
  private pending: AiUsageBatch | null = null;
  // A provider turn replayed after it completed must not count twice.
  private readonly counted = new Set<string>();

  add(deviceId: string, turnId: string, turn: AiUsageBucket): void {
    if (this.counted.has(turnId)) return;
    this.counted.add(turnId);
    if (this.counted.size > MAX_REMEMBERED_TURNS) {
      this.counted.delete(this.counted.values().next().value!);
    }
    if (this.deviceId !== deviceId) {
      this.buckets.clear();
      this.deviceId = deviceId;
    }
    const key = bucketKey(turn);
    const current = this.buckets.get(key);
    this.buckets.set(
      key,
      current === undefined
        ? turn
        : {
            ...current,
            turns: current.turns + turn.turns,
            measuredTurns: current.measuredTurns + turn.measuredTurns,
            inputTokens: current.inputTokens + turn.inputTokens,
            outputTokens: current.outputTokens + turn.outputTokens,
          },
    );
  }

  /** The batch to send for `deviceId`: the unsettled one, or a new one from waiting counts. */
  nextBatch(deviceId: string, newBatchId: () => string, nowMs: number): AiUsageBatch | undefined {
    if (this.pending !== null && this.pending.deviceId !== deviceId) this.pending = null;
    if (this.deviceId !== deviceId) this.clear();
    if (this.pending !== null) return this.pending;
    const oldest = utcDay(nowMs - MAX_AGE_DAYS * DAY_MS);
    const buckets: AiUsageBucket[] = [];
    for (const [key, bucket] of this.buckets) {
      if (buckets.length === MAX_BATCH_BUCKETS) break;
      this.buckets.delete(key);
      if (bucket.day >= oldest) buckets.push(bucket);
    }
    if (buckets.length === 0) return undefined;
    this.pending = { batchId: newBatchId(), deviceId, buckets };
    return this.pending;
  }

  /** The cloud stored or refused the batch; either way it is never sent again. */
  settle(batchId: string): void {
    if (this.pending?.batchId === batchId) this.pending = null;
  }

  clear(): void {
    this.buckets.clear();
    this.pending = null;
    this.deviceId = null;
  }
}

export class AiUsageReporter extends Context.Reference<{
  readonly record: (report: ProviderTurnReport, label: ModelLabeler) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}>("t3/telemetry/AiUsageReporter", {
  defaultValue: () => ({ record: () => Effect.void, flush: Effect.void }),
}) {}

export const make = Effect.gen(function* () {
  const enabled = yield* telemetryConsent;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const ledger = new AiUsageLedger();
  const flushLock = yield* Semaphore.make(1);
  const credential = readCloudCredential(secrets);

  const record = Effect.fn("AiUsageReporter.record")(function* (
    report: ProviderTurnReport,
    label: ModelLabeler,
  ) {
    if (!(yield* enabled)) return;
    // Only turns that finish while this computer is registered count; nothing is backfilled.
    const current = yield* credential;
    if (Option.isNone(current)) return;
    const turn = usageTurn(report, label, DateTime.toEpochMillis(yield* DateTime.now));
    if (turn !== undefined) {
      ledger.add(current.value.deviceId, String(report.providerTurn.id), turn);
    }
  });

  const send = Effect.fn("AiUsageReporter.send")(function* (
    target: { readonly relayUrl: string; readonly token: string },
    batch: AiUsageBatch,
  ) {
    const response = yield* HttpClientRequest.post(
      new URL("/v1/usage/reports", target.relayUrl).toString(),
    ).pipe(
      HttpClientRequest.bearerToken(target.token),
      HttpClientRequest.bodyJson({ batchId: batch.batchId, buckets: batch.buckets }),
      Effect.flatMap(httpClient.execute),
      Effect.timeout(SEND_TIMEOUT),
    );
    return response.status;
  });

  const flush = Effect.gen(function* () {
    if (!(yield* enabled)) return ledger.clear();
    const current = yield* credential;
    if (Option.isNone(current)) return ledger.clear();
    const target = current.value;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    while (true) {
      const batchId = yield* random.uuidV4().pipe(Effect.orElseSucceed(() => undefined));
      if (batchId === undefined) return;
      const batch = ledger.nextBatch(target.deviceId, () => batchId, nowMs);
      if (batch === undefined) return;
      const status = yield* send(target, batch).pipe(Effect.orElseSucceed(() => 0));
      if (status >= 200 && status < 300) {
        ledger.settle(batch.batchId);
        continue;
      }
      if (REJECTED_STATUSES.has(status)) {
        ledger.settle(batch.batchId);
        yield* Effect.logWarning("Dropped AI usage batch the Gustaf cloud refused", { status });
        continue;
      }
      // Unreachable or failing: the same batch id goes out again on the next flush.
      return;
    }
  }).pipe(flushLock.withPermit, Effect.withSpan("AiUsageReporter.flush"));

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL).pipe(Effect.andThen(flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    flush.pipe(Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT), Effect.ignore),
  );

  return { record, flush };
});

export const layer = Layer.effect(AiUsageReporter, make);
