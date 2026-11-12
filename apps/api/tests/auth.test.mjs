import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { NotFoundException } from "@nestjs/common";
import { createApp } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import {
  createDeviceToken,
  hashDeviceToken,
  readDeviceToken,
} from "../dist/devices/device-token.js";
import { ownedOrNotFound } from "../dist/ownership.js";

const auth = {
  DATABASE_URL: "postgresql://hidden:secret@127.0.0.1:1/missing",
  BETTER_AUTH_SECRET: "unit-test-secret-unit-test-secret-0123",
  PUBLIC_BASE_URL: "https://api.example.test",
  GITHUB_CLIENT_ID: "unit-test-client",
  GITHUB_CLIENT_SECRET: "unit-test-secret",
};

NodeTest.test("auth config is required unless AUTH_ENABLED=0", () => {
  NodeAssert.equal(readConfig({ DATABASE_URL: auth.DATABASE_URL, AUTH_ENABLED: "0" }).auth, null);
  NodeAssert.throws(
    () => readConfig({ DATABASE_URL: auth.DATABASE_URL }),
    /BETTER_AUTH_SECRET, PUBLIC_BASE_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET are not set.*AUTH_ENABLED=0/,
  );
  NodeAssert.throws(
    () => readConfig({ ...auth, GITHUB_CLIENT_SECRET: " " }),
    /GITHUB_CLIENT_SECRET is not set/,
  );
  NodeAssert.throws(() => readConfig({ ...auth, BETTER_AUTH_SECRET: "short" }), /at least 32/);
  for (const url of [
    "http://api.example.test",
    "https://api.example.test/v1",
    "api.example.test",
  ]) {
    NodeAssert.throws(() => readConfig({ ...auth, PUBLIC_BASE_URL: url }), /PUBLIC_BASE_URL/);
  }
  NodeAssert.equal(
    readConfig({ ...auth, PUBLIC_BASE_URL: "http://localhost:3100/" }).auth.publicBaseUrl,
    "http://localhost:3100",
  );
  NodeAssert.deepEqual(
    readConfig({
      ...auth,
      NODE_ENV: "production",
      AUTH_TRUSTED_ORIGINS: " https://admin.example.test, gustaf:// ,,",
    }).auth.trustedOrigins,
    ["https://admin.example.test", "gustaf://"],
  );
  NodeAssert.throws(
    () => readConfig({ ...auth, AUTH_TRUSTED_ORIGINS: "admin.example.test" }),
    /AUTH_TRUSTED_ORIGINS/,
  );
});

NodeTest.test("device tokens are random, stored only as a hash and parsed strictly", () => {
  const first = createDeviceToken();
  const second = createDeviceToken();
  NodeAssert.match(first.token, /^gdt_[A-Za-z0-9_-]{43}$/);
  NodeAssert.notEqual(first.token, second.token);
  NodeAssert.equal(first.hash, hashDeviceToken(first.token));
  NodeAssert.match(first.hash, /^[0-9a-f]{64}$/);
  NodeAssert.ok(!first.hash.includes(first.token));
  NodeAssert.equal(readDeviceToken(`Bearer ${first.token}`), first.token);
  NodeAssert.equal(readDeviceToken(`bearer  ${first.token} `), first.token);
  for (const header of [
    undefined,
    "",
    first.token,
    `Basic ${first.token}`,
    "Bearer gdt_short",
    "Bearer sessiontoken.signature",
  ]) {
    NodeAssert.equal(readDeviceToken(header), undefined);
  }
});

NodeTest.test("ownership answers 404 for missing and foreign resources alike", () => {
  const row = { id: "d1", userId: "alice" };
  NodeAssert.equal(ownedOrNotFound("alice", row), row);
  NodeAssert.throws(() => ownedOrNotFound("bob", row), NotFoundException);
  NodeAssert.throws(() => ownedOrNotFound("alice", undefined), NotFoundException);
});

NodeTest.test(
  "account routes exist only with auth enabled and reject anonymous calls",
  async () => {
    for (const [env, expected] of [
      [auth, 401],
      [{ DATABASE_URL: auth.DATABASE_URL, AUTH_ENABLED: "0" }, 404],
    ]) {
      const app = await createApp(readConfig(env));
      app.useLogger(false);
      try {
        await app.listen(0, "127.0.0.1");
        const url = await app.getUrl();
        NodeAssert.equal((await fetch(`${url}/v1/me`)).status, expected);
        const device = await fetch(`${url}/v1/devices/self`, {
          headers: { authorization: "Bearer not-a-device-token" },
        });
        NodeAssert.equal(device.status, expected);
      } finally {
        await app.close();
      }
    }
  },
);
