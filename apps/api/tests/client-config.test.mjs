import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { AdminGuard } from "../dist/admin/admin.guard.js";
import {
  announcementVisible,
  compareVersions,
  flagEnabled,
  readAnnouncementInput,
  readClientQuery,
  readFlagInput,
  readFlagKey,
  resolveClientConfig,
} from "../dist/client-config/client-config-rules.js";
import {
  AdminClientConfigController,
  ClientConfigController,
} from "../dist/client-config/client-config.controller.js";

const now = new Date("2026-11-13T12:00:00Z");

const announcement = (overrides = {}) => ({
  id: "a",
  textEn: "Hello",
  textRu: "Привет",
  level: "info",
  link: null,
  target: "all",
  minVersion: null,
  maxVersion: null,
  startsAt: null,
  endsAt: null,
  active: true,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...overrides,
});

NodeTest.test("versions compare by semver precedence", () => {
  const ordered = [
    "0.9.9",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0",
    "v1.0.1",
    "1.2.0",
    "1.10.0",
  ];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      NodeAssert.equal(
        compareVersions(ordered[i], ordered[j]),
        Math.sign(i - j),
        `${ordered[i]} vs ${ordered[j]}`,
      );
    }
  }
  NodeAssert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
});

NodeTest.test("announcements match by kind, schedule and inclusive version range", () => {
  const desktop = { kind: "desktop", version: "1.4.0" };
  NodeAssert.ok(announcementVisible(announcement(), desktop, now));
  NodeAssert.ok(!announcementVisible(announcement({ active: false }), desktop, now));
  NodeAssert.ok(announcementVisible(announcement({ target: "desktop" }), desktop, now));
  NodeAssert.ok(!announcementVisible(announcement({ target: "mobile" }), desktop, now));
  NodeAssert.ok(!announcementVisible(announcement({ startsAt: new Date(+now + 1) }), desktop, now));
  NodeAssert.ok(announcementVisible(announcement({ startsAt: now }), desktop, now));
  NodeAssert.ok(!announcementVisible(announcement({ endsAt: now }), desktop, now));
  NodeAssert.ok(announcementVisible(announcement({ endsAt: new Date(+now + 1) }), desktop, now));
  for (const [range, visible] of [
    [{ minVersion: "1.4.0" }, true],
    [{ minVersion: "1.4.1" }, false],
    [{ maxVersion: "1.4.0" }, true],
    [{ maxVersion: "1.4.0-rc.1" }, false],
    [{ minVersion: "1.0.0", maxVersion: "2.0.0" }, true],
  ]) {
    NodeAssert.equal(announcementVisible(announcement(range), desktop, now), visible, range);
  }
  // Without a version the client is outside every range.
  NodeAssert.ok(
    !announcementVisible(announcement({ minVersion: "0.0.1" }), { ...desktop, version: null }, now),
  );
});

NodeTest.test("flags are on for everyone, for listed logins only, or off", () => {
  NodeAssert.equal(flagEnabled({ key: "x", mode: "off", logins: ["ivan"] }, "ivan"), false);
  NodeAssert.equal(flagEnabled({ key: "x", mode: "everyone", logins: [] }, null), true);
  const listed = { key: "x", mode: "listed", logins: ["ivan"] };
  NodeAssert.equal(flagEnabled(listed, "Ivan"), true);
  NodeAssert.equal(flagEnabled(listed, "olga"), false);
  NodeAssert.equal(flagEnabled(listed, null), false);
});

