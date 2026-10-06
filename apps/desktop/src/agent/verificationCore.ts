// Verification gates ("definition of done", docs/features/verification-gates.md). This file is pure (no Tauri, no
// React): the check schema and its validation, the effective list, the failure signature used by the kill criteria,
// output clipping and the texts sent to the model. Node runs it directly in tests/verification.test.mjs; the runtime
// that executes the checks is verification.ts.
import { redactSecrets } from "../lib/exportChats.ts";

export type CheckSource = "settings" | "project";
export type Check = { name: string; command: string; timeoutMs: number; source: CheckSource };
/** A rejected entry (`index` is its position in the `checks` array, null for the file or setting as a whole). */
export type CheckIssue = { source: CheckSource; index: number | null; message: string };

/** What is stored per project in the settings table (key `verification:<project>`). */
export type VerificationSettings = { checks: { name: string; command: string; timeoutMs: number }[]; maxFixAttempts: number; useProjectFile: boolean };
/** The file `<project>/.gustaf/done.json` (or the legacy `.mcode/done.json`), validated. */
export type DoneFile = { checks: Check[]; maxFixAttempts?: number; issues: CheckIssue[] };
/** What one run uses. */
export type VerificationConfig = { checks: Check[]; maxFixAttempts: number; issues: CheckIssue[] };

export const SETTING_PREFIX = "verification:";
export const PROJECT_DONE_FILE = ".gustaf/done.json";
export const MAX_CHECKS = 10;
export const MAX_CHECK_COMMAND = 2_000;
export const MAX_CHECK_NAME = 60;
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MIN_CHECK_TIMEOUT_MS = 1_000;
export const MAX_CHECK_TIMEOUT_MS = 600_000;
export const DEFAULT_FIX_ATTEMPTS = 2;
export const MAX_FIX_ATTEMPTS = 5;
/** A done.json larger than this is ignored as a whole. */
export const MAX_DONE_FILE_BYTES = 64 * 1024;
/** Output kept per check in the card and in the chat history. */
export const MAX_CHECK_OUTPUT = 6_000;
/** Output of the failing check that is sent back to the model. */
export const MAX_FEEDBACK_OUTPUT = 3_500;
/** The same failure this many times in a row ends the loop early. */
export const KILL_REPEATS = 3;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const defaultSettings = (): VerificationSettings => ({ checks: [], maxFixAttempts: DEFAULT_FIX_ATTEMPTS, useProjectFile: false });

const isTimeout = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MIN_CHECK_TIMEOUT_MS && v <= MAX_CHECK_TIMEOUT_MS;
const isFixAttempts = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_FIX_ATTEMPTS;

/** Validates a list of checks. Invalid entries are skipped and reported; nothing here throws. */
export function validateChecks(raw: unknown, source: CheckSource): { checks: Check[]; issues: CheckIssue[] } {
  const checks: Check[] = [];
  const issues: CheckIssue[] = [];
  const issue = (index: number | null, message: string) => issues.push({ source, index, message });
  if (!Array.isArray(raw)) {
    issue(null, 'The "checks" value must be an array.');
    return { checks, issues };
  }
  raw.forEach((item, i) => {
    if (i >= MAX_CHECKS) {
      if (i === MAX_CHECKS) issue(i, `Only the first ${MAX_CHECKS} checks are used; the rest are ignored.`);
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return issue(i, "A check must be an object.");
    const c = item as Record<string, unknown>;
    if (typeof c.command !== "string" || !c.command.trim()) return issue(i, '"command" must be a non-empty string.');
    if (c.command.length > MAX_CHECK_COMMAND) return issue(i, `"command" is longer than ${MAX_CHECK_COMMAND} characters.`);
    if (c.name !== undefined && typeof c.name !== "string") return issue(i, '"name" must be a string.');
    const command = c.command.trim();
    const name = ((c.name as string | undefined) ?? "").trim() || clip(command, 40);
    if (name.length > MAX_CHECK_NAME) return issue(i, `"name" is longer than ${MAX_CHECK_NAME} characters.`);
    let timeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
    if (c.timeoutMs !== undefined) {
      if (!isTimeout(c.timeoutMs)) return issue(i, `"timeoutMs" must be a whole number between ${MIN_CHECK_TIMEOUT_MS} and ${MAX_CHECK_TIMEOUT_MS}.`);
      timeoutMs = c.timeoutMs;
    }
    checks.push({ name, command, timeoutMs, source });
  });
  return { checks, issues };
}

/** Validates the parsed content of `.gustaf/done.json`: `{ "checks": [...], "maxFixAttempts": 2 }`. */
export function validateDoneFile(raw: unknown): DoneFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { checks: [], issues: [{ source: "project", index: null, message: 'The file must be a JSON object with a "checks" array.' }] };
  const f = raw as { checks?: unknown; maxFixAttempts?: unknown };
  const { checks, issues } = validateChecks(f.checks, "project");
  const out: DoneFile = { checks, issues };
  if (f.maxFixAttempts !== undefined) {
    if (isFixAttempts(f.maxFixAttempts)) out.maxFixAttempts = f.maxFixAttempts;
    else issues.push({ source: "project", index: null, message: `"maxFixAttempts" must be a whole number between 0 and ${MAX_FIX_ATTEMPTS}.` });
  }
  return out;
}

