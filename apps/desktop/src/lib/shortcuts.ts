// Central map of the app's keyboard shortcuts (pure: no DOM/Tauri/React imports, so node tests can cover it).
// App.tsx matches window keydown events against `combo`; the settings list renders `display`.
//   scope "app"      - handled in App.tsx while the window is focused
//   scope "global"   - registered through the global-shortcut plugin (works when the window is unfocused)
//   scope "composer" - handled by the message box itself; listed here for the settings screen and conflict checks only
// Rule: app and global shortcuts need Cmd (or are Escape), so they never collide with typing/editing in the composer.

import { displayKeys, type Platform } from "./platform.ts";

// "Cmd" in a combo is the platform's main shortcut key: Command (metaKey) on macOS, Ctrl elsewhere.
// The platform is set once at startup (main.tsx); it defaults to macOS so the pure logic does not depend on the host running the tests.
let platform: Platform = "macos";
export function setShortcutPlatform(p: Platform) {
  platform = p;
}

/** True when the event carries the platform's main shortcut modifier (Command on macOS, Ctrl elsewhere) and not the other one. */
export const cmdKey = (e: { metaKey: boolean; ctrlKey?: boolean }, p: Platform = platform) => (p === "macos" ? e.metaKey : !!e.ctrlKey && !e.metaKey);

export type ShortcutScope = "app" | "global" | "composer";
export type ShortcutId = "settings" | "newChat" | "newScratchChat" | "chatBack" | "chatForward" | "sendNewChat" | "followUpOpposite" | "turnPrev" | "turnNext" | "search" | "closeSettings" | "stopAgent" | "send" | "newLine" | "pickModel";

export type Shortcut = {
  id: ShortcutId;
  /** Key of the i18n dictionary for the description. */
  label: "settings" | "newChat" | "newScratchChat" | "chatBack" | "chatForward" | "sendNewChat" | "followUpOpposite" | "turnPrev" | "turnNext" | "searchChats" | "closeSettings" | "stopAgent" | "send" | "newLine" | "pickModel";
  /** `Cmd+Shift+N` style: modifiers (Cmd, Shift, Alt, Ctrl) then a key name as in KeyboardEvent.key. `1-9` is a digit range. */
  combo: string;
  /** Shown in the settings list. */
  display: string;
  scope: ShortcutScope;
  /** Tauri accelerator, only for scope "global". */
  accelerator?: string;
};

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "settings", label: "settings", combo: "Cmd+,", display: "⌘,", scope: "app" },
  { id: "newChat", label: "newChat", combo: "Cmd+N", display: "⌘N", scope: "app" },
  { id: "newScratchChat", label: "newScratchChat", combo: "Cmd+Alt+N", display: "⌘⌥N", scope: "app" },
  { id: "chatBack", label: "chatBack", combo: "Cmd+[", display: "⌘[", scope: "app" },
  { id: "chatForward", label: "chatForward", combo: "Cmd+]", display: "⌘]", scope: "app" },
  { id: "turnPrev", label: "turnPrev", combo: "Cmd+Alt+ArrowUp", display: "⌘⌥↑", scope: "app" },
  { id: "turnNext", label: "turnNext", combo: "Cmd+Alt+ArrowDown", display: "⌘⌥↓", scope: "app" },
  { id: "sendNewChat", label: "sendNewChat", combo: "Cmd+Alt+Enter", display: "⌘⌥↵", scope: "composer" },
  { id: "followUpOpposite", label: "followUpOpposite", combo: "Cmd+Enter", display: "⌘↵", scope: "composer" },
  { id: "search", label: "searchChats", combo: "Cmd+K", display: "⌘K", scope: "app" },
  { id: "closeSettings", label: "closeSettings", combo: "Escape", display: "Esc", scope: "app" },
  { id: "stopAgent", label: "stopAgent", combo: "Cmd+Shift+Escape", display: "⌘⇧Esc", scope: "global", accelerator: "CommandOrControl+Shift+Escape" },
  { id: "send", label: "send", combo: "Enter", display: "↵", scope: "composer" },
  { id: "newLine", label: "newLine", combo: "Shift+Enter", display: "⇧↵", scope: "composer" },
  { id: "pickModel", label: "pickModel", combo: "Cmd+1-9", display: "⌘1–9", scope: "composer" },
];

/** Shortcuts the user may rebind: the ones App.tsx / ChatView match through `matches()`. The message box keys and the global stop shortcut stay fixed. */
export const EDITABLE_SHORTCUTS: readonly ShortcutId[] = ["settings", "newChat", "newScratchChat", "chatBack", "chatForward", "turnPrev", "turnNext", "search", "followUpOpposite"];

