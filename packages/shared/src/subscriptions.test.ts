import { describe, expect, it } from "vite-plus/test";

import {
  isChargeReminderDue,
  monthlyCost,
  nextChargeDate,
  subscriptionTotalsByCurrency,
  yearlyCost,
} from "./subscriptions.ts";

const active = { _tag: "Active" } as const;
const every = (count: number, unit: "day" | "week" | "month" | "year") => ({ unit, count });

describe("nextChargeDate", () => {
  it.each([
    [
      "clamps a month-end anchor into February",
      "2026-01-31",
      every(1, "month"),
      "2026-02-01",
      "2026-02-28",
    ],
    [
      "returns to the anchor's day after a short month",
      "2026-01-31",
      every(1, "month"),
      "2026-03-01",
      "2026-03-31",
    ],
    [
      "clamps into a leap-year February",
      "2028-01-30",
      every(1, "month"),
      "2028-02-15",
      "2028-02-29",
    ],
    ["counts a charge due today", "2026-01-15", every(1, "month"), "2026-04-15", "2026-04-15"],
    [
      "steps multi-month periods from the anchor",
      "2026-01-10",
      every(3, "month"),
      "2026-05-01",
      "2026-07-10",
    ],
    ["steps yearly periods", "2024-02-29", every(1, "year"), "2025-03-01", "2026-02-28"],
    ["steps multi-week periods", "2026-01-01", every(2, "week"), "2026-01-16", "2026-01-29"],
    ["steps daily periods", "2026-01-01", every(10, "day"), "2026-01-11", "2026-01-11"],
    [
      "keeps a future anchor as the first charge",
      "2026-12-01",
      every(1, "month"),
      "2026-11-16",
      "2026-12-01",
    ],
  ] as const)("%s", (_name, anchorDate, period, today, expected) => {
    expect(nextChargeDate({ anchorDate, period, status: active }, today)).toBe(expected);
  });

  it("has no next charge for a cancelled subscription", () => {
    expect(
      nextChargeDate(
        {
          anchorDate: "2026-01-01",
          period: every(1, "month"),
          status: { _tag: "Cancelled", activeUntil: "2026-12-01" },
        },
        "2026-11-16",
      ),
    ).toBeNull();
  });

  it("charges a one-time subscription only on its anchor", () => {
    const oneTime = { anchorDate: "2026-11-20", period: null, status: active };
    expect(nextChargeDate(oneTime, "2026-11-16")).toBe("2026-11-20");
    expect(nextChargeDate(oneTime, "2026-11-21")).toBeNull();
  });
});

it("reminds only inside the reminder window", () => {
  const subscription = {
    anchorDate: "2026-01-20",
    period: every(1, "month"),
    status: active,
    reminderDaysBefore: 3,
  };
  expect(isChargeReminderDue(subscription, "2026-11-16")).toBe(false);
  expect(isChargeReminderDue(subscription, "2026-11-17")).toBe(true);
  expect(isChargeReminderDue({ ...subscription, reminderDaysBefore: null }, "2026-11-20")).toBe(
    false,
  );
});

describe("normalized cost", () => {
  it("spreads a multi-month charge across its months", () => {
    const antigravity = { amount: 5, period: every(3, "month"), status: active };
    expect(monthlyCost(antigravity)).toBeCloseTo(5 / 3);
    expect(yearlyCost(antigravity)).toBe(20);
  });

  it("totals per currency without mixing currencies or counting inactive charges", () => {
    expect(
      subscriptionTotalsByCurrency([
        { amount: 20, currency: "USD", period: every(1, "month"), status: active },
        { amount: 120, currency: "USD", period: every(1, "year"), status: active },
        { amount: 299, currency: "RUB", period: every(1, "month"), status: active },
        { amount: 50, currency: "USD", period: null, status: active },
        {
          amount: 10,
          currency: "USD",
          period: every(1, "month"),
          status: { _tag: "Cancelled", activeUntil: null },
        },
      ]),
    ).toEqual([
      { currency: "RUB", monthly: 299, yearly: 3588 },
      { currency: "USD", monthly: 30, yearly: 360 },
    ]);
  });
});