/** Removes the `   12|` line numbers `fs_read` puts in front of every line. */
const stripLineNumbers = (text: string) => text.split("\n").map((l) => l.replace(/^\s*\d+\|/, "")).join("\n");

/** Parses the text of the file as read through `fsx.read` (line numbers included or not). */
export function parseDoneText(text: string): DoneFile {
  if (text.length > MAX_DONE_FILE_BYTES) return { checks: [], issues: [{ source: "project", index: null, message: `The file is larger than ${MAX_DONE_FILE_BYTES / 1024} KB and was ignored.` }] };
  try {
    return validateDoneFile(JSON.parse(stripLineNumbers(text)));
  } catch (e) {
    return { checks: [], issues: [{ source: "project", index: null, message: `Invalid JSON: ${clip(String((e as Error)?.message ?? e), 200)}` }] };
  }
}

/** Accepts whatever was stored and returns valid settings (defaults for anything missing or malformed). */
export function normalizeSettings(raw: unknown): VerificationSettings {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { checks } = Array.isArray(v.checks) ? validateChecks(v.checks, "settings") : { checks: [] as Check[] };
  return {
    checks: checks.map(({ name, command, timeoutMs }) => ({ name, command, timeoutMs })),
    maxFixAttempts: isFixAttempts(v.maxFixAttempts) ? v.maxFixAttempts : DEFAULT_FIX_ATTEMPTS,
    useProjectFile: v.useProjectFile === true,
  };
}

/** Settings checks first, then the project file's only when the user switched it on (default off). */
export function effectiveConfig(settings: VerificationSettings, file: DoneFile | null, fileEnabled = settings.useProjectFile): VerificationConfig {
  const own = validateChecks(settings.checks, "settings");
  const useFile = fileEnabled && !!file;
  const checks = [...own.checks, ...(useFile ? file!.checks : [])].slice(0, MAX_CHECKS);
  return {
    checks,
    maxFixAttempts: useFile && file!.maxFixAttempts !== undefined ? file!.maxFixAttempts : settings.maxFixAttempts,
    issues: [...own.issues, ...(file?.issues ?? [])],
  };
}

// ---------- results ----------

export type CheckStatus = "running" | "passed" | "failed" | "timeout" | "denied" | "declined" | "skipped";
export type CheckResult = { name: string; command: string; status: CheckStatus; exitCode: number | null; durationMs: number; output: string };
/** `retry`: failed, sent back to the agent. `failed`: the run ends here as "failed verification". */
export type GateOutcome = "running" | "passed" | "retry" | "failed";
export type GateReason = "max_attempts" | "repeated" | "blocked" | "declined";
export type GateReport = {
  results: CheckResult[];
  /** 1-based number of this gate run in the agent run. */
  attempt: number;
  maxFixAttempts: number;
  outcome: GateOutcome;
  reason?: GateReason;
  /** Set together with reason `repeated`: the UI offers a button that opens the model picker. */
  suggestion?: "another_model";
};

export const GATE_ACTIVITY = "verification";
/** Sent by the "Try another model" button of a verification card; the composer opens its model picker on it. */
export const OPEN_MODEL_PICKER_EVENT = "gustaf-open-model-picker";
export const isFailure = (s: CheckStatus) => s === "failed" || s === "timeout";

