/** Single owner of chat writes, shared by interactive and scheduled runs. */
const owners = new Map<number, symbol>();
const listeners = new Set<() => void>();
export const subscribeChatCoordinator = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const chatBusy = (id: number) => owners.has(id);
export function claimChat(id: number): (() => void) | null {
  if (owners.has(id)) return null;
  const token = Symbol(); owners.set(id, token); listeners.forEach(fn => fn());
  return () => { if (owners.get(id) === token) { owners.delete(id); listeners.forEach(fn => fn()); } };
}
export async function waitForChat(id: number, signal: AbortSignal): Promise<() => void> {
  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const release = claimChat(id); if (release) return release;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { unsubscribe(); signal.removeEventListener('abort', abort); };
      const abort = () => { clean(); reject(new DOMException('Aborted', 'AbortError')); };
      const unsubscribe = subscribeChatCoordinator(() => { clean(); resolve(); });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
