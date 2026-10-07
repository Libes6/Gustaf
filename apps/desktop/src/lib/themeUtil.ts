// Pure theme helpers (no DOM/Tauri/React imports, so node tests can cover them). The DOM side lives in theme.ts.

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];
export const DEFAULT_THEME: ThemeMode = "dark";
export const DEFAULT_ACCENT = "#a884ee";

/** Width of the conversation column and the composer. */
export type ChatWidth = "standard" | "wide" | "full";
export const CHAT_WIDTHS: readonly ChatWidth[] = ["standard", "wide", "full"];
export const DEFAULT_CHAT_WIDTH: ChatWidth = "standard";
export const parseChatWidth = (v: unknown): ChatWidth =>
  CHAT_WIDTHS.includes(v as ChatWidth) ? (v as ChatWidth) : DEFAULT_CHAT_WIDTH;
/** CSS value of `--chat-width` for a setting. */
export const chatWidthCss = (w: ChatWidth) => (w === "wide" ? "960px" : w === "full" ? "100%" : "720px");
/** Offered in Settings; any other valid hex is accepted through the custom field. */
export const ACCENT_PRESETS: readonly string[] = ["#a884ee", "#6ea8fe", "#4ec27a", "#f0a53a", "#f07178", "#e879b9"];
/** WCAG AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

export const isThemeMode = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

/** Normalizes `#abc` / `#aabbcc` / `aabbcc` (any case) to `#aabbcc`; null when it is not a hex color. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = normalizeHex(hex) ?? DEFAULT_ACCENT;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export const rgbToHex = (rgb: RGB) =>
  "#" +
  rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

/** `amount` 0..1 of `to` mixed into `from`. */
export function mix(from: string, to: string, amount: number): string {
  const a = hexToRgb(from),
    b = hexToRgb(to);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * amount) as RGB);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of near-black / white reads better on `bg`. */
export function readableOn(bg: string, dark = "#1b1b1b", light = "#ffffff"): string {
  return contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light;
}

/** Darkens `color` toward black until `text` on it reaches `min` contrast (used for the user's message bubble). */
export function darkenUntilReadable(color: string, text = "#ffffff", min = MIN_TEXT_CONTRAST): string {
  let c = color;
  for (let i = 0; i < 20 && contrastRatio(c, text) < min; i++) c = mix(c, "#000000", 0.1);
  return c;
}

/** Lightens `color` toward white until `text` on it reaches `min` contrast. */
export function lightenUntilReadable(color: string, text = "#1b1b1b", min = MIN_TEXT_CONTRAST): string {
  let c = color;
  for (let i = 0; i < 20 && contrastRatio(c, text) < min; i++) c = mix(c, "#ffffff", 0.1);
  return c;
}

/** WCAG 1.4.11: focus rings and other UI boundaries need 3:1 against the page. */
export const MIN_UI_CONTRAST = 3;
/** Page backgrounds the focus ring is derived against (same values as `--bg` in theme.css). */
const PAGE_BG: Record<ResolvedTheme, string> = { dark: "#181818", light: "#ffffff" };

/** The accent nudged toward white (dark theme) or black (light theme) until it reaches `min` against the page background. */
export function focusRingColor(accent: string, theme: ResolvedTheme, min = MIN_UI_CONTRAST + 0.5): string {
  const bg = PAGE_BG[theme],
    to = theme === "dark" ? "#ffffff" : "#000000";
  let c = normalizeHex(accent) ?? DEFAULT_ACCENT;
  for (let i = 0; i < 20 && contrastRatio(c, bg) < min; i++) c = mix(c, to, 0.1);
  return c;
}

/** CSS variables derived from the accent: `--accent` itself, a soft variant for links/buttons, the message bubble and the text on top of each. */
export function accentVars(accent: string, theme: ResolvedTheme): Record<string, string> {
  const base = normalizeHex(accent) ?? DEFAULT_ACCENT;
  const soft =
    theme === "dark"
      ? lightenUntilReadable(mix(base, "#ffffff", 0.42))
      : darkenUntilReadable(mix(base, "#000000", 0.3));
  const bubble = darkenUntilReadable(theme === "dark" ? mix(base, "#000000", 0.45) : base);
  return {
    "--accent": base,
    "--focus": focusRingColor(base, theme),
    "--accent-soft": soft,
    "--on-accent": readableOn(soft),
    "--bubble": bubble,
    "--bubble-fg": readableOn(bubble),
  };
}

/** Reads stored values defensively (settings may hold anything). */
export function parsePrefs(mode: unknown, accent: unknown): { mode: ThemeMode; accent: string } {
  return { mode: isThemeMode(mode) ? mode : DEFAULT_THEME, accent: normalizeHex(accent) ?? DEFAULT_ACCENT };
}
