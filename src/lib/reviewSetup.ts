// Pure logic for the per-project review setup (dependency links, setup and test commands). Node runs this file
// directly in tests/reviewSetup.test.mjs, so it must not import anything but types.

/** Opt-in per-project settings applied to every shadow copy (review workspace) of that project. */
export type ReviewSetupConfig = {
  /** Project-relative directories symlinked into the shadow copy (read-only intent), e.g. `node_modules`. */
  linkDirs: string[];
  /** Run once inside a fresh shadow copy, before the agent starts (e.g. `npm ci`). Empty = off. */
  setupCommand: string;
  /** Run on demand inside the shadow copy; its result is shown before accepting. Empty = off. */
  testCommand: string;
};

export const EMPTY_REVIEW_SETUP: ReviewSetupConfig = { linkDirs: [], setupCommand: "", testCommand: "" };

export const MAX_LINK_DIRS = 20;
export const MAX_COMMAND_LENGTH = 2000;
export const SETUP_TIMEOUT_MS = 300_000;
export const TEST_TIMEOUT_MS = 300_000;
/** What the panel shows of a command's output: the tail, where failures usually are. */
export const OUTPUT_LIMIT = 6000;

export const reviewSetupKey = (root: string) => `reviewSetup:${root}`;

/**
 * Normalizes one directory to `a/b` form. Returns null for anything that is not a plain project-relative
 * directory: empty, absolute, `..`, `.git`, backslashes or NUL. The backend validates again.
 */
export function normalizeLinkDir(raw: string): string | null {
  const text = String(raw).trim();
  if (text.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." || part === ".git" || /[\\\0]/.test(part)) return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** One directory per line or comma separated; invalid and duplicate entries are dropped. */
export function parseLinkDirs(text: string): string[] {
  const out: string[] = [];
  for (const piece of String(text).split(/[\n,]/)) {
    const dir = normalizeLinkDir(piece);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out.slice(0, MAX_LINK_DIRS);
}

/** Accepts whatever was stored (including garbage) and returns a valid config. */
export function normalizeReviewSetup(raw: unknown): ReviewSetupConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const cmd = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_COMMAND_LENGTH) : "");
  return {
    linkDirs: Array.isArray(o.linkDirs) ? parseLinkDirs(o.linkDirs.filter((d): d is string => typeof d === "string").join("\n")) : [],
    setupCommand: cmd(o.setupCommand),
    testCommand: cmd(o.testCommand),
  };
}

export const hasReviewSetup = (c: ReviewSetupConfig) => c.linkDirs.length > 0 || !!c.setupCommand || !!c.testCommand;

/** Result of a command run in the shadow copy, as shown in the panel. */
export type RunSummary = { command: string; code: number | null; timedOut: boolean; output: string; ok: boolean };

/** Keeps the last `limit` characters (starting on a line boundary when one is near) and says so. */
export function clipOutput(output: string, limit = OUTPUT_LIMIT): string {
  if (output.length <= limit) return output;
  const tail = output.slice(output.length - limit);
  const nl = tail.indexOf("\n");
  return "…\n" + (nl >= 0 && nl < limit / 2 ? tail.slice(nl + 1) : tail);
}

export function summarizeRun(command: string, r: { code: number | null; output: string; timed_out: boolean }): RunSummary {
  return { command, code: r.code, timedOut: r.timed_out, output: clipOutput(r.output), ok: !r.timed_out && r.code === 0 };
}
