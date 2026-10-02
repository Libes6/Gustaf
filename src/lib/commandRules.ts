// Command approval rules shared by the agent loop and the review panel. Pure: Node runs this file directly in tests.
export type CommandAccess = "readonly" | "auto" | "full";

/** True when `cmd` equals an allowlist entry or starts with one followed by a space. */
export const commandAllowed = (cmd: string, allowlist: string[]) =>
  allowlist.some((p) => cmd === p || cmd.startsWith(p + " "));

/** The same rule `run_command` uses in the agent: only "Ask for commands" mode asks, and only for commands outside the allowlist. */
export const commandNeedsApproval = (access: CommandAccess, cmd: string, allowlist: string[]) =>
  access === "auto" && !commandAllowed(cmd, allowlist);
