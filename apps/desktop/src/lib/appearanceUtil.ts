// Pure appearance helpers (fonts, sizes, wrapping, animation speed). No DOM/Tauri/React imports, so node tests cover
// them. The DOM side lives in appearance.ts; defaults here equal the values hard-coded in styles/theme.css.

export const FONT_PRESETS = ["default", "sans", "serif", "mono", "custom"] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];
export const MOTION_SPEEDS = ["off", "fast", "normal", "slow"] as const;
export type MotionSpeed = (typeof MOTION_SPEEDS)[number];

export const UI_SIZE_DEFAULT = 13, UI_SIZE_MIN = 11, UI_SIZE_MAX = 18;
export const CODE_SIZE_DEFAULT = 12, CODE_SIZE_MIN = 10, CODE_SIZE_MAX = 18;
export const FONT_NAME_MAX = 60;

export type FontChoice = { preset: FontPreset; custom: string };
export type AppearancePrefs = {
  uiFont: FontChoice;
  uiSize: number;
  codeFont: FontChoice;
  codeSize: number;
  wrapCode: boolean;
  motion: MotionSpeed;
};

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  uiFont: { preset: "default", custom: "" },
  uiSize: UI_SIZE_DEFAULT,
  codeFont: { preset: "default", custom: "" },
  codeSize: CODE_SIZE_DEFAULT,
  wrapCode: false,
  motion: "normal",
};

/** Same stacks as `--font` / `--mono` in theme.css. */
const SYSTEM_UI = 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Ubuntu, Cantarell, sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const STACKS: Record<Exclude<FontPreset, "custom">, { ui: string; code: string }> = {
  default: { ui: SYSTEM_UI, code: SYSTEM_MONO },
  sans: { ui: '"Helvetica Neue", Arial, "Noto Sans", sans-serif', code: '"SF Pro Text", "Segoe UI", Arial, sans-serif' },
  serif: { ui: 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif', code: 'Georgia, "Times New Roman", serif' },
  mono: { ui: SYSTEM_MONO, code: SYSTEM_MONO },
};

export const MOTION_SCALE: Record<MotionSpeed, number> = { off: 0, fast: 0.5, normal: 1, slow: 2 };

/** A single font family name typed by the user: letters, digits, spaces, dots, dashes, underscores. Null when unsafe (quotes, braces, semicolons, ...). */
export function sanitizeFontName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/\s+/g, " ");
  if (!s || s.length > FONT_NAME_MAX) return null;
  return /^[\p{L}\p{N} ._-]+$/u.test(s) ? s : null;
}

export const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

function parseFont(v: unknown): FontChoice {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const preset = FONT_PRESETS.includes(o.preset as FontPreset) ? (o.preset as FontPreset) : "default";
  const custom = sanitizeFontName(o.custom) ?? "";
  return { preset: preset === "custom" && !custom ? "default" : preset, custom };
}

/** Reads a stored value defensively (settings may hold anything). */
export function parseAppearance(raw: unknown): AppearancePrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    uiFont: parseFont(o.uiFont),
    uiSize: clampInt(o.uiSize, UI_SIZE_MIN, UI_SIZE_MAX, UI_SIZE_DEFAULT),
    codeFont: parseFont(o.codeFont),
    codeSize: clampInt(o.codeSize, CODE_SIZE_MIN, CODE_SIZE_MAX, CODE_SIZE_DEFAULT),
    wrapCode: o.wrapCode === true,
    motion: MOTION_SPEEDS.includes(o.motion as MotionSpeed) ? (o.motion as MotionSpeed) : "normal",
  };
}

/** CSS font-family value for a choice; a custom name is quoted and falls back to the system stack. */
export function fontStack(choice: FontChoice, kind: "ui" | "code"): string {
  if (choice.preset === "custom") {
    const name = sanitizeFontName(choice.custom);
    if (name) return `"${name}", ${kind === "ui" ? SYSTEM_UI : SYSTEM_MONO}`;
    return kind === "ui" ? SYSTEM_UI : SYSTEM_MONO;
  }
  return STACKS[choice.preset][kind];
}

/** CSS variables set on <html>; theme.css multiplies its px sizes by the scales. */
export function appearanceVars(p: AppearancePrefs): Record<string, string> {
  return {
    "--font": fontStack(p.uiFont, "ui"),
    "--mono": fontStack(p.codeFont, "code"),
    "--ui-scale": String(+(p.uiSize / UI_SIZE_DEFAULT).toFixed(4)),
    "--code-scale": String(+(p.codeSize / CODE_SIZE_DEFAULT).toFixed(4)),
    "--motion": String(MOTION_SCALE[p.motion]),
  };
}

export const isDefaultAppearance = (p: AppearancePrefs) => JSON.stringify(p) === JSON.stringify(DEFAULT_APPEARANCE);
