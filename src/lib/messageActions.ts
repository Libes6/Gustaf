// Pure logic behind the per-message actions (edit and resend, regenerate, delete, branch). No UI or storage here.

type MsgLike = { id: number; role: "user" | "assistant" | "tool"; parts: { type: string; text?: string; data?: string }[]; meta?: { compacted?: boolean; checkpoint?: string } };
type TurnLike = { user?: MsgLike; steps: MsgLike[] };

/** Marker the composer appends before `<file>` blocks of expanded `@path` mentions; they are not part of what the user typed. */
const FILE_BLOCKS = "\n\n<file ";

/** What the user typed in a stored message: its text without the appended `<file>` blocks. */
export function editableText(m: MsgLike): string {
  const text = m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
  return text.split(FILE_BLOCKS)[0];
}

/** Base64 data of the images attached to a stored message. */
export function messageImages(m: MsgLike): string[] {
  return m.parts.filter((p) => p.type === "image" && typeof p.data === "string").map((p) => p.data as string);
}

/** Messages that stay when the chat is cut at `id` (the message itself goes too). */
export function messagesBefore<T extends { id: number }>(messages: readonly T[], id: number): T[] {
  return messages.filter((m) => m.id < id);
}

/** Every stored message of a turn (the user message and the assistant/tool steps). */
export function turnMessageIds(turn: TurnLike): number[] {
  return [...(turn.user ? [turn.user.id] : []), ...turn.steps.map((m) => m.id)];
}

/**
 * Id of the last message a branch from `id` must contain, or null if `id` is not in the list. The branch keeps
 * the history up to and including the message; when that message is an assistant step with tool calls, the tool
 * results that answer it are kept too so the copied history stays valid for providers.
 */
export function branchCutoff(messages: readonly MsgLike[], id: number): number | null {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return null;
  let end = i;
  if (messages[i].role === "assistant" && messages[i].parts.some((p) => p.type === "tool_call")) {
    while (messages[end + 1]?.role === "tool") end++;
  }
  return messages[end].id;
}

/** The history a branch from `id` starts with (see `branchCutoff`). */
export function branchSlice<T extends MsgLike>(messages: readonly T[], id: number): T[] {
  const cutoff = branchCutoff(messages, id);
  return cutoff === null ? [] : messages.filter((m) => m.id <= cutoff);
}

export const MAX_TITLE = 120;

/**
 * Title of a branch: `Title (branch)`; branching a branch counts up (`Title (branch 2)`) instead of stacking
 * suffixes. `label` is the localized word. Long titles are shortened in the base, never the suffix.
 */
export function branchTitle(title: string, label: string, max = MAX_TITLE): string {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^(.*) \\(${esc}(?: (\\d+))?\\)$`, "s").exec(title.trim());
  const base = (m ? m[1] : title.trim()) || "";
  const n = m ? (m[2] ? Number(m[2]) + 1 : 2) : 1;
  const suffix = n === 1 ? ` (${label})` : ` (${label} ${n})`;
  const room = Math.max(1, max - suffix.length);
  const head = base.length > room ? `${base.slice(0, Math.max(1, room - 1)).trimEnd()}…` : base;
  return `${head}${suffix}`;
}

export type ActionContext = { busy: boolean; isLastTurn: boolean };
export type TurnActions = { edit: boolean; regenerate: boolean; remove: boolean; branch: boolean };

/**
 * Which per-message actions a turn offers (`show*`) and whether they can be used right now (`enabled`). Compacted
 * summaries and turns without a user message cannot be edited or regenerated; nothing changes while a run is active.
 */
export function turnActions(turn: TurnLike, ctx: ActionContext): { show: TurnActions; enabled: TurnActions } {
  const user = turn.user && !turn.user.meta?.compacted ? turn.user : undefined;
  const assistants = turn.steps.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  const finalIsText = !!last && !last.parts.some((p) => p.type === "tool_call");
  const show: TurnActions = {
    edit: !!user,
    regenerate: !!user && finalIsText && ctx.isLastTurn,
    remove: !turn.user?.meta?.compacted,
    branch: !turn.user?.meta?.compacted,
  };
  const on = !ctx.busy;
  return { show, enabled: { edit: show.edit && on, regenerate: show.regenerate && on, remove: show.remove && on, branch: show.branch && on } };
}
