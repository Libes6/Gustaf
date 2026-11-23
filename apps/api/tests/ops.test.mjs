import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { parseCoolifyBackups } from "../dist/admin/coolify.js";
import { classifyAsset, summarizeReleases } from "../dist/admin/releases.js";
import { TtlCache } from "../dist/admin/ttl-cache.js";
import { readConfig } from "../dist/config.js";
import { dailySeries, RelayDaily } from "../dist/relay/relay.daily.js";

NodeTest.test("daily relay counts are summed per UTC day and kept when a write fails", async () => {
  let now = new Date("2026-11-12T23:59:30Z");
  const writes = [];
  let failNext = false;
  const daily = new RelayDaily(
    async (rows) => {
      if (failNext) {
        failNext = false;
        throw new Error("database away");
      }
      writes.push(rows.map((row) => ({ ...row })));
    },
    () => now,
  );
  try {
    daily.add("bytes", 100);
    daily.add("bytes", 50);
    daily.add("unauthorized");
    now = new Date("2026-11-13T00:00:10Z");
    daily.add("bytes", 7);
    failNext = true;
    await daily.flush();
    NodeAssert.equal(writes.length, 0);
    daily.add("bytes", 3);
    await daily.flush();
    NodeAssert.deepEqual(writes, [
      [
        { day: "2026-11-12", metric: "bytes", value: 150 },
        { day: "2026-11-12", metric: "unauthorized", value: 1 },
        { day: "2026-11-13", metric: "bytes", value: 10 },
      ],
    ]);
    await daily.flush();
    NodeAssert.equal(writes.length, 1, "nothing pending, nothing written");
  } finally {
    await daily.close();
  }

  const series = dailySeries(
    [
      { day: "2026-11-13", metric: "bytes", value: 10 },
      { day: "2026-10-01", metric: "bytes", value: 99 },
      { day: "2026-11-12", metric: "unknown_metric", value: 5 },
    ],
    ["bytes", "unauthorized"],
    new Date("2026-11-13T12:00:00Z"),
  );
  NodeAssert.equal(series.length, 30);
  NodeAssert.deepEqual(series[0], { date: "2026-10-15", bytes: 0, unauthorized: 0 });
  NodeAssert.deepEqual(series.at(-1), { date: "2026-11-13", bytes: 10, unauthorized: 0 });
});

NodeTest.test("release assets map to a platform and kind", () => {
  const cases = [
    ["Gustaf-0.12.0-macOS-arm64.dmg", "macos", "installer"],
    ["Gustaf-0.12.0-macOS-arm64.app.tar.gz", "macos", "update"],
    ["Gustaf-0.12.0-mac-arm64.zip", "macos", "update"],
    ["Gustaf-0.12.0-Windows-x64-setup.exe", "windows", "installer"],
    ["Gustaf-0.12.0-Windows-x64.msi", "windows", "installer"],
    ["Gustaf-0.12.0-Linux-x64.AppImage", "linux", "installer"],
    ["Gustaf-0.12.0-Linux-x64.deb", "linux", "installer"],
    ["Gustaf-0.12.0-Linux-x64.rpm", "linux", "installer"],
    ["Gustaf-0.12.0-Android.apk", "android", "installer"],
    ["Gustaf-Android-preview-arm64-4238090.apk", "android", "installer"],
    ["Gustaf.ipa", "ios", "installer"],
    ["Gustaf-0.12.0-Windows-x64-setup.exe.sig", "other", "metadata"],
    ["Gustaf-0.12.0-Android.apk.sha256", "other", "metadata"],
    ["latest.json", "other", "metadata"],
    ["latest-android.json", "other", "metadata"],
    ["latest-mac.yml", "other", "metadata"],
    ["SHA256SUMS.txt", "other", "metadata"],
    ["notes.pdf", "other", "installer"],
  ];
  for (const [name, platform, kind] of cases) {
    NodeAssert.deepEqual(classifyAsset(name), { platform, kind }, name);
  }

  const summary = summarizeReleases([
    {
      tag_name: "v0.12.0",
      name: "",
      published_at: "2026-11-01T00:00:00Z",
      prerelease: false,
      assets: [
        { name: "Gustaf-0.12.0-macOS-arm64.dmg", download_count: 4, size: 10 },
        { name: "Gustaf-0.12.0-macOS-arm64.app.tar.gz", download_count: 6, size: 9 },
        { name: "Gustaf-0.12.0-Android.apk", download_count: 2, size: 8 },
        { name: "latest.json", download_count: 50, size: 1 },
      ],
    },
    { tag_name: "v0.11.0", prerelease: true, assets: [{ name: "x.exe", download_count: 3 }] },
    { tag_name: "draft", draft: true, assets: [{ name: "y.exe", download_count: 100 }] },
  ]);
  NodeAssert.deepEqual(
    summary.releases.map((release) => [release.tag, release.name, release.downloads]),
    [
      ["v0.12.0", null, 12],
      ["v0.11.0", null, 3],
    ],
  );
  NodeAssert.equal(summary.total, 15);
  NodeAssert.deepEqual(summary.byPlatform.macos, { installer: 4, update: 6 });
  NodeAssert.deepEqual(summary.byPlatform.windows, { installer: 3, update: 0 });
  NodeAssert.deepEqual(summary.byPlatform.other, { installer: 0, update: 0 });
  NodeAssert.throws(() => summarizeReleases({ message: "API rate limit exceeded" }));
});

