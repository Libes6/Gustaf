// Which device an agent is driving right now: a tiny external store (subscribe / get) the Device panel reads to show its
// "Agent is controlling this device" banner. The agent loop sets it when a device tool starts and clears it when the run
// ends or is stopped. Pure TypeScript, no React: the panel wraps it in `useSyncExternalStore`.

export type AgentDeviceActivity = {
  /** The chat whose agent is acting. */
  chatId: number;
  deviceId: string;
  /** Display name of the device. */
  name: string;
  /** The tool in flight or the last one that ran, e.g. `device_tap`. */
  tool: string;
  since: number;
};

let entries: readonly AgentDeviceActivity[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly AgentDeviceActivity[]) => {
  entries = next;
  listeners.forEach((l) => l());
};

/** Marks `chatId` as driving a device (or updates the tool shown). `since` is kept while the device stays the same. */
export function setAgentDevice(a: { chatId: number; deviceId: string; name: string; tool: string }, now = Date.now()) {
  const old = entries.find((e) => e.chatId === a.chatId);
  if (old && old.deviceId === a.deviceId && old.tool === a.tool && old.name === a.name) return;
  const since = old && old.deviceId === a.deviceId ? old.since : now;
  publish([...entries.filter((e) => e.chatId !== a.chatId), { ...a, since }]);
}

/** The chat's agent is no longer using a device (run ended or stopped). */
export function clearAgentDevice(chatId: number) {
  if (entries.some((e) => e.chatId === chatId)) publish(entries.filter((e) => e.chatId !== chatId));
}

/** All devices an agent is driving; the array identity changes only when its content does. */
export const getAgentActivity = (): readonly AgentDeviceActivity[] => entries;

/** The agent activity on one device, if any. */
export const agentActivityFor = (deviceId: string) => entries.find((e) => e.deviceId === deviceId);

export function subscribeAgentActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Test helper. */
export const resetAgentActivity = () => publish([]);
