import { describe, expect, it } from "vite-plus/test";

import {
  applySshAddLogEvent,
  formatSshAddLog,
  getSshAddLog,
  recordSshAddLogEvent,
  resetSshAddLog,
  sshAddLogElapsedMs,
  trackSshAddLogStep,
  type SshAddLogEntry,
  type SshAddLogEvent,
} from "./sshAddLog";

const apply = (events: ReadonlyArray<SshAddLogEvent>) =>
  events.reduce<ReadonlyArray<SshAddLogEntry>>(applySshAddLogEvent, []);

describe("applySshAddLogEvent", () => {
  it("runs a step to done and keeps the order of steps", () => {
    const log = apply([
      { step: "resolve-host", status: "running", detail: "devbox", at: 100 },
      { step: "resolve-host", status: "done", at: 400 },
      { step: "connect", status: "running", at: 400 },
    ]);
    expect(log).toEqual([
      { step: "resolve-host", status: "done", detail: "devbox", startedAt: 100, endedAt: 400 },
      { step: "connect", status: "running", startedAt: 400 },
    ]);
  });

  it("updates a running step's detail without restarting its clock", () => {
    const log = apply([
      { step: "connect", status: "running", at: 100 },
      { step: "connect", status: "running", detail: "retrying", at: 900 },
    ]);
    expect(log).toEqual([
      { step: "connect", status: "running", detail: "retrying", startedAt: 100 },
    ]);
  });

  it("records a failure with its cause on the step that was running", () => {
    const log = apply([
      { step: "runtime-download", status: "running", detail: "v1.0.0 · github.com", at: 0 },
      { step: "runtime-download", status: "failed", detail: "Could not download t3", at: 5_000 },
    ]);
    expect(log).toEqual([
      {
        step: "runtime-download",
        status: "failed",
        detail: "Could not download t3",
        startedAt: 0,
        endedAt: 5_000,
      },
    ]);
  });

  it("lets a failure land on a finished step but not a late done", () => {
    const finished = apply([
      { step: "tunnel", status: "running", at: 0 },
      { step: "tunnel", status: "done", at: 10 },
    ]);
    expect(applySshAddLogEvent(finished, { step: "tunnel", status: "done", at: 20 })).toBe(
      finished,
    );
    expect(
      applySshAddLogEvent(finished, {
        step: "tunnel",
        status: "failed",
        detail: "gone",
        at: 20,
      })[0],
    ).toMatchObject({ status: "failed", detail: "gone", endedAt: 10 });
  });

  it("starts a new entry when a finished step runs again", () => {
    const log = apply([
      { step: "connect", status: "running", at: 0 },
      { step: "connect", status: "done", at: 10 },
      { step: "password", status: "running", at: 10 },
      { step: "password", status: "done", at: 20 },
      { step: "connect", status: "running", at: 20 },
    ]);
    expect(log.map((entry) => `${entry.step}:${entry.status}`)).toEqual([
      "connect:done",
      "password:done",
      "connect:running",
    ]);
  });
});

describe("sshAddLogElapsedMs", () => {
  it("measures a running step against now and a finished one by its end", () => {
    expect(
      sshAddLogElapsedMs({ step: "connect", status: "running", startedAt: 1_000 }, 4_500),
    ).toBe(3_500);
    expect(
      sshAddLogElapsedMs(
        { step: "connect", status: "done", startedAt: 1_000, endedAt: 2_000 },
        9_999,
      ),
    ).toBe(1_000);
  });
});

describe("formatSshAddLog", () => {
  it("writes one English line per entry for a bug report", () => {
    const text = formatSshAddLog(
      apply([
        { step: "resolve-host", status: "running", detail: "devbox", at: 1_000 },
        { step: "resolve-host", status: "done", at: 1_200 },
        { step: "runtime-download", status: "running", at: 1_200 },
        { step: "runtime-download", status: "failed", detail: "line one\nline two", at: 6_200 },
      ]),
    );
    expect(text).toBe(
      [
        "+0.0s resolve-host done (0.2s) - devbox",
        "+0.2s runtime-download failed (5.0s) - line one | line two",
      ].join("\n"),
    );
  });
});

describe("the log store", () => {
  it("keeps a failed attempt until the next one starts", () => {
    const key = "ssh:store-test";
    recordSshAddLogEvent(key, { step: "connect", status: "running", at: 1 });
    recordSshAddLogEvent(key, { step: "connect", status: "failed", detail: "refused", at: 2 });
    expect(getSshAddLog(key)).toHaveLength(1);
    resetSshAddLog(key);
    expect(getSshAddLog(key)).toEqual([]);
  });

  it("tracks a request the renderer makes as one step, success or failure", async () => {
    const key = "ssh:track-test";
    resetSshAddLog(key);
    await expect(trackSshAddLogStep(key, "descriptor", async () => "ok")).resolves.toBe("ok");
    await expect(
      trackSshAddLogStep(key, "session", async () => {
        throw new Error("[ssh_http:500] SSH remote API request failed during bootstrap.");
      }),
    ).rejects.toThrow("ssh_http:500");
    expect(getSshAddLog(key).map((entry) => `${entry.step}:${entry.status}`)).toEqual([
      "descriptor:done",
      "session:failed",
    ]);
    expect(getSshAddLog(key)[1]?.detail).toContain("ssh_http:500");
  });
});
