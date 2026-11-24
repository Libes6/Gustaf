import { OrchestratorMcpFailure, type SubscriptionError } from "@t3tools/contracts";
import {
  localCalendarDate,
  nextChargeDate,
  subscriptionTotalsByCurrency,
} from "@t3tools/shared/subscriptions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as SubscriptionService from "../../../subscriptions/SubscriptionService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { SubscriptionsToolkit } from "./tools.ts";

const today = Clock.currentTimeMillis.pipe(Effect.map((millis) => localCalendarDate(millis)));

// The service names the subscription only when the request itself was wrong, such as an unknown id.
const toFailure = (error: SubscriptionError) =>
  error.subscriptionId !== undefined && error.cause === undefined
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

// Writes take the same bar as Settings' environment writes over MCP (t3_environment_preferences_update).
export const layer = McpToolAccess.toLayer(SubscriptionsToolkit, {
  t3_subscriptions_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const subscriptions = yield* SubscriptionService.SubscriptionService;
      const list = yield* subscriptions.list().pipe(Effect.mapError(toFailure));
      const date = yield* today;
      return {
        today: date,
        subscriptions: list.map((subscription) => ({
          ...subscription,
          nextChargeDate: nextChargeDate(subscription, date),
        })),
        totals: subscriptionTotalsByCurrency(list),
      };
    }),
  ),
  t3_subscriptions_upsert: McpToolAccess.writesEnvironment(({ environmentId: _, ...input }) =>
    Effect.gen(function* () {
      const subscriptions = yield* SubscriptionService.SubscriptionService;
      const saved = yield* subscriptions.upsert(input).pipe(Effect.mapError(toFailure));
      return { ...saved, nextChargeDate: nextChargeDate(saved, yield* today) };
    }),
  ),
  t3_subscriptions_delete: McpToolAccess.writesEnvironment(({ id }) =>
    Effect.gen(function* () {
      const subscriptions = yield* SubscriptionService.SubscriptionService;
      yield* subscriptions.delete({ id }).pipe(Effect.mapError(toFailure));
      return { deleted: id };
    }),
  ),
});
