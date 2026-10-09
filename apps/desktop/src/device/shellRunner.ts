// The real CommandRunner: every device process goes through providers/processHost.ts, so it joins the process ledger
// (killed on quit and after a crash) and stops gracefully (SIGTERM to the tree, then SIGKILL) on timeout.

import { openJsonProcess } from "../providers/processHost";
import type { CommandRunner } from "./runner";

export const createShellRunner =
  (): CommandRunner =>
  async (script, opts = {}) => {
    const lines: string[] = [];
    const proc = await openJsonProcess(script, {
      onRaw: (line) => {
        lines.push(line);
        opts.onLine?.(line);
      },
    });
    if (opts.detached) return { code: 0, stdout: "", stderr: "" };
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void proc.stop();
        }, opts.timeoutMs)
      : undefined;
    try {
      const code = await proc.closed;
      // stderr only keeps its tail (processHost); stdout is every raw line, re-joined with newlines.
      return { code: code ?? -1, stdout: lines.join("\n"), stderr: proc.stderr(), ...(timedOut ? { timedOut } : {}) };
    } finally {
      clearTimeout(timer);
    }
  };
