import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  Subscription,
  SubscriptionFields,
  SubscriptionId,
  SubscriptionPaymentMethodLabel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SubscriptionService from "../../../subscriptions/SubscriptionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SubscriptionWithNextCharge = Schema.Struct({
  ...Subscription.fields,
  nextChargeDate: Schema.NullOr(Schema.String),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SubscriptionService.SubscriptionService,
  ],
};

const SubscriptionsListTool = Tool.make("t3_subscriptions_list", {
  ...shared,
  description:
    "List the user's paid subscriptions with each next charge date (null: none coming), and recurring totals per currency.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    today: Schema.String,
    subscriptions: Schema.Array(SubscriptionWithNextCharge),
    totals: Schema.Array(
      Schema.Struct({ currency: Schema.String, monthly: Schema.Number, yearly: Schema.Number }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SubscriptionsUpsertTool = Tool.make("t3_subscriptions_upsert", {
  ...shared,
  description:
    "Add a subscription, or replace one by id. An edit replaces every field: read it with t3_subscriptions_list and resend the fields to keep. E.g. 5 USD every 3 months, paid Nov 10: amount 5, currency USD, period {unit:month,count:3}, anchorDate YYYY-11-10.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    id: Schema.optionalKey(SubscriptionId.annotate({ description: "Omit to add." })),
    name: SubscriptionFields.name,
    amount: SubscriptionFields.amount.annotate({ description: "Price of one charge." }),
    currency: SubscriptionFields.currency.annotate({
      description: "Uppercase ISO 4217 code, e.g. USD, EUR, RUB.",
    }),
    period: SubscriptionFields.period.annotate({
      description: "Time between charges. null: a single charge on anchorDate.",
    }),
    anchorDate: SubscriptionFields.anchorDate.annotate({
      description:
        "YYYY-MM-DD of any past or upcoming charge; later ones repeat from it. A day without a year is its latest one on or before today.",
    }),
    status: SubscriptionFields.status.annotate({
      description:
        'Usually {"_tag":"Active"}. Cancelled: {"_tag":"Cancelled","activeUntil":YYYY-MM-DD or null}; it has no further charges.',
    }),
    reminderDaysBefore: SubscriptionFields.reminderDaysBefore.annotate({
      description: "Days before a charge to flag it as due soon. null: never.",
    }),
    providerInstanceId: SubscriptionFields.providerInstanceId,
    note: SubscriptionFields.note,
    paymentMethodLabel: Schema.optionalKey(
      SubscriptionPaymentMethodLabel.annotate({
        description: "A label such as 'Visa ··1234'. Never a card number.",
      }),
    ),
  }),
  success: SubscriptionWithNextCharge,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const SubscriptionsDeleteTool = Tool.make("t3_subscriptions_delete", {
  ...shared,
  description:
    "Delete a subscription by id. To stop one but keep it listed, upsert it as Cancelled.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    id: SubscriptionId,
  }),
  success: Schema.Struct({ deleted: SubscriptionId }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

export const SubscriptionsToolkit = Toolkit.make(
  SubscriptionsListTool,
  SubscriptionsUpsertTool,
  SubscriptionsDeleteTool,
);
