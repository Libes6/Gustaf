// Runs hooks for one agent run (docs/features/hooks.md). Every hook command goes through the same command rules as the
// agent's own run_command (deny rule: not run; "ask": the user is asked like for any other command), is recorded in the
// action log with source "hook", and can never crash the run: all failures are logged and swallowed.
import { hookRunner } from "../lib/api";
import { summarizeCall } from "./actionLog";
import { logFinish, logPatch, logStart } from "./actionLogStore";
import { buildPayload, hookEnv, hookStatus, hooksFor, hookText, postToolAddendum, preToolVerdict, stopFollowUp, type Hook, type HookEvent, type HookExit } from "./hooksCore";
import { askReason, blockedMessage, DEFAULT_RULES, decideCommand, describeRule, type Access } from "./rules";
import { getRulesConfig } from "./rulesStore";

export type HooksHost = {
  hooks: readonly Hook[];
  /** Folder the run works in (hooks run there; a review copy for writable projects). */
  root: string;
  project: string | null;
  chatId?: number;
  access: Access;
  allowlist: string[];
  /** The user's approval prompt for a command that rules say to ask about. */
  approve: (req: { kind: "command"; command: string; reason?: string }) => Promise<unknown>;
  signal: AbortSignal;
};

/** What happened to one hook: it ran (`exit`), or it did not and why. */
export type HookOutcome = { kind: "ran"; exit: HookExit } | { kind: "denied" | "declined" | "skipped" | "failed"; message: string };

// A hook never overlaps with itself: while one run of (folder, event, command) is going, another is skipped and logged.
const running = new Set<string>();

