// Quick ask window: the pure parts (no DOM, Tauri or React imports, so node tests cover them; see tests/quickAsk.test.mjs).
//   - the persisted setting and its normalisation
//   - accelerator recording / validation / display for Settings -> Shortcuts
//   - the exchange state machine of the window (idle -> streaming -> done | error | stopped)
//   - what is sent to the model (clipboard block) and what "Open in Gustaf" stores
//   - which models the window can use (no CLI-native providers: they need the shell plugin, which this window lacks)
import type { Msg, ModelInfo, ProviderConfig, TokenUsage } from "../providers/types.ts";
import type { Platform } from "./platform.ts";

export const QUICK_ASK_SETTING = "quickAsk";

/** The window label; also the capability file `capabilities/quick-ask.json`. */
export const QUICK_ASK_LABEL = "quick-ask";

export const QUICK_ASK_EVENTS = {
  /** Rust -> window: the window was shown, start with a fresh question. */
  shown: "quick-ask:shown",
  /** window -> main: a request finished or failed (token statistics, provider health, usage counter). */
  usage: "quick-ask:usage",
  /** window -> main: a chat holding the exchange was stored, open it. */
  openChat: "quick-ask:open-chat",
} as const;

export type QuickAskSettings = {
  /** Off by default: nothing is registered until the user turns it on. */
  enabled: boolean;
  /** Tauri accelerator (`Control+Alt+Space`); null = the platform default (`DEFAULT_ACCELERATOR`). */
  accelerator: string | null;
  /** Hide the window when it loses focus. */
  hideOnBlur: boolean;
};
export const DEFAULT_QUICK_ASK: QuickAskSettings = { enabled: false, accelerator: null, hideOnBlur: true };

/** Same strings as `default_accelerator_for` in src-tauri/src/quick_ask.rs (tests/quickAsk.test.mjs compares them). */
export const DEFAULT_ACCELERATOR: Record<Platform, string> = {
  macos: "Command+Shift+Alt+Space",
  windows: "Control+Alt+Space",
  linux: "Control+Alt+Space",
};
export const acceleratorOf = (s: QuickAskSettings, p: Platform) => s.accelerator ?? DEFAULT_ACCELERATOR[p];

/** i18n key (see en.json `quickAskErr*`) for an `<code>: <message>` error of `quick_ask_configure`. */
export function quickAskErrorKey(
  message: string,
): "quickAskErrInvalid" | "quickAskErrModifier" | "quickAskErrTaken" | "quickAskErrOther" {
  const code = /^([a-z_]+):/.exec(message)?.[1];
  if (code === "invalid_shortcut") return "quickAskErrInvalid";
  if (code === "needs_modifier") return "quickAskErrModifier";
  if (code === "shortcut_unavailable") return "quickAskErrTaken";
  return "quickAskErrOther";
}

/** Accepts whatever was persisted (possibly missing or corrupt) and returns valid settings. */
export function normalizeQuickAsk(raw: unknown): QuickAskSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accel = typeof r.accelerator === "string" && r.accelerator.trim() ? r.accelerator.trim() : null;
  return { enabled: r.enabled === true, accelerator: accel, hideOnBlur: r.hideOnBlur === false ? false : true };
}

// ---- accelerators ----------------------------------------------------------------------------------------------------

export type KeyEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};
export type AcceleratorError = "modifierOnly" | "needsModifier" | "unsupportedKey" | "reserved" | "conflict";
export type Recorded = { ok: true; accelerator: string } | { ok: false; error: AcceleratorError | "waiting" };

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Backslash: "Backslash",
};

/** Tauri key name for a physical key (`KeyboardEvent.code`), or null when the global-shortcut plugin cannot take it. */
export function keyName(code: string | undefined): string | null {
  if (!code) return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  if (m) return code;
  return NAMED_KEYS[code] ?? null;
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** Modifier names in the canonical order the stored accelerator uses. `Command` is the macOS key, `Super` the Windows/Linux one. */
function modifiersOf(e: KeyEventLike, p: Platform): string[] {
  return [
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && (p === "macos" ? "Command" : "Super"),
  ].filter(Boolean) as string[];
}

/** Keys the OS (or the system menu) owns; registering them would fail or break the desktop. */
const RESERVED: Record<Platform, string[]> = {
  macos: [
    "Command+Space",
    "Command+Tab",
    "Command+Q",
    "Command+W",
    "Command+H",
    "Command+M",
    "Control+Command+Space",
    "Command+Alt+Escape",
    "Command+Shift+Q",
  ],
  windows: [
    "Alt+Tab",
    "Alt+F4",
    "Alt+Space",
    "Control+Alt+Delete",
    "Control+Shift+Escape",
    "Super+L",
    "Super+D",
    "Super+Tab",
  ],
  linux: ["Alt+Tab", "Alt+F4", "Control+Alt+Delete", "Super+L", "Super+D", "Super+Tab"],
};

const ALIASES: Record<string, string> = { ctrl: "control", cmd: "command", option: "alt" };
/** Lower-case parts with aliases resolved (`CommandOrControl` is Command on macOS, Control elsewhere). */
const canonical = (accelerator: string, p: Platform) =>
  accelerator
    .split("+")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) =>
      s === "commandorcontrol" || s === "cmdorctrl" ? (p === "macos" ? "command" : "control") : (ALIASES[s] ?? s),
    );
