import {
  ProviderInstanceId,
  type Subscription,
  type SubscriptionPeriodUnit,
  SubscriptionUpsertInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface SubscriptionDraft {
  readonly name: string;
  readonly amount: string;
  readonly currency: string;
  readonly recurring: boolean;
  readonly periodCount: string;
  readonly periodUnit: SubscriptionPeriodUnit;
  readonly anchorDate: string;
  readonly cancelled: boolean;
  readonly activeUntil: string;
  readonly reminderDaysBefore: string;
  readonly providerInstanceId: string;
  readonly paymentMethodLabel: string;
  readonly note: string;
}

export type SubscriptionDraftField =
  | "name"
  | "amount"
  | "currency"
  | "periodCount"
  | "anchorDate"
  | "reminderDaysBefore";

export function emptySubscriptionDraft(today: string): SubscriptionDraft {
  return {
    name: "",
    amount: "",
    currency: "USD",
    recurring: true,
    periodCount: "1",
    periodUnit: "month",
    anchorDate: today,
    cancelled: false,
    activeUntil: "",
    reminderDaysBefore: "",
    providerInstanceId: "",
    paymentMethodLabel: "",
    note: "",
  };
}

export function subscriptionDraft(subscription: Subscription): SubscriptionDraft {
  return {
    name: subscription.name,
    amount: String(subscription.amount),
    currency: subscription.currency,
    recurring: subscription.period !== null,
    periodCount: String(subscription.period?.count ?? 1),
    periodUnit: subscription.period?.unit ?? "month",
    anchorDate: subscription.anchorDate,
    cancelled: subscription.status._tag === "Cancelled",
    activeUntil:
      subscription.status._tag === "Cancelled" ? (subscription.status.activeUntil ?? "") : "",
    reminderDaysBefore:
      subscription.reminderDaysBefore === null ? "" : String(subscription.reminderDaysBefore),
    providerInstanceId: subscription.providerInstanceId ?? "",
    paymentMethodLabel: subscription.paymentMethodLabel ?? "",
    note: subscription.note ?? "",
  };
}

const decodeInput = Schema.decodeUnknownResult(SubscriptionUpsertInput);
const isWhole = (value: string, minimum: number) =>
  /^\d+$/.test(value.trim()) && Number(value) >= minimum;

/** Field errors, or the input the server accepts; the schema is the one agents' MCP calls decode with. */
export function parseSubscriptionDraft(
  draft: SubscriptionDraft,
  id: Subscription["id"] | undefined,
):
  | { readonly ok: true; readonly input: SubscriptionUpsertInput }
  | { readonly ok: false; readonly errors: ReadonlySet<SubscriptionDraftField> } {
  const errors = new Set<SubscriptionDraftField>();
  const amount = Number(draft.amount.replace(",", "."));
  const currency = draft.currency.trim().toUpperCase();
  if (draft.name.trim() === "") errors.add("name");
  if (draft.amount.trim() === "" || !Number.isFinite(amount) || amount < 0) errors.add("amount");
  if (!/^[A-Z]{3}$/.test(currency)) errors.add("currency");
  if (draft.recurring && !isWhole(draft.periodCount, 1)) errors.add("periodCount");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.anchorDate)) errors.add("anchorDate");
  const reminder = draft.reminderDaysBefore.trim();
  if (reminder !== "" && !isWhole(reminder, 0)) errors.add("reminderDaysBefore");
  if (errors.size > 0) return { ok: false, errors };

  const result = decodeInput({
    ...(id === undefined ? {} : { id }),
    name: draft.name,
    amount,
    currency,
    period: draft.recurring ? { unit: draft.periodUnit, count: Number(draft.periodCount) } : null,
    anchorDate: draft.anchorDate,
    status: draft.cancelled
      ? { _tag: "Cancelled", activeUntil: draft.activeUntil === "" ? null : draft.activeUntil }
      : { _tag: "Active" },
    reminderDaysBefore: reminder === "" ? null : Number(reminder),
    ...(draft.providerInstanceId === ""
      ? {}
      : { providerInstanceId: ProviderInstanceId.make(draft.providerInstanceId) }),
    ...(draft.paymentMethodLabel.trim() === ""
      ? {}
      : { paymentMethodLabel: draft.paymentMethodLabel }),
    ...(draft.note.trim() === "" ? {} : { note: draft.note }),
  });
  // The checks above cover every field the schema can reject except lengths, which inputs cap.
  return result._tag === "Success"
    ? { ok: true, input: result.success }
    : { ok: false, errors: new Set(["name"]) };
}