const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export function createHooks(host: HooksHost) {
  const active = host.hooks.length > 0;

  async function runOne(hook: Hook, tool: string | undefined, payload: Parameters<typeof buildPayload>[0]): Promise<HookOutcome> {
    const act = logStart({ tool: "hook", summary: `${hook.event}: ${summarizeCall("run_command", { command: hook.command }, undefined)}`, source: "hook", root: host.root, ...(host.project ? { project: host.project } : {}) });
    const meta = { event: hook.event, command: summarizeCall("run_command", { command: hook.command }), scope: hook.source };
    logPatch(act, { hook: meta });
    const key = `${host.root}\n${hook.event}\n${hook.command}`;
    if (running.has(key)) {
      logFinish(act, "cancelled", "Skipped: the previous run of this hook is still going.");
      return { kind: "skipped", message: "still running" };
    }
    running.add(key);
    try {
      const config = await getRulesConfig().catch(() => DEFAULT_RULES);
      const { action, evaluation } = decideCommand(hook.command, { config, allowlist: host.allowlist, project: host.project }, host.access);
      const rule = evaluation.rule ? describeRule(evaluation.rule) : undefined;
      if (action === "block") {
        const message = blockedMessage(evaluation, host.access);
        logPatch(act, { ...(rule ? { rule } : {}), ...(evaluation.rule?.builtin ? { builtin: true } : {}) });
        logFinish(act, "blocked", message);
        return { kind: "denied", message };
      }
      if (action === "ask") {
        // An approval card may already be open (approval_request hooks run because of it): never stack a second one.
        if (hook.event === "approval_request") {
          logFinish(act, "cancelled", "Not run: this hook command needs approval first.");
          return { kind: "skipped", message: "needs approval" };
        }
        if (!(await host.approve({ kind: "command", command: hook.command, reason: `${askReason(evaluation) ?? "Hook command"} (hook: ${hook.event})` }))) {
          logFinish(act, host.signal.aborted ? "cancelled" : "declined");
          return { kind: "declined", message: "declined" };
        }
        logPatch(act, { approval: "user", ...(rule ? { rule } : {}) });
      } else logPatch(act, evaluation.decision === "allow" ? { approval: "rule", ...(rule ? { rule } : {}) } : { approval: "mode" });
      if (host.signal.aborted) {
        logFinish(act, "cancelled");
        return { kind: "skipped", message: "cancelled" };
      }
      const t0 = Date.now();
      let exit: HookExit;
      try {
        const r = await hookRunner.run(host.root, hook.command, hook.timeoutMs, buildPayload(payload), hookEnv(hook.event, tool, host.project ?? host.root));
        exit = { code: r.code, output: r.output ?? "", timedOut: !!r.timed_out };
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        logFinish(act, "error", message);
        return { kind: "failed", message };
      }
      logPatch(act, { hook: { ...meta, exitCode: exit.code, ...(exit.timedOut ? { timedOut: true } : {}) } });
      const status = hookStatus(hook.event, exit);
      const out = exit.timedOut ? `Timed out after ${Math.round((Date.now() - t0) / 100) / 10} s. ${exit.output}` : exit.output;
      logFinish(act, status, out.trim() ? out : undefined);
      return { kind: "ran", exit };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      logFinish(act, "error", message);
      return { kind: "failed", message };
    } finally {
      running.delete(key);
    }
  }

  const input = (call: { args?: unknown }) => call.args ?? {};

  return {
    active,

    /** pre_tool hooks of a call: `blocked` carries the text for the model when a hook answered with exit 2. */
    async pre(call: { name: string; args?: unknown }): Promise<{ blocked: string } | null> {
      for (const hook of hooksFor(host.hooks, "pre_tool", call.name)) {
        const out = await runOne(hook, call.name, { event: "pre_tool", tool: call.name, input: input(call), root: host.root, project: host.project, chatId: host.chatId });
        if (out.kind !== "ran") continue;
        const v = preToolVerdict(out.exit);
        if (v.blocked) return { blocked: v.message };
      }
      return null;
    },

    /** post_tool (and post_edit after an edit) hooks: the text to append to the tool result. */
    async post(call: { name: string; args?: unknown }, output: string): Promise<string> {
      const events: HookEvent[] = EDIT_TOOLS.has(call.name) ? ["post_tool", "post_edit"] : ["post_tool"];
      let extra = "";
      for (const event of events)
        for (const hook of hooksFor(host.hooks, event, call.name)) {
          const out = await runOne(hook, call.name, { event, tool: call.name, input: input(call), root: host.root, project: host.project, chatId: host.chatId, result: output });
          if (out.kind === "ran") extra += postToolAddendum(hook.command, out.exit);
          else if (out.kind === "denied") extra += `\n\n[hook not run: "${hook.command}" is blocked by command rules]`;
          else if (out.kind === "declined") extra += `\n\n[hook not run: "${hook.command}" was declined]`;
          else if (out.kind === "failed") extra += `\n\n[hook warning: "${hook.command}" could not run: ${hookText(out.message, 300)}]`;
        }
      return extra;
    },

    /** stop hooks: the follow-up user message when one asked the agent to continue (exit 2), else null. */
    async stop(lastText: string): Promise<string | null> {
      for (const hook of hooksFor(host.hooks, "stop")) {
        const out = await runOne(hook, undefined, { event: "stop", root: host.root, project: host.project, chatId: host.chatId, result: lastText });
        if (out.kind !== "ran") continue;
        const f = stopFollowUp(hook.command, out.exit);
        if (f) return f;
      }
      return null;
    },

    /** approval_request hooks: fire and forget (never throws, never waits for the user's answer). */
    approval(tool: string, req: unknown): void {
      for (const hook of hooksFor(host.hooks, "approval_request", tool))
        void runOne(hook, tool, { event: "approval_request", tool, input: req, root: host.root, project: host.project, chatId: host.chatId }).catch(() => {});
    },
  };
}

export type Hooks = ReturnType<typeof createHooks>;

/** The tool name an approval request is matched against. */
export function approvalTool(req: { kind: string; server?: string; tool?: string }): string {
  switch (req.kind) {
    case "command": return "run_command";
    case "mcp": return `mcp__${req.server ?? ""}__${req.tool ?? ""}`;
    case "terminal": return "read_terminal";
    case "memory": return "remember";
    default: return req.kind;
  }
}
