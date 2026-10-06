// Watching a pull request for a chat (T9). Pure: the snapshot shape, what changed between two snapshots and when to
// stop (tests/prWatch.test.mjs). lib/prWatch.ts polls `gh pr view` once a minute and wakes the chat with a message.

export type PrCheck = { name: string; status: string; conclusion: string };
export type PrSnapshot = {
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  title: string;
  url: string;
  number: number;
  author: string;
  checks: PrCheck[];
  comments: { id: string; author: string }[];
  reviews: { id: string; author: string; state: string }[];
};

export type PrWatch = {
  chatId: number;
  root: string;
  pr: string;
  startedAt: number;
  last?: PrSnapshot;
  /** Last successful read; reading failures for 15 minutes stop the watch. */
  okAt: number;
  /** Wakes caused only by comments or reviews; 10 stop the watch. */
  commentWakes: number;
  stopped?: { reason: "merged" | "closed" | "comments" | "unreadable" | "user"; at: number };
};

export const POLL_MS = 60_000;
export const UNREADABLE_MS = 15 * 60_000;
export const MAX_COMMENT_WAKES = 10;

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const failing = (c: PrCheck) => FAILED.has(c.conclusion.toUpperCase());
const done = (c: PrCheck) => !["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"].includes(c.status.toUpperCase()) && c.conclusion !== "";
export const allPassed = (s: PrSnapshot) => s.checks.length > 0 && s.checks.every((c) => done(c) && PASSED.has(c.conclusion.toUpperCase()));

export function parseSnapshot(json: string): PrSnapshot {
  const v = JSON.parse(json);
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  return {
    state: str(v.state), mergeable: str(v.mergeable), title: str(v.title), url: str(v.url), number: Number(v.number) || 0, author: str(v.author),
    checks: arr(v.checks).map((c: any) => ({ name: str(c?.name), status: str(c?.status), conclusion: str(c?.conclusion) })),
    comments: arr(v.comments).map((c: any) => ({ id: str(c?.id), author: str(c?.author) })),
    reviews: arr(v.reviews).map((r: any) => ({ id: str(r?.id), author: str(r?.author), state: str(r?.state) })),
  };
}

export type PrEvent =
  | { kind: "checks-failed"; names: string[] }
  | { kind: "checks-passed" }
  | { kind: "comment"; authors: string[]; count: number }
  | { kind: "review"; authors: string[]; states: string[] }
  | { kind: "conflict" }
  | { kind: "merged" }
  | { kind: "closed" };

/** What changed since the previous snapshot; each change is reported once. Comments and reviews by the PR author are ignored. */
export function diffSnapshots(prev: PrSnapshot | undefined, next: PrSnapshot): PrEvent[] {
  if (!prev) return [];
  const out: PrEvent[] = [];
  if (next.state === "MERGED" && prev.state !== "MERGED") return [{ kind: "merged" }];
  if (next.state === "CLOSED" && prev.state !== "CLOSED") return [{ kind: "closed" }];
  const wasFailing = new Set(prev.checks.filter(failing).map((c) => c.name));
  const newlyFailed = next.checks.filter((c) => failing(c) && !wasFailing.has(c.name)).map((c) => c.name);
  if (newlyFailed.length) out.push({ kind: "checks-failed", names: newlyFailed });
  else if (allPassed(next) && !allPassed(prev)) out.push({ kind: "checks-passed" });
  const seenComments = new Set(prev.comments.map((c) => c.id));
  const comments = next.comments.filter((c) => !seenComments.has(c.id) && c.author !== next.author);
  if (comments.length) out.push({ kind: "comment", authors: [...new Set(comments.map((c) => c.author))], count: comments.length });
  const seenReviews = new Set(prev.reviews.map((r) => r.id));
  const reviews = next.reviews.filter((r) => !seenReviews.has(r.id) && r.author !== next.author);
  if (reviews.length) out.push({ kind: "review", authors: [...new Set(reviews.map((r) => r.author))], states: [...new Set(reviews.map((r) => r.state))] });
  if (next.mergeable === "CONFLICTING" && prev.mergeable !== "CONFLICTING") out.push({ kind: "conflict" });
  return out;
}

/** The message that wakes the agent in the chat (English, like other agent-facing text). */
export function wakeMessage(s: PrSnapshot, events: PrEvent[]): string {
  const lines = events.map((e) =>
    e.kind === "checks-failed" ? `- Checks failed: ${e.names.join(", ")}. Inspect the logs (\`gh pr checks ${s.number}\`, \`gh run view --log-failed\`) and fix them.`
    : e.kind === "checks-passed" ? "- All checks passed."
    : e.kind === "comment" ? `- New comment${e.count > 1 ? "s" : ""} from ${e.authors.join(", ")}. Read them (\`gh pr view ${s.number} --comments\`) and respond or address them.`
    : e.kind === "review" ? `- New review from ${e.authors.join(", ")} (${e.states.join(", ")}). Read it and address the requested changes.`
    : e.kind === "conflict" ? "- The branch now conflicts with the base branch. Update it and resolve the conflicts."
    : e.kind === "merged" ? "- The pull request was merged."
    : "- The pull request was closed.");
  return `Update on the pull request you are watching: ${s.title} (${s.url})\n${lines.join("\n")}`;
}

/** Applies one poll result to the watch: the events to report and the updated watch. */
export function step(w: PrWatch, r: { ok: true; snapshot: PrSnapshot } | { ok: false; error: string }, now: number): { watch: PrWatch; events: PrEvent[] } {
  if (w.stopped) return { watch: w, events: [] };
  if (!r.ok) {
    return now - w.okAt >= UNREADABLE_MS ? { watch: { ...w, stopped: { reason: "unreadable", at: now } }, events: [] } : { watch: w, events: [] };
  }
  const events = diffSnapshots(w.last, r.snapshot);
  let watch: PrWatch = { ...w, last: r.snapshot, okAt: now };
  if (events.some((e) => e.kind === "merged")) watch = { ...watch, stopped: { reason: "merged", at: now } };
  else if (events.some((e) => e.kind === "closed") || (!w.last && r.snapshot.state === "CLOSED")) watch = { ...watch, stopped: { reason: "closed", at: now } };
  else if (!w.last && r.snapshot.state === "MERGED") watch = { ...watch, stopped: { reason: "merged", at: now } };
  const onlyTalk = events.length > 0 && events.every((e) => e.kind === "comment" || e.kind === "review");
  if (onlyTalk) {
    watch = { ...watch, commentWakes: watch.commentWakes + 1 };
    if (watch.commentWakes >= MAX_COMMENT_WAKES) watch = { ...watch, stopped: { reason: "comments", at: now } };
  }
  return { watch, events };
}
