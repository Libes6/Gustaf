import type { DesktopSshEnsureProgressEvent } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { SSH_ENSURE_PROGRESS_CHANNEL } from "./ipc/channels.ts";
import { subscribeSshEnsureProgress } from "./sshEnsureProgressBridge.ts";

function makeFakeIpcRenderer() {
  const listeners = new Set<(event: unknown, payload: unknown) => void>();
  return {
    listeners,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      assert.equal(channel, SSH_ENSURE_PROGRESS_CHANNEL);
      listeners.add(listener);
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      assert.equal(channel, SSH_ENSURE_PROGRESS_CHANNEL);
      listeners.delete(listener);
    },
    emit: (payload: unknown) => {
      for (const listener of listeners) listener({}, payload);
    },
  };
}

const progress = (requestId: string, step: string): DesktopSshEnsureProgressEvent =>
  ({ requestId, step, status: "running", at: 1 }) as DesktopSshEnsureProgressEvent;

describe("subscribeSshEnsureProgress", () => {
  it("forwards only events with its own request id", () => {
    const ipc = makeFakeIpcRenderer();
    const first: Array<DesktopSshEnsureProgressEvent> = [];
    const second: Array<DesktopSshEnsureProgressEvent> = [];
    subscribeSshEnsureProgress(ipc, "add-1", (event) => first.push(event));
    subscribeSshEnsureProgress(ipc, "add-2", (event) => second.push(event));

    ipc.emit(progress("add-1", "connect"));
    ipc.emit(progress("add-2", "resolve-host"));
    ipc.emit(progress("add-3", "tunnel"));
    ipc.emit(progress("add-1", "tunnel"));

    assert.deepEqual(
      first.map((event) => event.step),
      ["connect", "tunnel"],
    );
    assert.deepEqual(
      second.map((event) => event.step),
      ["resolve-host"],
    );
  });

  it("drops payloads that are not progress events", () => {
    const ipc = makeFakeIpcRenderer();
    const received: Array<DesktopSshEnsureProgressEvent> = [];
    subscribeSshEnsureProgress(ipc, "add-1", (event) => received.push(event));
    ipc.emit(null);
    ipc.emit("add-1");
    ipc.emit({ requestId: "add-1" });
    assert.equal(received.length, 0);
  });

  it("stops forwarding once unsubscribed", () => {
    const ipc = makeFakeIpcRenderer();
    const received: Array<DesktopSshEnsureProgressEvent> = [];
    const unsubscribe = subscribeSshEnsureProgress(ipc, "add-1", (event) => received.push(event));
    unsubscribe();
    ipc.emit(progress("add-1", "connect"));
    assert.equal(received.length, 0);
    assert.equal(ipc.listeners.size, 0);
  });
});
