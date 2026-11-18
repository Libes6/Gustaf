import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { missingReleaseAssets } from "../scripts/check-release-assets.mjs";

const v = "1.2.3";
const full = {
  "darwin-aarch64": [
    `Gustaf-${v}-macOS-arm64.dmg`,
    `Gustaf-${v}-macOS-arm64.app.tar.gz`,
    `Gustaf-${v}-macOS-arm64.app.tar.gz.sig`,
  ],
  "windows-x86_64": [
    `Gustaf-${v}-Windows-x64-setup.exe`,
    `Gustaf-${v}-Windows-x64-setup.exe.sig`,
    `Gustaf-${v}-Windows-x64.msi`,
  ],
  "linux-x86_64": [`Gustaf-${v}-Linux-x64.AppImage`, `Gustaf-${v}-Linux-x64.AppImage.sig`],
  root: ["latest.json", `gustaf-browser-${v}-darwin-arm64.tar.xz`],
};

NodeTest.test(
  "a complete release has nothing missing, with or without optional package types",
  () => {
    NodeAssert.deepEqual(missingReleaseAssets(v, full), []);
    const lean = {
      ...full,
      "linux-x86_64": full["linux-x86_64"].filter((n) => !n.endsWith(".deb")),
    };
    NodeAssert.deepEqual(missingReleaseAssets(v, lean), []);
  },
);

NodeTest.test("names each missing artifact per platform", () => {
  const broken = {
    ...full,
    "darwin-aarch64": [`Gustaf-${v}-macOS-arm64.dmg`],
    "windows-x86_64": [],
    root: [],
  };
  NodeAssert.deepEqual(missingReleaseAssets(v, broken), [
    "darwin-aarch64: *.app.tar.gz",
    "darwin-aarch64: *.app.tar.gz.sig",
    "windows-x86_64: *-setup.exe",
    "windows-x86_64: *-setup.exe.sig",
    "latest.json",
    `gustaf-browser-${v}-darwin-arm64.tar.xz`,
  ]);
  NodeAssert.deepEqual(
    missingReleaseAssets(v, { ...broken, root: [] }, { manifest: false }).includes("latest.json"),
    false,
  );
});

NodeTest.test("assets of another version do not count", () => {
  NodeAssert.equal(missingReleaseAssets("9.9.9", full).length, 8);
});
