// Command approval shared by the agent loop and the review panel. Pure: Node runs this file directly in tests.
// The rules themselves (allow / ask / deny, built-in protections, command parsing) live in agent/rules.ts.
import {
  DEFAULT_RULES,
  decideCommand,
  evaluateCommand,
  legacyAllowRules,
  type Access,
  type CommandAction,
  type RulesConfig,
} from "../agent/rules.ts";

export type CommandAccess = Access;

/** True when `cmd` would run under the old "always allowed" list alone (prefix rules on every simple command). */
export const commandAllowed = (cmd: string, allowlist: string[]) =>
  evaluateCommand(cmd, legacyAllowRules(allowlist)).decision === "allow";

/** What happens to a command run on the user's behalf outside the agent loop: run, ask first, or refuse (deny rule / read-only). */
export const commandVerdict = (
  access: CommandAccess,
  cmd: string,
  allowlist: string[],
  config: RulesConfig = DEFAULT_RULES,
  project: string | null = null,
): CommandAction => decideCommand(cmd, { config, allowlist, project }, access).action;

/** True when the user must confirm `cmd`; a blocked command also needs more than a click, so it is reported as needing approval. */
export const commandNeedsApproval = (
  access: CommandAccess,
  cmd: string,
  allowlist: string[],
  config: RulesConfig = DEFAULT_RULES,
  project: string | null = null,
) => commandVerdict(access, cmd, allowlist, config, project) !== "run";