let overrides: Partial<Record<ShortcutId, string>> = {};
let version = 0;
const listeners = new Set<() => void>();

/** The user's bindings by shortcut id (only editable ids with valid combos survive). */
export const getShortcutOverrides = () => overrides;
export const shortcutsVersion = () => version;
export function subscribeShortcuts(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Replaces the user's bindings. Unknown ids, fixed shortcuts and combos that fail `validateBinding` are dropped (a stale or hand-edited setting cannot break the keyboard). */
export function setShortcutOverrides(raw: unknown) {
  let next: Partial<Record<ShortcutId, string>> = {};
  if (raw && typeof raw === "object") {
    for (const [id, combo] of Object.entries(raw as Record<string, unknown>)) {
      if (!EDITABLE_SHORTCUTS.includes(id as ShortcutId) || typeof combo !== "string") continue;
      if (combo !== SHORTCUTS.find((s) => s.id === id)!.combo) next[id as ShortcutId] = combo;
    }
    // Each binding is checked against all the others (so swapping two shortcuts stays valid); drop offenders until stable.
    for (let changed = true; changed;) {
      changed = false;
      const applied = SHORTCUTS.map((s) => (next[s.id] ? { ...s, combo: next[s.id]! } : s));
      for (const id of Object.keys(next) as ShortcutId[]) {
        if (!validateBinding(id, next[id]!, applied).ok) { const { [id]: _drop, ...rest } = next; next = rest; changed = true; break; }
      }
    }
  }
  overrides = next;
  version++;
  listeners.forEach((fn) => fn());
}

/** Text of a combo with the macOS symbols (what `Shortcut.display` holds), e.g. `Cmd+Shift+K` -> `⌘⇧K`. */
export function displayOfCombo(combo: string): string {
  const p = parseCombo(combo);
  const names: Record<string, string> = { Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Backspace: "⌫", Delete: "⌦", Tab: "⇥" };
  const key = names[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key);
  return `${p.cmd ? "⌘" : ""}${p.ctrl ? "⌃" : ""}${p.shift ? "⇧" : ""}${p.alt ? "⌥" : ""}${key}`;
}

/** The shortcut as it is bound now (the user's combo replaces the default). */
function effective(s: Shortcut): Shortcut {
  const combo = overrides[s.id];
  return combo ? { ...s, combo, display: displayOfCombo(combo) } : s;
}
export const effectiveShortcuts = (): Shortcut[] => SHORTCUTS.map(effective);
export const shortcut = (id: ShortcutId): Shortcut => effective(SHORTCUTS.find((s) => s.id === id)!);
export const isCustomized = (id: ShortcutId) => !!overrides[id];

/** Where a shortcut is active, for conflict messages: everywhere in the app, or only in the message box / model picker. */
export const shortcutContext = (s: Shortcut): "app" | "global" | "composer" => s.scope;

export type BindingError = "needsCmd" | "reserved" | "unsupported" | "conflict";
export type BindingCheck = { ok: true } | { ok: false; error: BindingError; with?: ShortcutId };

/** System keys the app must not take over (quit, close window, minimize, hide). */
const RESERVED_SYSTEM_COMBOS: readonly string[] = ["Cmd+Q", "Cmd+W", "Cmd+M", "Cmd+H"];

/**
 * Whether `combo` may be bound to `id`. App shortcuts must include Cmd (never a bare or Shift-only key, which the message
 * box needs for typing), must not take the editing keys (copy, paste, undo, ...) or system keys, and must not fire on the
 * same key press as another shortcut. App and global shortcuts fire everywhere, so they also collide with message-box keys.
 */
export function validateBinding(id: ShortcutId, combo: string, list: readonly Shortcut[] = effectiveShortcuts()): BindingCheck {
  if (!EDITABLE_SHORTCUTS.includes(id)) return { ok: false, error: "unsupported" };
  const p = parseCombo(combo);
  if (!p.key || p.key === "1-9" || !p.cmd) return { ok: false, error: p.cmd ? "unsupported" : "needsCmd" };
  const mine = expand(combo);
  if ([...RESERVED_EDIT_COMBOS, ...RESERVED_SYSTEM_COMBOS].some((r) => expand(r).some((c) => mine.includes(c)))) return { ok: false, error: "reserved" };
  const other = list.find((s) => s.id !== id && expand(s.combo).some((c) => mine.includes(c)));
  return other ? { ok: false, error: "conflict", with: other.id } : { ok: true };
}

/** Combo string for a key press while recording; null for a lone modifier key (keep waiting), "" for a key that cannot be bound. Letters use the physical key so layouts do not matter. */
export function comboFromEvent(e: KeyLike, plat: Platform = platform): string | null {
  if (["Meta", "Control", "Shift", "Alt", "AltGraph", "OS"].includes(e.key)) return null;
  const mac = plat === "macos";
  // Cmd is Command on macOS and Ctrl elsewhere; the other modifier of the pair cannot be expressed.
  if (mac ? e.ctrlKey : e.metaKey) return "";
  const cmd = mac ? e.metaKey : e.ctrlKey;
  let key = e.key;
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (key.length === 1) key = key.toUpperCase();
  if (key === " " || key === "Dead" || key === "Unidentified") return "";
  return [cmd && "Cmd", e.shiftKey && "Shift", e.altKey && "Alt", key].filter(Boolean).join("+");
}

/** Text shown for a shortcut: macOS symbols on macOS, `Ctrl+...` elsewhere (Windows reserves Ctrl+Shift+Esc for Task Manager, so the global one differs there). */
export function shortcutDisplay(s: Shortcut, p: Platform = platform): string {
  if (p === "windows" && s.id === "stopAgent") return "Ctrl+Alt+Shift+Esc";
  return displayKeys(s.display, p);
}

/** Tauri accelerator of a global shortcut for the platform. */
export function acceleratorOf(id: ShortcutId, p: Platform = platform): string {
  if (p === "windows" && id === "stopAgent") return "Control+Alt+Shift+Escape";
  return shortcut(id).accelerator!;
}

export type KeyLike = { key: string; code?: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean };

type Parsed = { cmd: boolean; shift: boolean; alt: boolean; ctrl: boolean; key: string };

export function parseCombo(combo: string): Parsed {
  const parts = combo.split("+");
  // a literal "+" key would end in an empty part; no shortcut uses it
  const key = parts.pop() ?? "";
  const has = (m: string) => parts.includes(m);
  return { cmd: has("Cmd"), shift: has("Shift"), alt: has("Alt"), ctrl: has("Ctrl"), key };
}

/** True when the keyboard event is exactly this combo (extra modifiers do not match). */
export function matchesCombo(e: KeyLike, combo: string, plat: Platform = platform): boolean {
  const p = parseCombo(combo);
  const mac = plat === "macos";
  const wantMeta = p.cmd && mac;
  const wantCtrl = p.ctrl || (p.cmd && !mac);
  if (e.metaKey !== wantMeta || e.shiftKey !== p.shift || e.altKey !== p.alt || e.ctrlKey !== wantCtrl) return false;
  const key = e.key.toLowerCase();
  if (p.key === "1-9") return /^[1-9]$/.test(key);
  if (p.key.length === 1 && /[a-z]/i.test(p.key)) return key === p.key.toLowerCase() || e.code === `Key${p.key.toUpperCase()}`;
  return key === p.key.toLowerCase();
}

export const matches = (e: KeyLike, id: ShortcutId) => matchesCombo(e, shortcut(id).combo);

/** Canonical expansion so that `Cmd+1-9` is compared digit by digit. */
function expand(combo: string): string[] {
  const p = parseCombo(combo);
  const mods = [p.cmd && "Cmd", p.shift && "Shift", p.alt && "Alt", p.ctrl && "Ctrl"].filter(Boolean).join("+");
  const keys = p.key === "1-9" ? "123456789".split("") : [p.key.toLowerCase()];
  return keys.map((k) => `${mods}+${k}`);
}

/** Pairs of shortcut ids that would fire on the same key press (empty when the map is consistent). */
export function findConflicts(list: readonly Shortcut[] = SHORTCUTS): [ShortcutId, ShortcutId][] {
  const out: [ShortcutId, ShortcutId][] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const b = new Set(expand(list[j].combo));
      if (expand(list[i].combo).some((c) => b.has(c))) out.push([list[i].id, list[j].id]);
    }
  return out;
}

/** Keys the composer (a text field) uses for editing; app/global shortcuts must not take them over. */
export const RESERVED_EDIT_COMBOS: readonly string[] = ["Cmd+A", "Cmd+C", "Cmd+V", "Cmd+X", "Cmd+Z", "Cmd+Shift+Z", "Cmd+Backspace", "Cmd+ArrowLeft", "Cmd+ArrowRight", "Cmd+B", "Cmd+I"];

export function isTextEditingSafe(s: Shortcut): boolean {
  if (s.scope === "composer") return true;
  const p = parseCombo(s.combo);
  if (!p.cmd && p.key !== "Escape") return false;
  return !RESERVED_EDIT_COMBOS.some((r) => expand(r).some((c) => expand(s.combo).includes(c)));
}
