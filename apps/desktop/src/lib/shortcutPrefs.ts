import { useMemo, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "./api";
import { effectiveShortcuts, getShortcutOverrides, setShortcutOverrides, shortcutsVersion, subscribeShortcuts, type Shortcut, type ShortcutId } from "./shortcuts";

/** App setting holding the user's key bindings: `{ [shortcutId]: "Cmd+Shift+K" }` (only the ones that differ from the default). */
export const SHORTCUT_SETTING = "shortcutBindings";

/** Reads the saved bindings into lib/shortcuts.ts (call once at startup). */
export async function loadShortcutBindings() {
  try {
    setShortcutOverrides(await getSetting<unknown>(SHORTCUT_SETTING, {}));
  } catch {
    setShortcutOverrides({});
  }
}

/** Rebinds one shortcut (`combo` null = back to the default) and saves. The caller validates with `validateBinding` first. */
export async function saveShortcutBinding(id: ShortcutId, combo: string | null) {
  const next = { ...getShortcutOverrides() };
  if (combo) next[id] = combo;
  else delete next[id];
  setShortcutOverrides(next);
  await setSetting(SHORTCUT_SETTING, getShortcutOverrides());
}

export async function resetShortcutBindings() {
  setShortcutOverrides({});
  await setSetting(SHORTCUT_SETTING, {});
}

/** The shortcut list with the user's bindings; re-renders when one changes. */
export function useShortcuts(): Shortcut[] {
  const v = useSyncExternalStore(subscribeShortcuts, shortcutsVersion);
  return useMemo(() => effectiveShortcuts(), [v]);
}
