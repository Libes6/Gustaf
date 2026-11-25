import { assert, describe, it } from "@effect/vitest";
import type { DesktopSshEnsureProgress } from "@t3tools/contracts";

import {
  applyRemoteProgressMarker,
  makeRemoteProgressLineFilter,
  makeSshProgressReporter,
  scrubSshProgressText,
  SSH_PROGRESS_MARKER,
} from "./progress.ts";

const collect = () => {
  const events: Array<DesktopSshEnsureProgress> = [];
  let clock = 0;
  const reporter = makeSshProgressReporter(
    (event) => events.push(event),
    () => ++clock,
  );
  const summary = () =>
    events.map((event) => `${event.step}:${event.status}${event.detail ? `:${event.detail}` : ""}`);
  return { reporter, events, summary };
};

describe("makeSshProgressReporter", () => {
  it("finishes the previous step when the next one starts", () => {
    const { reporter, summary } = collect();
    reporter.enter("resolve-host", "devbox");
    reporter.enter("connect");
    reporter.enter("tunnel", "localhost:41773");
    reporter.finish();
    assert.deepStrictEqual(summary(), [
      "resolve-host:running:devbox",
      "resolve-host:done",
      "connect:running",
      "connect:done",
      "tunnel:running:localhost:41773",
      "tunnel:done",
    ]);
  });

  it("stamps each event in order", () => {
    const { reporter, events } = collect();
    reporter.enter("connect");
    reporter.finish();
    assert.deepStrictEqual(
      events.map((event) => event.at),
      [1, 2],
    );
  });

  it("fails the running step, or the last one when none is running", () => {
    const first = collect();
    first.reporter.enter("connect");
    first.reporter.fail("boom");
    assert.deepStrictEqual(first.summary(), ["connect:running", "connect:failed:boom"]);
    assert.isNull(first.reporter.active());

    const second = collect();
    second.reporter.enter("resolve-host");
    second.reporter.finish();
    second.reporter.fail("boom");
    assert.deepStrictEqual(second.summary().at(-1), "resolve-host:failed:boom");
  });

  it("does not throw when the sink does", () => {
    const reporter = makeSshProgressReporter(() => {
      throw new Error("renderer is gone");
    });
    reporter.enter("connect");
    reporter.fail("boom");
  });

  it("is a no-op without a sink", () => {
    const reporter = makeSshProgressReporter(undefined);
    reporter.enter("connect");
    reporter.finish();
    reporter.fail("boom");
    assert.isNull(reporter.active());
  });
});

describe("scrubSshProgressText", () => {
  it.each([
    ['{"credential":"abc123","other":1}', "abc123"],
    ["Authorization: Bearer abc123", "abc123"],
    ["pairing token=abc123 rejected", "abc123"],
    ["password: hunter2", "hunter2"],
    ["https://host.example/pair?token=abc123#frag", "abc123"],
    ["ssh -i /Users/alice/.ssh/id_ed25519 devbox", "alice"],
    ["Identity file /home/bob/keys/prod.pem not accessible", "bob"],
    ["C:\\Users\\carol\\.ssh\\id_rsa", "carol"],
  ])("removes the secret from %j", (input, secret) => {
    const scrubbed = scrubSshProgressText(input);
    assert.notInclude(scrubbed, secret);
  });

  it("keeps the readable cause and the download URL", () => {
    const message =
      "Could not download t3 44.10.1 from https://github.com/Libes6/Gustaf/releases/download/v44.10.1/SHA256SUMS.";
    assert.equal(scrubSshProgressText(message), message);
  });

  it("drops marker lines and bounds the text", () => {
    const scrubbed = scrubSshProgressText(
      `${SSH_PROGRESS_MARKER} runtime.verify\n${"x".repeat(1_000)}`,
    );
    assert.notInclude(scrubbed, SSH_PROGRESS_MARKER);
    assert.isAtMost(scrubbed.length, 401);
    assert.isAtMost(scrubSshProgressText("a\n".repeat(50)).split("\n").length, 6);
  });

  it("scrubs every detail the reporter emits", () => {
    const { reporter, events } = collect();
    reporter.enter("connect", "token=abc123");
    reporter.fail("password: hunter2");
    assert.notInclude(JSON.stringify(events), "abc123");
    assert.notInclude(JSON.stringify(events), "hunter2");
  });
});

describe("applyRemoteProgressMarker", () => {
  const context = { version: "0.23.0", downloadHost: "github.com" };
  const run = (markers: ReadonlyArray<string>) => {
    const collected = collect();
    collected.reporter.enter("connect");
    for (const marker of markers) applyRemoteProgressMarker(collected.reporter, marker, context);
    return collected.summary();
  };

  it("reports an install in order", () => {
    assert.deepStrictEqual(
      run([
        "connected",
        "runtime.check",
        "runtime.download",
        "runtime.verify",
        "runtime.install",
        "runtime.ready",
        "server.check",
        "server.start",
        "server.ready",
      ]),
      [
        "connect:running",
        "connect:done:connected",
        "runtime-check:running:v0.23.0",
        "runtime-check:done:v0.23.0 · not installed",
        "runtime-download:running:v0.23.0 · github.com",
        "runtime-download:done",
        "runtime-verify:running:SHA-256",
        "runtime-verify:done",
        "runtime-install:running:v0.23.0",
        "runtime-install:done",
        "server-check:running",
        "server-check:done",
        "server-start:running",
        "server-start:done",
      ],
    );
  });

  it("reports an installed runtime and a reused server", () => {
    assert.deepStrictEqual(
      run(["connected", "runtime.check", "runtime.ready", "server.check", "server.reuse"]),
      [
        "connect:running",
        "connect:done:connected",
        "runtime-check:running:v0.23.0",
        "runtime-check:done:already installed",
        "server-check:running",
        "server-check:done",
        "server-reuse:running",
      ],
    );
  });

  it("ignores names it does not know", () => {
    assert.deepStrictEqual(run(["from.the.future"]), ["connect:running"]);
  });
});

describe("makeRemoteProgressLineFilter", () => {
  it("passes text through and reports each marker once", () => {
    const markers: Array<string> = [];
    const filter = makeRemoteProgressLineFilter((marker) => markers.push(marker));
    const text =
      filter(`warning\n${SSH_PROGRESS_MARKER} connected\nmore\n${SSH_PROGRESS_MARKER} runtime.`) +
      filter("check\ntail");
    assert.equal(text, "warning\nmore\ntail");
    assert.deepStrictEqual(markers, ["connected", "runtime.check"]);
  });

  it("holds back a partial marker prefix but not other partial lines", () => {
    const filter = makeRemoteProgressLineFilter(() => {});
    assert.equal(filter("@@gustaf"), "");
    assert.equal(filter("-nope\n"), "@@gustaf-nope\n");
    assert.equal(filter("Permission denied"), "Permission denied");
  });
});
