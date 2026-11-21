import { SubscriptionId, type SubscriptionUpsertInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

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

it.effect("does not recreate a subscription deleted just before an edit writes", () =>
  Effect.gen(function* () {
    const service = yield* SubscriptionService.SubscriptionService;
    const { id } = yield* service.upsert(antigravity);
    const result = yield* service.upsert({ ...antigravity, id, amount: 6 }).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        const [query] = statement.compile();
        return /^(INSERT INTO|UPDATE) subscriptions\b/i.test(query.trim())
          ? service.delete({ id }).pipe(Effect.orDie, Effect.as(statement))
          : Effect.succeed(statement);
      }),
      Effect.result,
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { subscriptionId: id } });
    expect(yield* service.list()).toEqual([]);
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
    const invalidDates = [
      { anchorDate: "2026-02-29" },
      { status: { _tag: "Cancelled", activeUntil: "2026-13-02" } },
    ];
    for (const [index, fields] of invalidDates.entries()) {
      const id = SubscriptionId.make(`invalid-date-${index}`);
      yield* sql`
        INSERT INTO subscriptions (id, subscription_json, created_at, updated_at)
        VALUES (${id}, ${JSON.stringify({ ...kept, id, ...fields })}, '2000-01-01', '2000-01-01')
      `;
    }
    expect(yield* service.list()).toEqual([kept]);
  }).pipe(Effect.provide(layer)),
);
