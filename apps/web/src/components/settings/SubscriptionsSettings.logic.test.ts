import { type Subscription, SubscriptionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emptySubscriptionDraft,
  parseSubscriptionDraft,
  subscriptionDraft,
} from "./SubscriptionsSettings.logic";

const saved: Subscription = {
  id: SubscriptionId.make("sub-1"),
  name: "Telegram Premium",
  amount: 299,
  currency: "RUB",
  period: { unit: "month", count: 1 },
  anchorDate: "2026-10-05",
  status: { _tag: "Cancelled", activeUntil: "2026-12-05" },
  reminderDaysBefore: 2,
  paymentMethodLabel: "Mir ··4411",
};

describe("parseSubscriptionDraft", () => {
  it("round-trips a saved subscription through the edit form", () => {
    expect(parseSubscriptionDraft(subscriptionDraft(saved), saved.id)).toEqual({
      ok: true,
      input: saved,
    });
  });

  it("normalizes a one-time charge typed with a comma and lowercase currency", () => {
    const result = parseSubscriptionDraft(
      {
        ...emptySubscriptionDraft("2026-11-16"),
        name: "Course",
        amount: "12,5",
        currency: "eur",
        recurring: false,
      },
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      input: { amount: 12.5, currency: "EUR", period: null, status: { _tag: "Active" } },
    });
  });

  it("names every invalid field instead of saving", () => {
    const result = parseSubscriptionDraft(
      {
        ...emptySubscriptionDraft(""),
        amount: "-1",
        currency: "dollars",
        periodCount: "0",
        reminderDaysBefore: "1.5",
      },
      undefined,
    );
    expect(result.ok ? [] : [...result.errors].toSorted()).toEqual([
      "amount",
      "anchorDate",
      "currency",
      "name",
      "periodCount",
      "reminderDaysBefore",
    ]);
  });
});
