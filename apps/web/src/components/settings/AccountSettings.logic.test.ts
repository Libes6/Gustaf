import { describe, expect, it } from "vite-plus/test";

import type { ShellAccountDevice, ShellAccountState } from "../../shellAccount";
import { accountView, isThisComputerRegistered, orderDevices } from "./AccountSettings.logic";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");

const signedIn = (
  overrides: Partial<ShellAccountState["user"] & object> = {},
  expiresAt?: string,
) =>
  ({
    signedIn: true,
    user: { id: "u1", name: "Max Kulakov", email: "max@example.com", image: null, ...overrides },
    expiresAt: expiresAt ?? "2026-12-01T00:00:00.000Z",
    deviceId: null,
  }) satisfies ShellAccountState;

describe("accountView", () => {
  it("reads loading, signed out and expired sessions", () => {
    expect(accountView(null, NOW)).toEqual({ kind: "loading" });
    expect(
      accountView({ signedIn: false, user: null, expiresAt: null, deviceId: null }, NOW),
    ).toEqual({ kind: "signedOut", expired: false });
    expect(accountView(signedIn({}, "2026-11-12T11:59:59.000Z"), NOW)).toEqual({
      kind: "signedOut",
      expired: true,
    });
  });

  it("names the account by name, else email", () => {
    expect(accountView(signedIn(), NOW)).toMatchObject({
      kind: "signedIn",
      displayName: "Max Kulakov",
      secondary: "max@example.com",
      initials: "MK",
    });
    expect(accountView(signedIn({ name: "  " }), NOW)).toMatchObject({
      displayName: "max@example.com",
      secondary: null,
      initials: "ME",
    });
    expect(accountView(signedIn({ name: null, email: null }), NOW)).toMatchObject({
      displayName: null,
      initials: "?",
    });
  });
});

describe("devices", () => {
  const device = (id: string, current: boolean): ShellAccountDevice => ({
    id,
    name: id,
    kind: "computer",
    createdAt: "2026-11-01T00:00:00.000Z",
    lastSeenAt: null,
    current,
  });

  it("puts this computer first and knows whether it is registered", () => {
    const devices = [device("a", false), device("b", true), device("c", false)];
    expect(orderDevices(devices).map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(isThisComputerRegistered(devices)).toBe(true);
    expect(isThisComputerRegistered([device("a", false)])).toBe(false);
  });
});
