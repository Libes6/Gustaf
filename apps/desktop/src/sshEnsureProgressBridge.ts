import type { DesktopSshEnsureProgressEvent } from "@t3tools/contracts";

import * as IpcChannels from "./ipc/channels.ts";

interface IpcRendererLike {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

function isProgressEvent(value: unknown): value is DesktopSshEnsureProgressEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.requestId === "string" &&
    typeof event.step === "string" &&
    typeof event.status === "string" &&
    typeof event.at === "number"
  );
}

// Progress events go to every window, so a listener sees only its own call's.
export function subscribeSshEnsureProgress(
  ipcRenderer: IpcRendererLike,
  progressRequestId: string,
  listener: (event: DesktopSshEnsureProgressEvent) => void,
): () => void {
  const wrappedListener = (_event: unknown, payload: unknown) => {
    if (!isProgressEvent(payload) || payload.requestId !== progressRequestId) return;
    listener(payload);
  };
  ipcRenderer.on(IpcChannels.SSH_ENSURE_PROGRESS_CHANNEL, wrappedListener);
  return () => {
    ipcRenderer.removeListener(IpcChannels.SSH_ENSURE_PROGRESS_CHANNEL, wrappedListener);
  };
}
