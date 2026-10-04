// Runs the verification gate of one agent run (docs/features/verification-gates.md): the project's required checks, one
// gate cycle each time the agent stops after editing files. Every check goes through the same command rules and
// approval path as `run_command` (`decideCommand`: deny means it is not run and is reported, ask means the normal
// approval card), runs in the run's folder (a review copy or workspace worktree for the runs that use one), and is
// recorded in the action log with source "gate". Gate commands never go through hooks. Nothing here throws.
import { fsx } from "../lib/api";
import type { Part } from "../providers/types";
import { summarizeCall } from "./actionLog";
import { logFinish, logPatch, logStart } from "./actionLogStore";
import { askReason, blockedMessage, DEFAULT_RULES, decideCommand, describeRule, type Access } from "./rules";
import { getRulesConfig } from "./rulesStore";
import { cleanOutput, failureSignature, feedbackMessage, GATE_ACTIVITY, isFailure, reportText, repeated, type Check, type CheckResult, type GateReport, type VerificationConfig } from "./verificationCore";

export type GateHost = {
  config: VerificationConfig;
  /** Folder the run works in: the checks run here. */
  root: string;
  /** Scope of the command rules (the run's project folder). */
  project: string | null;
  access: Access;
  allowlist: string[];
  /** The user's approval prompt for a command that rules say to ask about. */
  approve: (req: { kind: "command"; command: string; reason?: string }) => Promise<unknown>;
  signal: AbortSignal;
  /** Live state of the running gate (the same activity part that is stored at the end). */
  onProgress?: (part: Extract<Part, { type: "activity" }>) => void;
};

type Activity = Extract<Part, { type: "activity" }>;
export type GateRun = {
  /** The card to store with the agent's last message. */
  part: Activity;
  report: GateReport;
  /** The user message that sends the failure back to the agent, when it should continue. */
  feedback: string | null;
};

let counter = 0;

const activity = (id: string, report: GateReport): Activity => ({
  type: "activity",
  id,
  name: GATE_ACTIVITY,
  args: { report },
  status: report.outcome === "running" ? "running" : report.outcome === "passed" ? "success" : "error",
  output: reportText(report),
});

