// The only way the device driver starts a process: an injected runner, so the driver is testable without a Mac.
// The real one (shellRunner.ts) goes through providers/processHost.ts; tests pass a fake that replays recorded output.

export type RunOptions = {
  /** Kill the process tree after this long; the result then has `timedOut: true`. */
  timeoutMs?: number;
  /**
   * Start the script and return at once with code 0 and empty output; the process lives on (an emulator window).
   * The real runner keeps it in the process ledger, so the app still ends it on quit.
   */
  detached?: boolean;
  /** Every non-empty line of stdout and stderr as it arrives (install progress). */
  onLine?: (line: string) => void;
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

/** Runs `script` in the OS shell (POSIX syntax: zsh on macOS, bash on Linux). */
export type CommandRunner = (script: string, opts?: RunOptions) => Promise<RunResult>;