NodeTest.test("the last Coolify backup is the newest execution across schedules", () => {
  // Trimmed GET /api/v1/databases/{uuid}/backups answer from Coolify 4.x.
  const fixture = [
    {
      uuid: "bk1",
      enabled: true,
      frequency: "0 3 * * *",
      save_s3: false,
      database_type: "App\\Models\\StandalonePostgresql",
      executions: [
        {
          uuid: "ex1",
          status: "success",
          size: "2048",
          filename: "/data/coolify/backups/pg-1.dmp",
          created_at: "2026-11-12T03:00:00.000000Z",
          finished_at: "2026-11-12T03:00:05.000000Z",
          message: null,
        },
        {
          uuid: "ex2",
          status: "failed",
          size: 0,
          created_at: "2026-11-13T03:00:00.000000Z",
          finished_at: null,
          message: null,
        },
      ],
    },
    {
      uuid: "bk2",
      enabled: false,
      frequency: "weekly",
      latest_log: { status: "success", size: 1, created_at: "2026-11-01T00:00:00Z" },
    },
  ];
  NodeAssert.deepEqual(parseCoolifyBackups(fixture), {
    schedules: 2,
    enabled: 1,
    frequency: "0 3 * * *",
    last: {
      status: "failed",
      startedAt: "2026-11-13T03:00:00.000Z",
      finishedAt: null,
      sizeBytes: null,
    },
  });
  NodeAssert.deepEqual(parseCoolifyBackups([]), {
    schedules: 0,
    enabled: 0,
    frequency: null,
    last: null,
  });
  NodeAssert.throws(() => parseCoolifyBackups({ message: "Unauthenticated." }));
});

NodeTest.test(
  "the cache shares one load, reloads after its TTL and serves stale on failure",
  async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const cache = new TtlCache(
      async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return calls;
      },
      1000,
      100,
      () => now,
    );
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    NodeAssert.deepEqual([a.data, b.data, calls], [1, 1, 1]);
    now = 999;
    NodeAssert.equal((await cache.get()).data, 1);
    now = 1000;
    fail = true;
    NodeAssert.equal((await cache.get()).data, 1, "stale value while the source fails");
    now = 1050;
    await cache.get();
    NodeAssert.equal(calls, 2, "no retry within retryMs");
    fail = false;
    now = 1101;
    NodeAssert.equal((await cache.get()).data, 3);

    const empty = new TtlCache(async () => Promise.reject(new Error("down")), 1000);
    await NodeAssert.rejects(empty.get(), /down/);
  },
);

NodeTest.test("Coolify backups are configured only with URL, token and database UUID", () => {
  const base = { DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x", AUTH_ENABLED: "0" };
  NodeAssert.equal(readConfig(base).ops.coolify, null);
  NodeAssert.equal(readConfig({ ...base, COOLIFY_URL: "https://c.example" }).ops.coolify, null);
  NodeAssert.deepEqual(
    readConfig({
      ...base,
      COOLIFY_URL: "https://c.example/api/v1/",
      COOLIFY_API_TOKEN: "t",
      COOLIFY_DATABASE_UUID: "abc123",
    }).ops.coolify,
    { url: "https://c.example", token: "t", databaseUuid: "abc123" },
  );
  NodeAssert.equal(readConfig(base).ops.releasesRepo, "Libes6/Gustaf");
  NodeAssert.throws(() => readConfig({ ...base, GITHUB_RELEASES_REPO: "../x" }), /owner\/name/);
});
