import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as SubscriptionService from "../../../subscriptions/SubscriptionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as SubscriptionsHandlers from "./handlers.ts";
import { SubscriptionsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:subscriptions");
const threadId = ThreadId.make("thread:subscriptions");

const antigravity = {
  name: "Antigravity",
  amount: 5,
  currency: "USD",
  period: { unit: "month", count: 3 },
  anchorDate: "2026-11-10",
  status: { _tag: "Active" },
  reminderDaysBefore: null,
} as const;

const handlersFor = (runtimeMode: RuntimeMode) =>
  McpToolAccess.HandlersLayer.layer(SubscriptionsHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:subscriptions",
          thread: {
            threadId,
            providerSessionId: "provider:subscriptions",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { runtimeMode })),
        }),
        SubscriptionService.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provide(
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size))),
            ),
          ),
        ),
      ),
    ),
  );

const call = (
  name: keyof typeof SubscriptionsToolkit.tools,
  params: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* SubscriptionsToolkit;
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  });

it.effect("adds, edits, and deletes a subscription for a full-access agent", () =>
  Effect.gen(function* () {
    const added = (yield* call("t3_subscriptions_upsert", antigravity)) as {
      readonly id: string;
      readonly nextChargeDate: string | null;
    };
    expect(added).toMatchObject({ ...antigravity, nextChargeDate: expect.any(String) });

    yield* call("t3_subscriptions_upsert", { ...antigravity, id: added.id, amount: 6 });
    expect(yield* call("t3_subscriptions_list", {})).toMatchObject({
      subscriptions: [{ id: added.id, amount: 6 }],
      totals: [{ currency: "USD", yearly: 24 }],
    });

    yield* call("t3_subscriptions_delete", { id: added.id });
    expect(yield* call("t3_subscriptions_list", {})).toMatchObject({ subscriptions: [] });
    expect(yield* call("t3_subscriptions_upsert", { ...antigravity, id: added.id })).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.provide(handlersFor("full-access"))),
);

it.effect("refuses writes from an agent below full access, as Settings writes are", () =>
  Effect.gen(function* () {
    expect(yield* call("t3_subscriptions_upsert", antigravity)).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* call("t3_subscriptions_list", {})).toMatchObject({ subscriptions: [] });
  }).pipe(Effect.provide(handlersFor("approval-required"))),
);