NodeTest.test("the resolved config orders announcements and reports a required update", () => {
  const rows = {
    announcements: [
      announcement({ id: "old-info" }),
      announcement({ id: "new-info", createdAt: new Date("2026-11-10T00:00:00Z") }),
      announcement({ id: "critical", level: "critical" }),
      announcement({ id: "mobile", target: "mobile" }),
    ],
    minimumVersions: [
      { kind: "desktop", version: "1.5.0", message: "Security fix" },
      { kind: "mobile", version: "9.0.0", message: null },
    ],
    flags: [
      { key: "beta", mode: "listed", logins: ["ivan"] },
      { key: "everyone", mode: "everyone", logins: [] },
    ],
  };
  const config = resolveClientConfig(rows, { kind: "desktop", version: "1.4.0" }, "ivan", now);
  NodeAssert.deepEqual(
    config.announcements.map((item) => item.id),
    ["critical", "new-info", "old-info"],
  );
  NodeAssert.deepEqual(config.announcements[0].text, { en: "Hello", ru: "Привет" });
  NodeAssert.deepEqual(config.update, {
    required: true,
    minimumVersion: "1.5.0",
    message: "Security fix",
  });
  NodeAssert.deepEqual(config.flags, { beta: true, everyone: true });

  const current = resolveClientConfig(rows, { kind: "desktop", version: "1.5.0" }, null, now);
  NodeAssert.equal(current.update.required, false);
  NodeAssert.deepEqual(current.flags, { beta: false, everyone: true });
  const unknown = resolveClientConfig(rows, { kind: "desktop", version: null }, null, now);
  NodeAssert.equal(unknown.update.required, false);
  const noMinimum = resolveClientConfig(
    { ...rows, minimumVersions: [] },
    { kind: "desktop", version: "0.0.1" },
    null,
    now,
  );
  NodeAssert.deepEqual(noMinimum.update, { required: false, minimumVersion: null, message: null });
});

NodeTest.test("the client query needs a kind and drops an unparseable version", () => {
  NodeAssert.deepEqual(readClientQuery({ kind: "mobile", version: "1.2.3" }), {
    kind: "mobile",
    version: "1.2.3",
  });
  NodeAssert.deepEqual(readClientQuery({ kind: "desktop", version: "dev" }), {
    kind: "desktop",
    version: null,
  });
  for (const kind of [undefined, "web", ["desktop"]]) {
    NodeAssert.throws(() => readClientQuery({ kind }), BadRequestException);
  }
});

NodeTest.test("admin input is validated", () => {
  const valid = {
    textEn: " Maintenance tonight ",
    textRu: "Работы ночью",
    level: "warning",
    target: "desktop",
    link: "https://status.example.test",
    minVersion: "1.0.0",
    maxVersion: "2.0.0",
    startsAt: "2026-11-13T00:00:00Z",
    endsAt: "2026-11-14T00:00:00Z",
    active: true,
  };
  const input = readAnnouncementInput(valid);
  NodeAssert.equal(input.textEn, "Maintenance tonight");
  NodeAssert.ok(input.startsAt instanceof Date);
  NodeAssert.equal(readAnnouncementInput({ ...valid, link: "" }).link, null);
  for (const bad of [
    { textEn: "" },
    { textRu: "x".repeat(1001) },
    { level: "loud" },
    { target: "web" },
    { link: "http://insecure.example.test" },
    { link: "javascript:alert(1)" },
    { minVersion: "1.0" },
    { minVersion: "3.0.0" },
    { endsAt: "2026-11-12T00:00:00Z" },
    { startsAt: "tomorrow" },
    { active: "yes" },
  ]) {
    NodeAssert.throws(() => readAnnouncementInput({ ...valid, ...bad }), BadRequestException);
  }

  NodeAssert.deepEqual(readFlagInput({ mode: "listed", logins: [" @Ivan ", "olga", "ivan", ""] }), {
    description: "",
    mode: "listed",
    logins: ["ivan", "olga"],
  });
  NodeAssert.throws(() => readFlagInput({ mode: "some" }), BadRequestException);
  NodeAssert.throws(() => readFlagInput({ mode: "off", logins: ["a/b"] }), BadRequestException);
  NodeAssert.equal(readFlagKey("new-composer.v2"), "new-composer.v2");
  for (const key of ["", "Upper", "9lives", "a b", "x".repeat(65), undefined]) {
    NodeAssert.throws(() => readFlagKey(key), BadRequestException);
  }
});

NodeTest.test("admin config routes sit behind the admin guard; the client route does not", () => {
  NodeAssert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminClientConfigController), [
    AdminGuard,
  ]);
  NodeAssert.equal(Reflect.getMetadata(GUARDS_METADATA, ClientConfigController), undefined);
});
