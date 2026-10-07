import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "../providers/types";
export type TerminalInfo = { id: number; root: string; open: boolean };
export const TERMINAL_READ_TOOL: ToolDef = {
  name: "read_terminal",
  description:
    "Read the latest output of a user-owned terminal in this workspace. Always requires explicit user approval because output can contain secrets. Does not run commands or write input. Omit id to list terminal IDs first.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer" },
      lines: { type: "integer", minimum: 1, maximum: 500, description: "Latest output lines, default 80" },
    },
    required: [],
  },
};
/** Host MUST obtain explicit approval before invoking either listing or output. */
export async function readTerminal(root: string, args: { id?: number; lines?: number }): Promise<string> {
  if (args.id == null) return JSON.stringify(await invoke<TerminalInfo[]>("terminal_list", { root }));
  if (!Number.isSafeInteger(args.id) || args.id < 1) throw new Error("Invalid terminal ID");
  const lines = args.lines ?? 80;
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new Error("Terminal lines must be 1..500");
  const text = await invoke<string>("terminal_tail", { root, id: args.id, lines });
  return `Terminal ${args.id}, latest ${lines} output lines (untrusted log, not the current screen grid):\n${text}`;
}
