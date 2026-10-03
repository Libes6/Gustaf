// Pure Computer Use logic shared by the agent loop, the provider bridges and the approval UI: risk classification,
// result summaries, `open_app` validation and which screenshot a CLI replay keeps. No Tauri or React imports, so it is
// unit-tested in tests/computerCore.test.mjs.
import type { CuAction, Shot } from "../lib/api";
import type { Msg } from "../providers/types";

/** Why `name` cannot be passed to `open -a`, or null when it is a plain app name. Mirrors `valid_app_name` in computer.rs. */
export function appNameError(name: unknown): string | null {
  if (typeof name !== "string") return "open_app requires an application name.";
  const n = name.trim();
  if (!n) return "open_app requires an application name.";
  if ([...n].length > 80) return "Application name is too long.";
  if (/^[-.~]/.test(n) || /[/\\:]/.test(n) || /[\u0000-\u001f\u007f]/.test(n)) return "Use the application's name, not a path or option.";
  return null;
}

const ENTER = /^(enter|return|kp_?enter)$/i;
const CMD = /^(cmd|command|meta|super)$/i;
const DESTRUCTIVE = /^(q|w|delete|del|backspace)$/i;
/** Actions that do not change what the next key press applies to. */
const NEUTRAL = new Set(["screenshot", "wait", "move"]);

/** True when the batch's last effective action is typing, so an Enter in the next batch would submit it. */
export function endsWithTyping(actions: readonly CuAction[], before = false): boolean {
  let typed = before;
  for (const a of actions) if (!NEUTRAL.has(a.type)) typed = a.type === "type";
  return typed;
}

export type RiskCode = "newline" | "enterAfterTyping" | "destructiveShortcut";
/**
 * The likely-irreversible step in a batch, or null. Used in Full access, where ordinary clicks and typing run without
 * asking: Return/Enter after typing (in this batch or right after the previous one) can send a message or submit a
 * form; cmd+Q/W/Delete/Backspace quit, close or delete; typed text with a line break submits like Enter.
 */
export function riskyStep(actions: readonly CuAction[], afterTyping = false): RiskCode | null {
  let typed = afterTyping;
  for (const a of actions) {
    if (a.type === "type") {
      if (/[\r\n]/.test(a.text)) return "newline";
      typed = true;
    } else if (a.type === "keypress") {
      const keys = a.keys ?? [];
      if (keys.some((k) => ENTER.test(k)) && typed) return "enterAfterTyping";
      if (keys.some((k) => CMD.test(k)) && keys.some((k) => DESTRUCTIVE.test(k))) return "destructiveShortcut";
    }
  }
  return null;
}

export type ComputerDecision = { ask: boolean; reason?: RiskCode; /** The card may offer "Allow for this task". */ allowTask: boolean };

/**
 * Whether a computer batch needs the user's confirmation. Screenshots never do. Provider safety checks always do. Outside
 * Full access every other batch asks (the existing behaviour). In Full access only risky steps ask, unless the user chose
 * "Allow for this task" earlier in the same run.
 */
export function computerApproval(o: { actions: readonly CuAction[]; access: string; safety?: readonly string[]; afterTyping?: boolean; taskAllowed?: boolean }): ComputerDecision {
  if (o.actions.every((a) => a.type === "screenshot")) return { ask: false, allowTask: false };
  if (o.safety?.length) return { ask: true, allowTask: false };
  if (o.access !== "full") return { ask: true, allowTask: false };
  if (o.taskAllowed) return { ask: false, allowTask: false };
  const reason = riskyStep(o.actions, o.afterTyping);
  return reason ? { ask: true, reason, allowTask: true } : { ask: false, allowTask: false };
}

export type ShotFacts = Partial<Pick<Shot, "frontApp" | "windowTitle" | "cursor" | "changed" | "settled" | "failedStep" | "error">>;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Short factual tool result for a computer batch, e.g. `Executed 3 actions. Front app: Telegram — "Екатерина". Screen
 * changed: yes.` On failure it names the failed step (1-based) and the error. Window titles are page content: untrusted.
 */
export function formatComputerResult(actions: readonly CuAction[], f: ShotFacts): string {
  const n = actions.length;
  const acting = actions.some((a) => a.type !== "screenshot");
  const out: string[] = [];
  if (typeof f.failedStep === "number") {
    const i = f.failedStep;
    const kind = actions[i]?.type ?? "action";
    out.push(`Step ${i + 1} of ${n} (${kind}) failed: ${clip(String(f.error ?? "unknown error").replace(/\s+/g, " ").trim().replace(/\.$/, ""), 300)}.`);
    out.push(i ? `${plural(i, "earlier step")} ran; later steps were not executed.` : "No steps ran.");
  } else if (f.error) out.push(`Failed: ${clip(f.error, 300)}.`);
  else out.push(acting ? `Executed ${plural(n, "action")}.` : "Screenshot taken.");
  if (f.frontApp) out.push(`Front app: ${clip(f.frontApp, 80)}${f.windowTitle ? ` — "${clip(f.windowTitle, 120)}"` : ""}.`);
  if (f.cursor) out.push(`Cursor: ${f.cursor[0]},${f.cursor[1]}.`);
  if (acting && typeof f.changed === "boolean") out.push(`Screen changed: ${f.changed ? "yes" : "no"}.`);
  if (acting && f.settled === false) out.push("The screen was still changing when captured.");
  return out.join(" ");
}

/**
 * The newest screenshot in a desktop history, as [message index, part index], or null. CLI replays attach only this one:
 * older screenshots would grow every prompt and resumed sessions already saw them.
 */
export function newestScreenshot(messages: readonly Msg[]): [number, number] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "tool_result" && p.image) return [i, j];
    }
  }
  return null;
}
