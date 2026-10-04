/**
 * A tool-card click queues a command for the terminal pane. The pane types a single-line command at the prompt WITHOUT Enter
 * (the user presses Enter); a command that would run by itself when typed (a newline) or trigger shell completion (a tab) is
 * only shown, and goes to the shell after an explicit Run click. Nothing here ever executes a command.
 */
export type TerminalCommand = { id: string; root: string; command: string };
const pending: TerminalCommand[] = [];
const subscribers = new Set<() => void>();

/** Line endings become `\n` and surrounding blank space is dropped, so a trailing newline can never execute what was only meant to be typed. */
export const normalizeTerminalCommand = (command: string) => command.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
/** Typing this text into a shell would execute part of it (newline) or trigger completion (tab). */
export const needsTerminalConfirmation = (command: string) => /[\n\t]/.test(command);

export function requestTerminalCommand(root: string, rawCommand: string) {
  const command = normalizeTerminalCommand(rawCommand);
  if (!root || !command || command.length > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) throw new Error("Invalid terminal command");
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

/** "Open in terminal" from the sidebar: the changes panel of the chat with this root shows its terminal tab (a new shell starts in `root`). */
const openRequests = new Set<string>();
export function requestTerminalOpen(root: string) {
  if (!root) return;
  openRequests.add(root);
  subscribers.forEach(fn => fn());
}
export function takeTerminalOpen(root: string): boolean { return openRequests.delete(root); }
/** Test helper: drops queued commands. */
export const clearTerminalCommands = () => { pending.length = 0; };
