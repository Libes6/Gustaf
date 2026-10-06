// DOM side of theming: sets data-theme + accent variables on <html>, follows the OS scheme in "system" mode.
// Preferences live in app settings ("theme", "accent", "chatWidth"); a localStorage copy lets the first paint use them synchronously.
import { getSetting, setSetting } from "./api";
import { accentVars, chatWidthCss, parseChatWidth, parsePrefs, resolveTheme, type ChatWidth, type ThemeMode } from "./themeUtil";

const CACHE_KEY = "gustaf-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

type Prefs = { mode: ThemeMode; accent: string; width: ChatWidth };
let prefs: Prefs = { ...parsePrefs(undefined, undefined), width: parseChatWidth(undefined) };
const listeners = new Set<(p: Prefs) => void>();

const systemDark = () => (typeof matchMedia === "function" ? matchMedia(DARK_QUERY).matches : true);

export function applyTheme(p: Prefs = prefs) {
  const resolved = resolveTheme(p.mode, systemDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  for (const [k, v] of Object.entries(accentVars(p.accent, resolved))) root.style.setProperty(k, v);
  root.style.setProperty("--chat-width", chatWidthCss(p.width));
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
  prefs = { ...parsePrefs(patch.mode ?? prefs.mode, patch.accent ?? prefs.accent), width: parseChatWidth(patch.width ?? prefs.width) };
  applyTheme();
  remember(prefs);
  if (patch.mode !== undefined) setSetting("theme", prefs.mode).catch(() => {});
  if (patch.accent !== undefined) setSetting("accent", prefs.accent).catch(() => {});
  if (patch.width !== undefined) setSetting("chatWidth", prefs.width).catch(() => {});
  publish();
}

/** Call once before first render: applies the cached prefs, then reconciles with the stored settings. */
export function initTheme() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (c) prefs = { ...parsePrefs(c.mode, c.accent), width: parseChatWidth(c.width) };
  } catch { /* ignore */ }
  applyTheme();
  if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", () => { if (prefs.mode === "system") applyTheme(); });
  Promise.all([getSetting<unknown>("theme", null), getSetting<unknown>("accent", null), getSetting<unknown>("chatWidth", null)])
    .then(([mode, accent, width]) => {
      const next = { ...parsePrefs(mode ?? prefs.mode, accent ?? prefs.accent), width: parseChatWidth(width ?? prefs.width) };
      if (next.mode === prefs.mode && next.accent === prefs.accent && next.width === prefs.width) return;
      prefs = next;
      applyTheme();
      remember(prefs);
      publish();
    })
    .catch(() => {});
}