/** Reads the report back from a stored activity part (`args.report`); null when it is not a valid one. */
export function readReport(args: unknown): GateReport | null {
  const r = args && typeof args === "object" ? (args as { report?: unknown }).report : null;
  if (!r || typeof r !== "object") return null;
  const g = r as Partial<GateReport>;
  if (!Array.isArray(g.results) || typeof g.attempt !== "number" || !["running", "passed", "retry", "failed"].includes(String(g.outcome))) return null;
  const results = g.results.filter((c): c is CheckResult => !!c && typeof c === "object" && typeof (c as CheckResult).name === "string" && typeof (c as CheckResult).command === "string" && typeof (c as CheckResult).status === "string");
  return { results, attempt: g.attempt, maxFixAttempts: typeof g.maxFixAttempts === "number" ? g.maxFixAttempts : 0, outcome: g.outcome as GateOutcome, ...(g.reason ? { reason: g.reason } : {}), ...(g.suggestion === "another_model" ? { suggestion: "another_model" as const } : {}) };
}

// ---------- output ----------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Keeps the start and (more of) the end of long output, where tools put the summary of failures. */
export function clipOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters omitted …]\n${text.slice(text.length - tail)}`;
}

/** Output as stored and shown: no escape codes, secrets scrubbed, bounded. */
export const cleanOutput = (text: string, max = MAX_CHECK_OUTPUT) => clipOutput(redactSecrets(stripAnsi(text)).trim(), max);

const FAILING_LINE = /\b(error|errors|fail|failed|failure|failing|assert|assertion|not ok|cannot|exception|panicked|fatal)\b|[✗✖×]/i;

/**
 * Identity of a failure for the kill criteria: the check's name plus the first line that looks like a failure (else the
 * first line), lower-cased, with numbers, hex values and timings flattened so shifting line numbers or durations do not
 * make the same failure look new.
 */
export function failureSignature(check: string, output: string, timedOut = false): string {
  if (timedOut) return `${check}::timed out`;
  const lines = stripAnsi(output).split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => FAILING_LINE.test(l)) ?? lines[0] ?? "";
  const norm = line
    .toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/g, "h")
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s|sec|secs)\b/g, "t")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${check}::${norm}`;
}

/** True when the last `n` signatures are all the same. */
export const repeated = (sigs: readonly string[], n = KILL_REPEATS) => sigs.length >= n && sigs.slice(-n).every((s) => s === sigs[sigs.length - 1]);

const seconds = (ms: number) => `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;

/** The user message that sends the failing output back to the agent. */
export function feedbackMessage(failed: CheckResult, attempt: number, max: number): string {
  const how = failed.status === "timeout" ? `timed out after ${seconds(failed.durationMs)}` : `exited with code ${failed.exitCode ?? "unknown"}`;
  const out = cleanOutput(failed.output, MAX_FEEDBACK_OUTPUT);
  return [
    `Verification failed: the required check "${failed.name}" (${failed.command}) ${how}.`,
    out ? `\nOutput:\n${out}` : "\n(The check printed no output.)",
    `\nFix the problem and re-run the check yourself to confirm. The checks run again when you finish (fix attempt ${attempt} of ${max}).`,
  ].join("\n");
}

/** Plain text of a report (the activity part's `output`: what a non-card view and the provider history show). */
export function reportText(r: GateReport): string {
  const passed = r.results.filter((c) => c.status === "passed").length;
  const head =
    r.outcome === "passed" ? `Checks passed (${passed})`
    : r.outcome === "running" ? "Verification running"
    : r.outcome === "retry" ? "Verification failed; sent back to the agent"
    : r.reason === "repeated" ? "Failed verification: the same failure three times in a row"
    : r.reason === "blocked" ? "Failed verification: a check was blocked by command rules"
    : r.reason === "declined" ? "Failed verification: a check was declined"
    : "Failed verification";
  const lines = r.results.map((c) => `${c.status === "passed" ? "ok" : c.status} ${c.name}${c.durationMs ? ` (${seconds(c.durationMs)})` : ""}`);
  const bad = r.results.find((c) => c.status !== "passed" && c.status !== "skipped" && c.output);
  return [head, ...lines, ...(bad && r.outcome !== "passed" ? ["", clipOutput(bad.output, 1500)] : [])].join("\n");
}