export function createGate(host: GateHost) {
  const checks = host.config.checks;
  const active = checks.length > 0;
  const max = host.config.maxFixAttempts;
  let dirty = false;
  let halted = false;
  let fixes = 0;
  let runs = 0;
  let sigs: string[] = [];

  async function runCheck(check: Check, attempt: number): Promise<CheckResult> {
    const result = (status: CheckResult["status"], extra: Partial<CheckResult> = {}): CheckResult => ({ name: check.name, command: check.command, status, exitCode: null, durationMs: 0, output: "", ...extra });
    const act = logStart({ tool: "gate", summary: `${check.name}: ${summarizeCall("run_command", { command: check.command })}`, source: "gate", root: host.root, ...(host.project ? { project: host.project } : {}) });
    const meta = { check: check.name, command: summarizeCall("run_command", { command: check.command }), attempt };
    logPatch(act, { gate: meta });
    try {
      const config = await getRulesConfig().catch(() => DEFAULT_RULES);
      const { action, evaluation } = decideCommand(check.command, { config, allowlist: host.allowlist, project: host.project }, host.access);
      const rule = evaluation.rule ? describeRule(evaluation.rule) : undefined;
      if (action === "block") {
        const message = blockedMessage(evaluation, host.access);
        logPatch(act, { ...(rule ? { rule } : {}), ...(evaluation.rule?.builtin ? { builtin: true } : {}) });
        logFinish(act, "blocked", message);
        return result("denied", { output: message });
      }
      if (action === "ask") {
        if (!(await host.approve({ kind: "command", command: check.command, reason: `${askReason(evaluation) ?? "Verification check"} (verification: ${check.name})` }))) {
          logFinish(act, host.signal.aborted ? "cancelled" : "declined");
          return result(host.signal.aborted ? "skipped" : "declined");
        }
        logPatch(act, { approval: "user", ...(rule ? { rule } : {}) });
      } else logPatch(act, evaluation.decision === "allow" ? { approval: "rule", ...(rule ? { rule } : {}) } : { approval: "mode" });
      if (host.signal.aborted) {
        logFinish(act, "cancelled");
        return result("skipped");
      }
      const t0 = Date.now();
      let r: { code: number | null; output: string; timed_out: boolean };
      try {
        r = await fsx.run(host.root, check.command, check.timeoutMs);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        logFinish(act, "error", message);
        return result("failed", { durationMs: Date.now() - t0, output: cleanOutput(message) });
      }
      const durationMs = Date.now() - t0;
      const timedOut = !!r.timed_out;
      const status = timedOut ? "timeout" : r.code === 0 ? "passed" : "failed";
      logPatch(act, { gate: { ...meta, exitCode: r.code, ...(timedOut ? { timedOut: true } : {}) } });
      const output = cleanOutput(r.output ?? "");
      logFinish(act, status === "passed" ? "success" : "error", timedOut ? `Timed out after ${Math.round(durationMs / 100) / 10} s. ${output}` : output || undefined);
      return result(status, { exitCode: r.code, durationMs, output });
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      logFinish(act, "error", message);
      return result("failed", { output: cleanOutput(message) });
    }
  }

  return {
    active,

    /** The agent edited a file (edit_file / write_file succeeded): the next stop needs a gate. */
    noteEdit() {
      dirty = true;
    },

    /** True when a gate cycle is due: checks exist, files were edited since the last pass, and the gate was not halted. */
    pending(): boolean {
      return active && dirty && !halted && !host.signal.aborted;
    },

    /** One gate cycle (all checks in order, stopping at the first one that does not pass). */
    async run(): Promise<GateRun> {
      const attempt = ++runs;
      const id = `gate-${Date.now().toString(36)}-${counter++}`;
      const results: CheckResult[] = checks.map((c) => ({ name: c.name, command: c.command, status: "skipped", exitCode: null, durationMs: 0, output: "" }));
      const report = (outcome: GateReport["outcome"], extra: Partial<GateReport> = {}): GateReport => ({ results: results.map((r) => ({ ...r })), attempt, maxFixAttempts: max, outcome, ...extra });
      const progress = () => host.onProgress?.(activity(id, report("running")));
      for (let i = 0; i < checks.length; i++) {
        if (host.signal.aborted) break;
        results[i] = { ...results[i], status: "running" };
        progress();
        results[i] = await runCheck(checks[i], attempt);
        progress();
        if (results[i].status !== "passed") break;
      }
      const bad = results.find((r) => r.status !== "passed" && r.status !== "skipped");
      const done = (r: GateReport, feedback: string | null = null): GateRun => ({ part: activity(id, r), report: r, feedback });
      if (!bad) {
        if (host.signal.aborted && results.some((r) => r.status === "skipped")) return done(report("failed"));
        dirty = false;
        fixes = 0;
        sigs = [];
        return done(report("passed"));
      }
      if (bad.status === "denied" || bad.status === "declined") {
        // A blocked or declined check cannot be fixed by editing code and would be asked again every time: stop here.
        halted = true;
        return done(report("failed", { reason: bad.status === "denied" ? "blocked" : "declined" }));
      }
      if (!isFailure(bad.status)) return done(report("failed")); // cancelled
      sigs.push(failureSignature(bad.name, bad.output, bad.status === "timeout"));
      if (repeated(sigs)) {
        halted = true;
        return done(report("failed", { reason: "repeated", suggestion: "another_model" }));
      }
      if (fixes >= max) {
        halted = true;
        return done(report("failed", { reason: "max_attempts" }));
      }
      fixes++;
      return done(report("retry"), feedbackMessage(bad, fixes, max));
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
