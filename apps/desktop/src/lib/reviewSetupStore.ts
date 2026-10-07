import { fsx, getSetting, review, setSetting, type Review } from "./api";
import { commandVerdict, type CommandAccess } from "./commandRules";
import { getRulesConfig } from "../agent/rulesStore";
import { DEFAULT_RULES } from "../agent/rules";
import { worktrees } from "./worktrees";
import {
  EMPTY_REVIEW_SETUP,
  normalizeReviewSetup,
  reviewSetupKey,
  SETUP_TIMEOUT_MS,
  summarizeRun,
  type ReviewSetupConfig,
  type RunSummary,
} from "./reviewSetup";

export const loadReviewSetup = async (root: string): Promise<ReviewSetupConfig> =>
  normalizeReviewSetup(
    await getSetting<unknown>(reviewSetupKey(root), EMPTY_REVIEW_SETUP).catch(() => EMPTY_REVIEW_SETUP),
  );

export const saveReviewSetup = (root: string, config: ReviewSetupConfig) =>
  setSetting(reviewSetupKey(root), normalizeReviewSetup(config));

export type ShadowSetup = { review: Review; setup: RunSummary | "declined" | null };
export type SetupOptions = {
  access: CommandAccess;
  allowlist: string[];
  approve: (command: string) => Promise<boolean>;
  onSetup?: (running: boolean) => void;
};

/** The configured setup command through the normal approval rules: declined, or run by `run` and summarized. Null when none is configured. */
async function runSetup(
  root: string,
  cfg: ReviewSetupConfig,
  o: SetupOptions,
  run: (command: string) => ReturnType<typeof fsx.run>,
): Promise<RunSummary | "declined" | null> {
  if (!cfg.setupCommand) return null;
  const verdict = commandVerdict(
    o.access,
    cfg.setupCommand,
    o.allowlist,
    await getRulesConfig().catch(() => DEFAULT_RULES),
    root,
  );
  if (verdict === "block" || (verdict === "ask" && !(await o.approve(cfg.setupCommand)))) return "declined";
  o.onSetup?.(true);
  try {
    return summarizeRun(cfg.setupCommand, await run(cfg.setupCommand));
  } finally {
    o.onSetup?.(false);
  }
}

/**
 * Creates the shadow copy with the project's linked dependency directories and, if configured, runs the setup command
 * inside it. The command goes through the normal approval rules; if declined the review is still usable.
 */
export async function prepareShadowCopy(root: string, o: SetupOptions): Promise<ShadowSetup> {
  const cfg = await loadReviewSetup(root);
  const created = await review.prepare(root, cfg.linkDirs);
  return {
    review: created,
    setup: await runSetup(root, cfg, o, (command) => review.run(created.id, command, SETUP_TIMEOUT_MS)),
  };
}

/**
 * The same setup for a git worktree workspace: the project's linked dependency directories are symlinked into the
 * checkout (`worktrees.linkDirs`, same validation as the shadow copy) and the setup command runs with `checkoutRoot`
 * as its working directory, through the same approval rules. Nothing here touches the main checkout.
 */
export async function prepareWorkspaceSetup(
  root: string,
  taskId: string,
  checkoutRoot: string,
  o: SetupOptions,
): Promise<RunSummary | "declined" | null> {
  const cfg = await loadReviewSetup(root);
  if (cfg.linkDirs.length) await worktrees.linkDirs(root, taskId, cfg.linkDirs);
  return runSetup(root, cfg, o, (command) => fsx.run(checkoutRoot, command, SETUP_TIMEOUT_MS));
}
