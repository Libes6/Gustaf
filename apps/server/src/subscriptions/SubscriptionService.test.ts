import { SubscriptionId, type SubscriptionUpsertInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SubscriptionService from "./SubscriptionService.ts";

const antigravity: SubscriptionUpsertInput = {
  name: "Antigravity",
  amount: 5,
  currency: "USD",
  period: { unit: "month", count: 3 },
  anchorDate: "2026-10-01",
  status: { _tag: "Active" },
  reminderDaysBefore: 3,
};

const layer = SubscriptionService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size))),
    ),
  ),
);

it.effect("creates, edits, lists, and deletes subscriptions", () =>
  Effect.gen(function* () {
    const service = yield* SubscriptionService.SubscriptionService;
    const created = yield* service.upsert(antigravity);
    const spotify = yield* service.upsert({
      ...antigravity,
      name: "Spotify",
      period: { unit: "month", count: 1 },
    });
    yield* service.upsert({
      ...antigravity,
      id: created.id,
      status: { _tag: "Cancelled", activeUntil: "2026-12-31" },
    });

    expect(yield* service.list()).toEqual([
      { ...antigravity, id: created.id, status: { _tag: "Cancelled", activeUntil: "2026-12-31" } },
      spotify,
    ]);

    yield* service.delete({ id: created.id });
    expect((yield* service.list()).map((subscription) => subscription.name)).toEqual(["Spotify"]);
    const staleEdit = yield* service.upsert({ ...antigravity, id: created.id }).pipe(Effect.flip);
    expect(staleEdit.subscriptionId).toBe(created.id);
    expect(yield* service.list()).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("skips a stored row that no longer decodes", () =>
  Effect.gen(function* () {
    const service = yield* SubscriptionService.SubscriptionService;
    const sql = yield* SqlClient.SqlClient;
    const kept = yield* service.upsert(antigravity);
    yield* sql`
      INSERT INTO subscriptions (id, subscription_json, created_at, updated_at)
      VALUES (${SubscriptionId.make("broken")}, '{"name":1}', '2000-01-01', '2000-01-01')
    `;
    expect(yield* service.list()).toEqual([kept]);
  }).pipe(Effect.provide(layer)),
);
