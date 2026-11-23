import { describe, expect, it } from "vite-plus/test";

import { fromDateTimeLocal, parseLogins, toDateTimeLocal } from "./client-config";

describe("client config form helpers", () => {
  it("round-trips a schedule through the local datetime input", () => {
    const iso = fromDateTimeLocal("2026-11-13T09:30");
    expect(iso).toBe(new Date(2026, 10, 13, 9, 30).toISOString());
    expect(toDateTimeLocal(iso)).toBe("2026-11-13T09:30");
    expect(fromDateTimeLocal("")).toBeNull();
    expect(toDateTimeLocal(null)).toBe("");
  });

  it("reads GitHub logins from commas or lines", () => {
    expect(parseLogins(" @Ivan, olga\nivan\n\n")).toEqual(["ivan", "olga"]);
  });
});
