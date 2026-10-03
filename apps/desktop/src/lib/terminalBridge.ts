/** A tool-card click queues a preview, never writes to a shell without the user's Run click. */
export type TerminalCommand = { id: string; root: string; command: string };
const pending: TerminalCommand[] = [];
const subscribers = new Set<() => void>();
export function requestTerminalCommand(root: string, command: string) {
  if (!root || !command.trim() || command.length > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) throw new Error("Invalid terminal command");
  if (pending.length >= 32) throw new Error("Too many pending terminal commands");
  pending.push({ id: crypto.randomUUID(), root, command });
  subscribers.forEach(fn => fn());
}
export function takeTerminalCommands(root: string): TerminalCommand[] {
  const matches = pending.filter(c => c.root === root);
  for (const c of matches) pending.splice(pending.indexOf(c), 1);
  return matches;
}
export function onTerminalCommand(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }

export const hasTerminalCommands = (root: string) => pending.some(c => c.root === root);
