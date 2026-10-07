// DOM side of the appearance settings: sets font/size/motion variables and data-code-wrap on <html>.
// Stored as one app setting ("appearance"); a localStorage copy lets the first paint use it synchronously.
import { getSetting, setSetting } from "./api";
import { appearanceVars, DEFAULT_APPEARANCE, parseAppearance, type AppearancePrefs } from "./appearanceUtil";

const CACHE_KEY = "gustaf-appearance";
let prefs: AppearancePrefs = DEFAULT_APPEARANCE;
const listeners = new Set<(p: AppearancePrefs) => void>();

export function applyAppearance(p: AppearancePrefs = prefs) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(appearanceVars(p))) root.style.setProperty(k, v);
  root.dataset.codeWrap = p.wrapCode ? "on" : "off";
}

const publish = () => listeners.forEach((l) => l(prefs));
const remember = () => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
};

export const getAppearance = () => prefs;

export function subscribeAppearance(l: (p: AppearancePrefs) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setAppearance(patch: Partial<AppearancePrefs>) {
  prefs = parseAppearance({ ...prefs, ...patch });
  applyAppearance();
  remember();
  setSetting("appearance", prefs).catch(() => {});
  publish();
}

export function resetAppearance() {
  setAppearance(DEFAULT_APPEARANCE);
}

/** Call once before first render: applies the cached prefs, then reconciles with the stored setting. */
export function initAppearance() {
  try {
    prefs = parseAppearance(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
  } catch {
    /* ignore */
  }
  applyAppearance();
  getSetting<unknown>("appearance", null)
    .then((stored) => {
      if (stored == null) return;
      const next = parseAppearance(stored);
      if (JSON.stringify(next) === JSON.stringify(prefs)) return;
      prefs = next;
      applyAppearance();
      remember();
      publish();
    })
    .catch(() => {});
}
