import { describe, expect, it } from "vite-plus/test";

import type { AccountDevice } from "./accountApi";
import {
  accountDeviceRows,
  accountErrorMessage,
  accountRowValue,
  canRegisterPhone,
} from "./accountScreenState";
import type { AccountState } from "./accountStore";

const device = (id: string, kind: AccountDevice["kind"], lastSeenAt: string | null = null) => ({
  id,
  name: id,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt,
});

const state = (patch: Partial<AccountState>): AccountState => ({
  status: "signedIn",
  user: { id: "u1", name: "Ada", email: "ada@example.com", image: null },
  devices: [],
  phoneDeviceId: null,
  busy: null,
  revokingDeviceId: null,
  error: null,
  ...patch,
});

describe("account screen state", () => {
  it("lists this phone first and labels each device by kind and last activity", () => {
    const rows = accountDeviceRows(
      [
        device("mac", "computer", "2026-05-01T10:00:00.000Z"),
        device("old-phone", "phone"),
        device("me", "phone"),
      ],
      "me",
    );

    expect(rows.map((row) => [row.id, row.icon, row.isThisPhone])).toEqual([
      ["me", "iphone", true],
      ["mac", "desktopcomputer", false],
      ["old-phone", "iphone", false],
    ]);
    expect(rows[0]!.detail).toBe("This phone · Never seen");
    expect(rows[1]!.detail).toMatch(/^Computer · Last seen .+/);
    expect(rows[2]!.detail).toBe("Phone · Never seen");
  });

  it.each([
    [state({}), true],
    [state({ phoneDeviceId: "p1" }), false],
    [state({ devices: null }), false],
    [state({ status: "signedOut" }), false],
  ])(
    "offers to register this phone only once devices are known and it is not registered",
    (s, expected) => {
      expect(canRegisterPhone(s)).toBe(expected);
    },
  );

  it.each([
    [state({ status: "loading" }), "Checking"],
    [state({ status: "signedOut", user: null }), "Sign in"],
    [state({}), "ada@example.com"],
  ])("summarizes the account on the Settings row", (s, expected) => {
    expect(accountRowValue(s)).toBe(expected);
  });

  it.each([
    [null, null],
    ["state_mismatch", "Sign-in could not be verified. Try again."],
    ["session_expired", "Your session has ended. Sign in again."],
    ["boom", "Request failed: boom"],
  ])("explains error %s", (error, expected) => {
    expect(accountErrorMessage(error)).toBe(expected);
  });
});
