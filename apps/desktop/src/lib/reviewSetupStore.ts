import { getSetting, review, setSetting, type Review } from "./api";
import { commandVerdict, type CommandAccess } from "./commandRules";
import { getRulesConfig } from "../agent/rulesStore";
import { DEFAULT_RULES } from "../agent/rules";
import { EMPTY_REVIEW_SETUP, normalizeReviewSetup, reviewSetupKey, SETUP_TIMEOUT_MS, summarizeRun, type ReviewSetupConfig, type RunSummary } from "./reviewSetup";

export const loadReviewSetup = async (root: string): Promise<ReviewSetupConfig> =>
  normalizeReviewSetup(await getSetting<unknown>(reviewSetupKey(root), EMPTY_REVIEW_SETUP).catch(() => EMPTY_REVIEW_SETUP));

export const saveReviewSetup = (root: string, config: ReviewSetupConfig) => setSetting(reviewSetupKey(root), normalizeReviewSetup(config));

export type ShadowSetup = { review: Review; setup: RunSummary | "declined" | null };

/**
 * Creates the shadow copy with the project's linked dependency directories and, if configured, runs the setup command
 * inside it. The command goes through the normal approval rules; if declined the review is still usable.
 */
export async function prepareShadowCopy(
  root: string,
  o: { access: CommandAccess; allowlist: string[]; approve: (command: string) => Promise<boolean>; onSetup?: (running: boolean) => void },
): Promise<ShadowSetup> {
  const cfg = await loadReviewSetup(root);
  const created = await review.prepare(root, cfg.linkDirs);
  if (!cfg.setupCommand) return { review: created, setup: null };
  const verdict = commandVerdict(o.access, cfg.setupCommand, o.allowlist, await getRulesConfig().catch(() => DEFAULT_RULES), root);
  if (verdict === "block" || (verdict === "ask" && !(await o.approve(cfg.setupCommand)))) return { review: created, setup: "declined" };
  o.onSetup?.(true);
  try {
    return { review: created, setup: summarizeRun(cfg.setupCommand, await review.run(created.id, cfg.setupCommand, SETUP_TIMEOUT_MS)) };
  } finally { o.onSetup?.(false); }
}
