import { describe, expect, it } from "vite-plus/test";

import { ApiError } from "../api/client";
import type { Me } from "../api/types";
import { availableUserActions, normalizeBanReason, otherRole, resolveGate } from "./rules";

const admin: Me = { id: "a1", name: "Ada", email: "ada@example.test", image: null, role: "admin" };
const user: Me = { ...admin, id: "u1", role: "user" };

describe("resolveGate", () => {
  it("maps the /v1/me query to a screen", () => {
    expect(resolveGate({ status: "pending", data: undefined, error: null })).toEqual({
      state: "loading",
    });
    expect(
      resolveGate({ status: "error", data: undefined, error: new ApiError(401, "no") }),
    ).toEqual({ state: "signed-out" });
    expect(
      resolveGate({ status: "error", data: undefined, error: new ApiError(403, "no") }),
    ).toEqual({ state: "no-access", me: null });
    expect(resolveGate({ status: "success", data: user, error: null })).toEqual({
      state: "no-access",
      me: user,
    });
    expect(resolveGate({ status: "success", data: admin, error: null })).toEqual({
      state: "admin",
      me: admin,
    });
  });

  it("signs out when a refetch fails with 401 even though stale data remains", () => {
    expect(
      resolveGate({ status: "error", data: admin, error: new ApiError(401, "expired") }).state,
    ).toBe("signed-out");
  });

  it("shows an error, not the sign-in screen, when the API is unreachable", () => {
    expect(
      resolveGate({ status: "error", data: undefined, error: new ApiError(0, "offline") }).state,
    ).toBe("error");
  });
});

describe("availableUserActions", () => {
  it("disables every action on the admin's own row", () => {
    const actions = availableUserActions("a1", { id: "a1", banned: false });
    expect(actions.every((entry) => !entry.enabled)).toBe(true);
  });

  it("offers ban or unban by the user's state", () => {
    expect(availableUserActions("a1", { id: "u1", banned: false })).toEqual([
      { action: "ban", enabled: true },
      { action: "revoke-sessions", enabled: true },
      { action: "change-role", enabled: true },
      { action: "delete", enabled: true },
    ]);
    expect(availableUserActions("a1", { id: "u1", banned: true })[0]).toEqual({
      action: "unban",
      enabled: true,
    });
  });
});

describe("role and ban rules", () => {
  it("toggles the role", () => {
    expect(otherRole("user")).toBe("admin");
    expect(otherRole("admin")).toBe("user");
  });

  it("requires a trimmed reason of 3 to 500 characters", () => {
    expect(normalizeBanReason("  spam  ")).toBe("spam");
    expect(normalizeBanReason(" ab ")).toBeNull();
    expect(normalizeBanReason("x".repeat(501))).toBeNull();
  });
});
