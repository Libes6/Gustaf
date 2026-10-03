// DOM side of theming: sets data-theme + accent variables on <html>, follows the OS scheme in "system" mode.
// Preferences live in app settings ("theme", "accent"); a localStorage copy lets the first paint use them synchronously.
import { getSetting, setSetting } from "./api";
import { accentVars, parsePrefs, resolveTheme, type ThemeMode } from "./themeUtil";

const CACHE_KEY = "mcode-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

type Prefs = { mode: ThemeMode; accent: string };
let prefs: Prefs = parsePrefs(undefined, undefined);
const listeners = new Set<(p: Prefs) => void>();

const systemDark = () => (typeof matchMedia === "function" ? matchMedia(DARK_QUERY).matches : true);

export function applyTheme(p: Prefs = prefs) {
  const resolved = resolveTheme(p.mode, systemDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  for (const [k, v] of Object.entries(accentVars(p.accent, resolved))) root.style.setProperty(k, v);
}

const publish = () => listeners.forEach((l) => l(prefs));

function remember(p: Prefs) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

export function getThemePrefs(): Prefs { return prefs; }

export function subscribeTheme(l: (p: Prefs) => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function setThemePrefs(patch: Partial<Prefs>) {
  prefs = parsePrefs(patch.mode ?? prefs.mode, patch.accent ?? prefs.accent);
  applyTheme();
  remember(prefs);
  if (patch.mode !== undefined) setSetting("theme", prefs.mode).catch(() => {});
  if (patch.accent !== undefined) setSetting("accent", prefs.accent).catch(() => {});
  publish();
}

/** Call once before first render: applies the cached prefs, then reconciles with the stored settings. */
export function initTheme() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (c) prefs = parsePrefs(c.mode, c.accent);
  } catch { /* ignore */ }
  applyTheme();
  if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", () => { if (prefs.mode === "system") applyTheme(); });
  Promise.all([getSetting<unknown>("theme", null), getSetting<unknown>("accent", null)])
    .then(([mode, accent]) => {
      const next = parsePrefs(mode ?? prefs.mode, accent ?? prefs.accent);
      if (next.mode === prefs.mode && next.accent === prefs.accent) return;
      prefs = next;
      applyTheme();
      remember(prefs);
      publish();
    })
    .catch(() => {});
}