const sameAccelerator = (a: string, b: string, p: Platform) => {
  const x = canonical(a, p),
    y = canonical(b, p);
  return x.length === y.length && x.every((part) => y.includes(part));
};

/**
 * Validates an accelerator against the rules of this app: a key and at least one non-Shift modifier (a bare key or
 * Shift+letter would hijack typing in every app), not an OS-reserved combination, not the other global shortcut of the app.
 * `taken` lists accelerators of other features (the stop-agent shortcut).
 */
export function validateAccelerator(
  accelerator: string,
  p: Platform,
  taken: readonly string[] = [],
): AcceleratorError | null {
  const parts = accelerator.split("+").map((s) => s.trim());
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!key || /^(Control|Ctrl|Alt|Option|Shift|Command|Cmd|Super)$/i.test(key)) return "modifierOnly";
  if (!mods.some((m) => /^(Control|Ctrl|Alt|Option|Command|Cmd|Super|CommandOrControl|CmdOrCtrl)$/i.test(m)))
    return "needsModifier";
  if (RESERVED[p].some((r) => sameAccelerator(r, accelerator, p))) return "reserved";
  if (taken.some((t) => sameAccelerator(t, accelerator, p))) return "conflict";
  return null;
}

/** Turns the keydown of the recording field into an accelerator, or says why not (`waiting`: only modifiers pressed so far). */
export function recordAccelerator(e: KeyEventLike, p: Platform, taken: readonly string[] = []): Recorded {
  if (MODIFIER_CODES.test(e.code ?? "") || /^(Control|Alt|Shift|Meta|OS)$/.test(e.key))
    return { ok: false, error: "waiting" };
  const key = keyName(e.code);
  if (!key) return { ok: false, error: "unsupportedKey" };
  const accelerator = [...modifiersOf(e, p), key].join("+");
  const error = validateAccelerator(accelerator, p, taken);
  return error ? { ok: false, error } : { ok: true, accelerator };
}

