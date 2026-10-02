// Central map of the app's keyboard shortcuts (pure: no DOM/Tauri/React imports, so node tests can cover it).
// App.tsx matches window keydown events against `combo`; the settings list renders `display`.
//   scope "app"      - handled in App.tsx while the window is focused
//   scope "global"   - registered through the global-shortcut plugin (works when the window is unfocused)
//   scope "composer" - handled by the message box itself; listed here for the settings screen and conflict checks only
// Rule: app and global shortcuts need Cmd (or are Escape), so they never collide with typing/editing in the composer.

export type ShortcutScope = "app" | "global" | "composer";
export type ShortcutId = "settings" | "newChat" | "search" | "closeSettings" | "stopAgent" | "send" | "newLine" | "pickModel";

export type Shortcut = {
  id: ShortcutId;
  /** Key of the i18n dictionary for the description. */
  label: "settings" | "newChat" | "searchChats" | "closeSettings" | "stopAgent" | "send" | "newLine" | "pickModel";
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
  { id: "search", label: "searchChats", combo: "Cmd+K", display: "⌘K", scope: "app" },
  { id: "closeSettings", label: "closeSettings", combo: "Escape", display: "Esc", scope: "app" },
  { id: "stopAgent", label: "stopAgent", combo: "Cmd+Shift+Escape", display: "⌘⇧Esc", scope: "global", accelerator: "CommandOrControl+Shift+Escape" },
  { id: "send", label: "send", combo: "Enter", display: "↵", scope: "composer" },
  { id: "newLine", label: "newLine", combo: "Shift+Enter", display: "⇧↵", scope: "composer" },
  { id: "pickModel", label: "pickModel", combo: "Cmd+1-9", display: "⌘1–9", scope: "composer" },
];

export const shortcut = (id: ShortcutId): Shortcut => SHORTCUTS.find((s) => s.id === id)!;

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
export function matchesCombo(e: KeyLike, combo: string): boolean {
  const p = parseCombo(combo);
  if (e.metaKey !== p.cmd || e.shiftKey !== p.shift || e.altKey !== p.alt || e.ctrlKey !== p.ctrl) return false;
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
