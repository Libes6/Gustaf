import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const SubscriptionId = TrimmedNonEmptyString.pipe(Schema.brand("SubscriptionId"));
export type SubscriptionId = typeof SubscriptionId.Type;

/** A calendar day, `YYYY-MM-DD`, with no time zone. */
export const IsoCalendarDate = TrimmedString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(
    (value) =>
      Option.exists(
        DateTime.make(`${value}T00:00:00Z`),
        (date) => DateTime.formatIsoDateUtc(date) === value,
      ) || "Expected a valid calendar date.",
  ),
);
export type IsoCalendarDate = typeof IsoCalendarDate.Type;

export const SubscriptionPeriodUnit = Schema.Literals(["day", "week", "month", "year"]);
export type SubscriptionPeriodUnit = typeof SubscriptionPeriodUnit.Type;

export const SubscriptionPeriod = Schema.Struct({
  unit: SubscriptionPeriodUnit,
  count: PositiveInt,
});
export type SubscriptionPeriod = typeof SubscriptionPeriod.Type;

export const SubscriptionStatus = Schema.Union([
  Schema.TaggedStruct("Active", {}),
  /** No further charges; access lasts until `activeUntil`. */
  Schema.TaggedStruct("Cancelled", { activeUntil: Schema.NullOr(IsoCalendarDate) }),
]);
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

/** A free-text label such as "Visa ··1234"; never a card number. */
export const SubscriptionPaymentMethodLabel = TrimmedString.check(Schema.isMaxLength(60));

export const SubscriptionFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  amount: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  /** ISO 4217 code such as USD or RUB. */
  currency: TrimmedString.check(Schema.isPattern(/^[A-Z]{3}$/)),
  /** Null is a one-time charge on `anchorDate`. */
  period: Schema.NullOr(SubscriptionPeriod),
  /** A known charge or start date; later charges repeat from it. */
  anchorDate: IsoCalendarDate,
  status: SubscriptionStatus,
  reminderDaysBefore: Schema.NullOr(NonNegativeInt),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  note: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(2_000))),
  paymentMethodLabel: Schema.optionalKey(SubscriptionPaymentMethodLabel),
};

export const Subscription = Schema.Struct({
  id: SubscriptionId,
  ...SubscriptionFields,
});
export type Subscription = typeof Subscription.Type;

export const SubscriptionListInput = Schema.Struct({});
export type SubscriptionListInput = typeof SubscriptionListInput.Type;

export const SubscriptionListResult = Schema.Struct({
  subscriptions: Schema.Array(Subscription),
});
export type SubscriptionListResult = typeof SubscriptionListResult.Type;

export const SubscriptionUpsertInput = Schema.Struct({
  /** Omitted: create a new subscription. */
  id: Schema.optionalKey(SubscriptionId),
  ...SubscriptionFields,
});
export type SubscriptionUpsertInput = typeof SubscriptionUpsertInput.Type;

export const SubscriptionDeleteInput = Schema.Struct({ id: SubscriptionId });
export type SubscriptionDeleteInput = typeof SubscriptionDeleteInput.Type;

export class SubscriptionError extends Schema.TaggedError<SubscriptionError>()(
  "SubscriptionError",
  {
    message: Schema.String,
    subscriptionId: Schema.optional(SubscriptionId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
