import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

// Loading the native module crashes Android builds without an EAS project ID.
vi.mock("expo-observe", () => {
  throw new Error("Project ID is required to send observability metrics");
});

it("starts without loading Expo telemetry or requiring an EAS project", async () => {
  const observe = await import("./observe");
  expect(observe.crashReportingAvailable).toBe(false);
  await expect(observe.setCrashReportsEnabled(true)).resolves.toBeUndefined();
  await expect(observe.setCrashReportsEnabled(false)).resolves.toBeUndefined();
});