const MAC_SYMBOLS: Record<string, string> = {
  Command: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
  Control: "⌃",
  Ctrl: "⌃",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
};
const WIN_NAMES: Record<string, string> = {
  Command: "Win",
  Cmd: "Win",
  Super: "Win",
  Control: "Ctrl",
  Option: "Alt",
  CommandOrControl: "Ctrl",
  CmdOrCtrl: "Ctrl",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** Text for the settings row: macOS symbols on macOS (`⌘⇧⌥Space`), `Ctrl+Alt+Space` elsewhere. */
export function displayAccelerator(accelerator: string, p: Platform): string {
  const parts = accelerator
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (p === "macos") return parts.map((s) => MAC_SYMBOLS[s] ?? s).join("");
  return parts.map((s) => WIN_NAMES[s] ?? s).join("+");
}

// ---- what is sent ---------------------------------------------------------------------------------------------------

export const QUICK_ASK_SYSTEM =
  "You are the quick-ask assistant of Gustaf, a desktop coding app. The user asked a one-off question from a small floating window. " +
  "You have no tools: you cannot read files, open a project, run commands or use the computer, so do not offer to. " +
  "Answer directly and concisely, in the language of the question, using Markdown (fenced code blocks for code) where it helps.";

/** Clipboard text beyond this is cut (and the user told): it all goes into one request. */
export const MAX_CLIPBOARD_CHARS = 20_000;
/** The preview in the window shows this much of the text that will be sent. */
export const CLIPBOARD_PREVIEW_CHARS = 400;

export type ClipboardText = { text: string; truncated: boolean; chars: number };

export function limitClipboard(raw: string): ClipboardText {
  const text = raw.replace(/\r\n?/g, "\n");
  if (text.length <= MAX_CLIPBOARD_CHARS) return { text, truncated: false, chars: text.length };
  return { text: text.slice(0, MAX_CLIPBOARD_CHARS), truncated: true, chars: text.length };
}

/** First characters of what will be sent, for the preview (never more than that is sent beyond what the preview names). */
export function clipboardPreview(text: string, max = CLIPBOARD_PREVIEW_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** The user message text: the question, then the clipboard text in a fence longer than any backtick run inside it. */
export function buildUserText(question: string, clipboard?: string | null): string {
  const q = question.trim();
  const clip = clipboard?.trim() ? clipboard : "";
  if (!clip) return q;
  const longest = Math.max(0, ...[...clip.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${q}\n\nClipboard text:\n${fence}\n${clip.replace(/\n+$/, "")}\n${fence}`;
}

/** Chat title: the first non-empty line of the question, collapsed and cut at 60 characters. */
export function quickAskTitle(question: string): string {
  const line =
    question
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  if (!line) return "Quick ask";
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
}

// ---- models ---------------------------------------------------------------------------------------------------------

/** Providers that run through a local CLI (shell plugin) need permissions this window does not have. */
export const QUICK_ASK_UNSUPPORTED_KINDS: readonly string[] = ["cli", "cursor"];

export type Selection = { providerId: string; model: string };
type ModelLike = Pick<ModelInfo, "id" | "name" | "providerId">;
const key = (m: { providerId: string; id: string }) => `${m.providerId}\n${m.id}`;

/** Models the window offers: enabled API providers, not hidden by the user. */
export function usableModels<M extends ModelLike>(
  providers: readonly ProviderConfig[],
  models: readonly M[],
  hidden: readonly string[] = [],
): M[] {
  const ok = new Set(
    providers.filter((p) => !p.disabled && !QUICK_ASK_UNSUPPORTED_KINDS.includes(p.kind)).map((p) => p.id),
  );
  return models.filter((m) => ok.has(m.providerId) && !hidden.includes(key(m)));
}

/** The default model (the app's selection) when the window can use it, else the first usable one; `fellBack` says which. */
export function pickDefaultModel<M extends ModelLike>(
  selection: Selection | null,
  usable: readonly M[],
): { model: M | null; fellBack: boolean } {
  const chosen = selection && usable.find((m) => m.providerId === selection.providerId && m.id === selection.model);
  if (chosen) return { model: chosen, fellBack: false };
  return { model: usable[0] ?? null, fellBack: !!selection };
}

// ---- exchange state machine -----------------------------------------------------------------------------------------

export type Phase = "idle" | "streaming" | "done" | "error" | "stopped";
export type QuickAskState = {
  phase: Phase;
  /** The question as typed (without the clipboard block). */
  question: string;
  /** The exact user message sent (question plus the clipboard block). */
  sent: string;
  answer: string;
  error: string | null;
  model: Selection | null;
  usage?: TokenUsage;
};
export const INITIAL_QUICK_ASK: QuickAskState = {
  phase: "idle",
  question: "",
  sent: "",
  answer: "",
  error: null,
  model: null,
};

export type QuickAskAction =
  | { type: "send"; question: string; clipboard?: string | null; model: Selection }
  | { type: "delta"; text: string }
  | { type: "finish"; usage?: TokenUsage }
  | { type: "fail"; message: string }
  | { type: "stop" }
  | { type: "reset" };

/** idle -> streaming -> done | error | stopped. Events that arrive in any other phase (a late chunk after Stop) are ignored. */
export function quickAskReducer(s: QuickAskState, a: QuickAskAction): QuickAskState {
  switch (a.type) {
    case "send":
      if (s.phase === "streaming" || !a.question.trim()) return s;
      return {
        phase: "streaming",
        question: a.question.trim(),
        sent: buildUserText(a.question, a.clipboard),
        answer: "",
        error: null,
        model: a.model,
      };
    case "delta":
      return s.phase === "streaming" ? { ...s, answer: s.answer + a.text } : s;
    case "finish":
      return s.phase === "streaming" ? { ...s, phase: "done", usage: a.usage } : s;
    case "fail":
      return s.phase === "streaming" ? { ...s, phase: "error", error: a.message } : s;
    case "stop":
      return s.phase === "streaming" ? { ...s, phase: "stopped" } : s;
    case "reset":
      return INITIAL_QUICK_ASK;
  }
}

/** Copy and "Open in Gustaf" need a settled exchange with an answer (a stopped one keeps what arrived). */
export const canKeep = (s: QuickAskState) =>
  (s.phase === "done" || s.phase === "stopped") && !!s.answer.trim() && !!s.model;

export type ChatPayload = { title: string; messages: Msg[] };

/** What "Open in Gustaf" stores: a normal chat (no project) holding the user message exactly as sent and the answer. */
export function buildChatPayload(s: QuickAskState): ChatPayload | null {
  if (!canKeep(s) || !s.model) return null;
  const meta = { provider: s.model.providerId, model: s.model.model };
  return {
    title: quickAskTitle(s.question),
    messages: [
      { role: "user", parts: [{ type: "text", text: s.sent }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: s.answer }],
        meta: { ...meta, ...(s.usage ? { usage: s.usage } : {}) },
      },
    ],
  };
}

export type UsageEvent = { providerId: string; model: string; usage?: TokenUsage; error?: string };
export type OpenChatEvent = { chatId: number };
