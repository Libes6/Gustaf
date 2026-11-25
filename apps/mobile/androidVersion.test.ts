import { expect, it } from "vite-plus/test";

import { androidReleaseVersion } from "./androidVersion.ts";

it.each([
  ["v0.10.0", "0.10.0", 1000],
  ["v0.9.12", "0.9.12", 912],
  ["1.2.3", "1.2.3", 10203],
  ["v12.0.99", "12.0.99", 120099],
])("derives the Android version from %s", (tag, versionName, versionCode) => {
  expect(androidReleaseVersion(tag)).toEqual({ versionName, versionCode });
});

it("orders release codes like the versions they come from", () => {
  const codes = ["v0.9.99", "v0.10.0", "v0.10.1", "v1.0.0"].map(
    (tag) => androidReleaseVersion(tag).versionCode,
  );
  expect(codes).toEqual([...codes].sort((a, b) => a - b));
});

it.each(["v1.2", "v1.2.3-beta.1", "release-1", "v1.100.0", "v1.0.100", "v210001.0.0"])(
  "rejects %s",
  (tag) => {
    expect(() => androidReleaseVersion(tag)).toThrow();
  },
);
