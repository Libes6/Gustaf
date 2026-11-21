import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import {
  Subscription,
  SubscriptionError,
  SubscriptionId,
  type SubscriptionDeleteInput,
  type SubscriptionUpsertInput,
} from "@t3tools/contracts";

export class SubscriptionService extends Context.Service<
  SubscriptionService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Subscription>, SubscriptionError>;
    readonly upsert: (
      input: SubscriptionUpsertInput,
    ) => Effect.Effect<Subscription, SubscriptionError>;
    readonly delete: (input: SubscriptionDeleteInput) => Effect.Effect<void, SubscriptionError>;
  }
>()("t3/subscriptions/SubscriptionService") {}

const SubscriptionJson = Schema.fromJsonString(Subscription);
const decodeSubscription = Schema.decodeUnknownEffect(SubscriptionJson);
const encodeSubscription = Schema.encodeEffect(SubscriptionJson);

const failWith =
  (message: string, subscriptionId?: SubscriptionId) =>
  (cause: unknown): SubscriptionError =>
    new SubscriptionError({
      message,
      cause,
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;

  const list = Effect.fn("SubscriptionService.list")(function* () {
    const rows = yield* sql<{ readonly subscription_json: string }>`
      SELECT subscription_json FROM subscriptions ORDER BY created_at, rowid
    `.pipe(Effect.mapError(failWith("Could not read subscriptions.")));
    // A row that no longer decodes is skipped rather than hiding every other subscription.
    const decoded = yield* Effect.forEach(rows, (row) =>
      decodeSubscription(row.subscription_json).pipe(
        Effect.map((subscription) => [subscription]),
        Effect.catch((cause) =>
          Effect.logWarning("Skipping an unreadable subscription row.", cause).pipe(Effect.as([])),
        ),
      ),
    );
    return decoded.flat();
  });

  const upsert = Effect.fn("SubscriptionService.upsert")(function* (
    input: SubscriptionUpsertInput,
  ) {
    const id =
      input.id ??
      SubscriptionId.make(
        yield* random.uuidV4().pipe(Effect.mapError(failWith("Could not create an id."))),
      );
    const subscription = Subscription.make({ ...input, id });
    const json = yield* encodeSubscription(subscription).pipe(
      Effect.mapError(failWith("Could not save the subscription.", id)),
    );
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    if (input.id === undefined) {
      yield* sql`
        INSERT INTO subscriptions (id, subscription_json, created_at, updated_at)
        VALUES (${id}, ${json}, ${now}, ${now})
      `.pipe(Effect.mapError(failWith("Could not save the subscription.", id)));
    } else {
      const updated = yield* sql`
        UPDATE subscriptions SET subscription_json = ${json}, updated_at = ${now}
        WHERE id = ${id}
        RETURNING id
      `.pipe(Effect.mapError(failWith("Could not save the subscription.", id)));
      if (updated.length === 0) {
        return yield* new SubscriptionError({
          message: `No subscription has id ${id}.`,
          subscriptionId: id,
        });
      }
    }
    return subscription;
  });

  const remove = Effect.fn("SubscriptionService.delete")(function* (
    input: SubscriptionDeleteInput,
  ) {
    yield* sql`DELETE FROM subscriptions WHERE id = ${input.id}`.pipe(
      Effect.mapError(failWith("Could not delete the subscription.", input.id)),
    );
  });

  return SubscriptionService.of({ list, upsert, delete: remove });
});

export const layer = Layer.effect(SubscriptionService, make);
