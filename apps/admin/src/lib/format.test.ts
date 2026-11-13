import { describe, expect, it } from "vite-plus/test";

import { ApiError } from "../api/client";
import { strings } from "../strings";
import {
  auditActionLabel,
  errorMessage,
  formatBytes,
  formatDay,
  formatDuration,
  formatMeta,
  formatRelative,
  hasMeta,
  shortCommit,
} from "./format";
import { back, currentCursor, FIRST_PAGE, forward } from "./pagination";

describe("formatting", () => {
  it("formats relative times against an explicit now", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(formatRelative("2026-11-13T11:59:40Z", now)).toBe("this minute");
    expect(formatRelative("2026-11-13T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-11-11T12:00:00Z", now)).toBe("2 days ago");
    expect(formatRelative(null, now)).toBe(strings.common.never);
  });

  it("reads API days as UTC calendar days", () => {
    expect(formatDay("2026-11-01")).toBe("1 Nov");
    expect(formatDay("garbage")).toBe("garbage");
  });

  it("formats byte counts in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100.0 GB");
  });

  it("formats uptime with the two largest units", () => {
    expect(formatDuration(30)).toBe("0m");
    expect(formatDuration(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(formatDuration(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
  });

  it("shortens full commit hashes only", () => {
    expect(shortCommit("0123456789abcdef0123")).toBe("0123456");
    expect(shortCommit("dev")).toBe("dev");
  });

  it("labels known audit actions and passes unknown ones through", () => {
    expect(auditActionLabel("user.role_change")).toBe("Changed role");
    expect(auditActionLabel("user.rename")).toBe("user.rename");
  });

  it("shows the API message for a 400 and generic text otherwise", () => {
    expect(errorMessage(new ApiError(400, "Reason is required"))).toBe("Reason is required");
    expect(errorMessage(new ApiError(429, "slow down"))).toBe(strings.errors.rateLimited);
    expect(errorMessage(new Error("boom"))).toBe(strings.errors.title);
  });

  it("collapses empty audit meta", () => {
    expect(hasMeta(null)).toBe(false);
    expect(hasMeta({})).toBe(false);
    expect(hasMeta({ reason: "spam" })).toBe(true);
    expect(formatMeta({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("cursor trail", () => {
  it("walks forward and back through cursor pages", () => {
    const second = forward(FIRST_PAGE, "c2");
    const third = forward(second, "c3");
    expect(currentCursor(FIRST_PAGE)).toBeNull();
    expect(currentCursor(third)).toBe("c3");
    expect(currentCursor(back(third))).toBe("c2");
    expect(back(FIRST_PAGE)).toBe(FIRST_PAGE);
    expect(forward(third, null)).toBe(third);
  });
});
