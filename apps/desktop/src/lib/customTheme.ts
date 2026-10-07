// DOM and storage side of custom themes. The list lives in the app setting "customThemes", the active one in
// "customThemeId" (empty = built-in colours). The active theme's palette for the resolved light/dark mode is applied
// as inline CSS variables on <html>; a localStorage copy lets the first paint use it synchronously.
import { getSetting, setSetting } from "./api";
import { CSS_VARS, MAX_CUSTOM_THEMES, parseStoredThemes, themeCssVars, type CustomTheme } from "./customThemeUtil";
import type { ResolvedTheme } from "./themeUtil";

const CACHE_KEY = "gustaf-custom-theme";
type State = { themes: CustomTheme[]; activeId: string };
let state: State = { themes: [], activeId: "" };
const listeners = new Set<(s: State) => void>();

const resolvedNow = (): ResolvedTheme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** Sets (or clears) the palette variables for the resolved mode. Called by theme.ts whenever the mode changes. */
export function applyCustomTheme(mode: ResolvedTheme = resolvedNow()) {
  const root = document.documentElement;
  for (const v of CSS_VARS) root.style.removeProperty(v);
  const active = state.themes.find((t) => t.id === state.activeId);
  if (!active) return;
  for (const [k, v] of Object.entries(themeCssVars(active, mode))) root.style.setProperty(k, v);
}

const publish = () => listeners.forEach((l) => l(state));
const remember = () => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
};

export const getCustomThemes = () => state;
export function subscribeCustomThemes(l: (s: State) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function commit(next: State, persist: { themes?: boolean; active?: boolean }) {
  const activeId = next.themes.some((t) => t.id === next.activeId) ? next.activeId : "";
  state = { themes: next.themes.slice(0, MAX_CUSTOM_THEMES), activeId };
  applyCustomTheme();
  remember();
  if (persist.themes) setSetting("customThemes", state.themes).catch(() => {});
  if (persist.active) setSetting("customThemeId", state.activeId).catch(() => {});
  publish();
}

export const setActiveCustomTheme = (id: string) => commit({ ...state, activeId: id }, { active: true });

/** Adds or replaces a theme (matched by id). `activate` also makes it the active one. */
export function saveCustomTheme(theme: CustomTheme, activate = false) {
  const exists = state.themes.some((t) => t.id === theme.id);
  if (!exists && state.themes.length >= MAX_CUSTOM_THEMES) return false;
  const themes = exists ? state.themes.map((t) => (t.id === theme.id ? theme : t)) : [...state.themes, theme];
  commit({ themes, activeId: activate ? theme.id : state.activeId }, { themes: true, active: activate });
  return true;
}

export function deleteCustomTheme(id: string) {
  const wasActive = state.activeId === id;
  commit(
    { themes: state.themes.filter((t) => t.id !== id), activeId: wasActive ? "" : state.activeId },
    { themes: true, active: wasActive },
  );
}

/** Call once before first render (after initTheme): applies the cached theme, then reconciles with the stored settings. */
export function initCustomTheme() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (c) state = { themes: parseStoredThemes(c.themes), activeId: typeof c.activeId === "string" ? c.activeId : "" };
  } catch {
    /* ignore */
  }
  applyCustomTheme();
  Promise.all([getSetting<unknown>("customThemes", null), getSetting<unknown>("customThemeId", "")])
    .then(([themes, activeId]) => {
      if (themes == null) return;
      const next = { themes: parseStoredThemes(themes), activeId: typeof activeId === "string" ? activeId : "" };
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = { ...next, activeId: next.themes.some((t) => t.id === next.activeId) ? next.activeId : "" };
      applyCustomTheme();
      remember();
      publish();
    })
    .catch(() => {});
}
