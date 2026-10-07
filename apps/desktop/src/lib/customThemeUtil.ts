// Pure custom-theme helpers: tokens, base palettes, simple-mode derivation, export and (strict) import validation.
// No DOM/Tauri/React imports, so node tests cover them. The DOM/storage side lives in customTheme.ts.
// An imported file is only ever parsed with JSON.parse and checked field by field; nothing in it is evaluated,
// and only 3/6-digit hex colours for known tokens reach the CSS variables.

import { contrastRatio, mix, normalizeHex, type ResolvedTheme } from "./themeUtil.ts";

export const THEME_FORMAT = "gustaf-theme";
export const THEME_VERSION = 1;
/** A full export is about 3 KB; anything past this is not a theme file. */
export const MAX_THEME_FILE_BYTES = 64 * 1024;
export const MAX_THEME_NAME = 40;
export const MAX_CUSTOM_THEMES = 20;

export type TokenGroup = "base" | "surfaces" | "text" | "borders" | "states" | "code" | "diff";
export type TokenKey =
  | "bg"
  | "bgSide"
  | "bgElev"
  | "bgInput"
  | "bgHover"
  | "bgActive"
  | "bgCode"
  | "bgTool"
  | "bgInlineCode"
  | "bgChip"
  | "bgPop"
  | "bgPanel"
  | "bgSeg"
  | "bgIcon"
  | "btnSoftHover"
  | "border"
  | "borderStrong"
  | "text"
  | "text2"
  | "text3"
  | "green"
  | "red"
  | "warn"
  | "diffAddFg"
  | "diffDelFg"
  | "diffHunk"
  | "hlKeyword"
  | "hlString"
  | "hlNumber"
  | "hlComment"
  | "hlTitle"
  | "hlType";

export const TOKENS: readonly { key: TokenKey; cssVar: string; group: TokenGroup }[] = [
  { key: "bg", cssVar: "--bg", group: "base" },
  { key: "text", cssVar: "--text", group: "base" },
  { key: "bgSide", cssVar: "--bg-side", group: "surfaces" },
  { key: "bgElev", cssVar: "--bg-elev", group: "surfaces" },
  { key: "bgInput", cssVar: "--bg-input", group: "surfaces" },
  { key: "bgHover", cssVar: "--bg-hover", group: "surfaces" },
  { key: "bgActive", cssVar: "--bg-active", group: "surfaces" },
  { key: "bgTool", cssVar: "--bg-tool", group: "surfaces" },
  { key: "bgChip", cssVar: "--bg-chip", group: "surfaces" },
  { key: "bgPop", cssVar: "--bg-pop", group: "surfaces" },
  { key: "bgPanel", cssVar: "--bg-panel", group: "surfaces" },
  { key: "bgSeg", cssVar: "--bg-seg", group: "surfaces" },
  { key: "bgIcon", cssVar: "--bg-icon", group: "surfaces" },
  { key: "btnSoftHover", cssVar: "--btn-soft-hover", group: "surfaces" },
  { key: "text2", cssVar: "--text-2", group: "text" },
  { key: "text3", cssVar: "--text-3", group: "text" },
  { key: "border", cssVar: "--border", group: "borders" },
  { key: "borderStrong", cssVar: "--border-strong", group: "borders" },
  { key: "green", cssVar: "--green", group: "states" },
  { key: "red", cssVar: "--red", group: "states" },
  { key: "warn", cssVar: "--warn", group: "states" },
  { key: "bgCode", cssVar: "--bg-code", group: "code" },
  { key: "bgInlineCode", cssVar: "--bg-inline-code", group: "code" },
  { key: "hlKeyword", cssVar: "--hl-keyword", group: "code" },
  { key: "hlString", cssVar: "--hl-string", group: "code" },
  { key: "hlNumber", cssVar: "--hl-number", group: "code" },
  { key: "hlComment", cssVar: "--hl-comment", group: "code" },
  { key: "hlTitle", cssVar: "--hl-title", group: "code" },
  { key: "hlType", cssVar: "--hl-type", group: "code" },
  { key: "diffAddFg", cssVar: "--diff-add-fg", group: "diff" },
  { key: "diffDelFg", cssVar: "--diff-del-fg", group: "diff" },
  { key: "diffHunk", cssVar: "--diff-hunk", group: "diff" },
];
export const TOKEN_GROUPS: readonly TokenGroup[] = ["base", "surfaces", "text", "borders", "states", "code", "diff"];
export const TOKEN_KEYS: readonly TokenKey[] = TOKENS.map((t) => t.key);
const KEY_SET = new Set<string>(TOKEN_KEYS);
export const CSS_VARS: readonly string[] = TOKENS.map((t) => t.cssVar);

export type Palette = Record<TokenKey, string>;
export type CustomTheme = { id: string; name: string; light: Palette; dark: Palette };

/** The built-in palettes (same values as theme.css). */
export const BASE_PALETTES: Record<ResolvedTheme, Palette> = {
  dark: {
    bg: "#181818",
    bgSide: "#1d1d1d",
    bgElev: "#262626",
    bgInput: "#2a2a2a",
    bgHover: "#2c2c2c",
    bgActive: "#333333",
    bgCode: "#212121",
    bgTool: "#1c1c1c",
    bgInlineCode: "#2a2a2a",
    bgChip: "#232323",
    bgPop: "#161616",
    bgPanel: "#242424",
    bgSeg: "#202020",
    bgIcon: "#2c2c2c",
    btnSoftHover: "#3d3d3d",
    border: "#2f2f2f",
    borderStrong: "#3a3a3a",
    text: "#e6e6e6",
    text2: "#b3b3b3",
    text3: "#959595",
    green: "#4ec27a",
    red: "#ef6b6b",
    warn: "#e9a23b",
    diffAddFg: "#9fe0b5",
    diffDelFg: "#f3a3a3",
    diffHunk: "#82aaff",
    hlKeyword: "#c792ea",
    hlString: "#a5d6a7",
    hlNumber: "#f4a261",
    hlComment: "#959595",
    hlTitle: "#82aaff",
    hlType: "#ffcb6b",
  },
  light: {
    bg: "#ffffff",
    bgSide: "#f4f4f6",
    bgElev: "#ffffff",
    bgInput: "#f1f1f4",
    bgHover: "#ebebef",
    bgActive: "#e1e1e7",
    bgCode: "#f6f6f8",
    bgTool: "#f8f8fa",
    bgInlineCode: "#ececf1",
    bgChip: "#ececf0",
    bgPop: "#ffffff",
    bgPanel: "#ffffff",
    bgSeg: "#ececf0",
    bgIcon: "#ececf0",
    btnSoftHover: "#dcdce3",
    border: "#e3e3e8",
    borderStrong: "#cfcfd7",
    text: "#1b1b1f",
    text2: "#55555d",
    text3: "#636370",
    green: "#137a3e",
    red: "#bd2f2f",
    warn: "#8f5508",
    diffAddFg: "#116329",
    diffDelFg: "#a1262b",
    diffHunk: "#0550ae",
    hlKeyword: "#8250df",
    hlString: "#1a7f37",
    hlNumber: "#bc4c00",
    hlComment: "#5c6670",
    hlTitle: "#0550ae",
    hlType: "#953800",
  },
};

/** Simple mode: every neutral token is computed from the background and the text colour. */
export function deriveFromBase(bg: string, text: string, dark: boolean): Partial<Palette> {
  const b = normalizeHex(bg) ?? BASE_PALETTES.dark.bg,
    t = normalizeHex(text) ?? BASE_PALETTES.dark.text;
  const m = (k: number) => mix(b, t, k);
  return {
    bg: b,
    text: t,
    bgSide: m(0.04),
    bgElev: m(0.1),
    bgInput: m(0.12),
    bgHover: m(0.13),
    bgActive: m(0.19),
    bgCode: m(0.06),
    bgTool: m(0.03),
    bgInlineCode: m(0.12),
    bgChip: m(0.08),
    bgPop: dark ? mix(b, "#000000", 0.1) : b,
    bgPanel: m(0.09),
    bgSeg: m(0.05),
    bgIcon: m(0.13),
    btnSoftHover: m(0.24),
    border: m(0.14),
    borderStrong: m(0.2),
    text2: mix(t, b, 0.2),
    text3: mix(t, b, 0.32),
  };
}

export const emptyTheme = (id: string, name: string): CustomTheme => ({
  id,
  name,
  light: { ...BASE_PALETTES.light },
  dark: { ...BASE_PALETTES.dark },
});

/** Letters, digits, spaces, dots, dashes, underscores; collapsed spaces; null when empty, too long or containing anything else. */
export function sanitizeThemeName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/\s+/g, " ");
  if (!s || s.length > MAX_THEME_NAME) return null;
  return /^[\p{L}\p{N} ._()-]+$/u.test(s) ? s : null;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "theme"
  );
}

/** A unique id for `name` among `taken`. */
export function uniqueThemeId(name: string, taken: readonly string[]): string {
  const base = slugify(name);
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** "Name copy", "Name copy 2", ... */
export function duplicateName(name: string, existing: readonly string[]): string {
  const stem = `${name} copy`.slice(0, MAX_THEME_NAME - 3);
  if (!existing.includes(stem)) return stem;
  for (let i = 2; i < 100; i++) if (!existing.includes(`${stem} ${i}`)) return `${stem} ${i}`;
  return stem;
}

/** A palette read defensively: unknown keys dropped, bad colours replaced by `fallback`. */
function readPalette(raw: unknown, fallback: Palette): Palette {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...fallback };
  for (const key of TOKEN_KEYS) {
    const hex = Object.prototype.hasOwnProperty.call(o, key) ? normalizeHex(o[key]) : null;
    if (hex) out[key] = hex;
  }
  return out;
}

/** Stored themes (the setting may hold anything): invalid entries and duplicate ids are dropped. */
export function parseStoredThemes(raw: unknown): CustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTheme[] = [];
  for (const item of raw.slice(0, MAX_CUSTOM_THEMES)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = sanitizeThemeName(o.name);
    if (typeof o.id !== "string" || !/^[\p{L}\p{N}-]{1,40}$/u.test(o.id) || !name || out.some((t) => t.id === o.id))
      continue;
    out.push({
      id: o.id,
      name,
      light: readPalette(o.light, BASE_PALETTES.light),
      dark: readPalette(o.dark, BASE_PALETTES.dark),
    });
  }
  return out;
}

/** CSS variables of a theme for the resolved mode. */
export function themeCssVars(theme: CustomTheme, mode: ResolvedTheme): Record<string, string> {
  const palette = theme[mode];
  const out: Record<string, string> = {};
  for (const tk of TOKENS) {
    const hex = normalizeHex(palette[tk.key]);
    if (hex) out[tk.cssVar] = hex;
  }
  return out;
}

/** The exported JSON file text: only the format marker, version, name and the two palettes. */
export function exportTheme(theme: CustomTheme): string {
  return (
    JSON.stringify(
      { format: THEME_FORMAT, version: THEME_VERSION, name: theme.name, light: theme.light, dark: theme.dark },
      null,
      2,
    ) + "\n"
  );
}

export const exportFileName = (theme: CustomTheme) => `${slugify(theme.name)}.gustaf-theme.json`;

export type ImportError =
  "tooLarge" | "notJson" | "notTheme" | "version" | "name" | "unknownKey" | "badColor" | "noPalette";
export type ImportResult =
  { ok: true; name: string; light: Palette; dark: Palette } | { ok: false; error: ImportError; detail?: string };

/** Validates an imported file. Unknown fields, unknown tokens and anything but 3/6-digit hex colours are rejected. */
export function parseThemeFile(text: string): ImportResult {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_THEME_FILE_BYTES)
    return { ok: false, error: "tooLarge" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "notJson" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "notTheme" };
  const o = data as Record<string, unknown>;
  if (o.format !== THEME_FORMAT) return { ok: false, error: "notTheme" };
  if (o.version !== THEME_VERSION) return { ok: false, error: "version" };
  for (const k of Object.keys(o))
    if (!["format", "version", "name", "light", "dark"].includes(k))
      return { ok: false, error: "unknownKey", detail: k.slice(0, 40) };
  const name = sanitizeThemeName(o.name);
  if (!name) return { ok: false, error: "name" };
  if (o.light === undefined && o.dark === undefined) return { ok: false, error: "noPalette" };
  const palettes: Record<"light" | "dark", Palette> = {
    light: { ...BASE_PALETTES.light },
    dark: { ...BASE_PALETTES.dark },
  };
  for (const mode of ["light", "dark"] as const) {
    const raw = o[mode];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "notTheme" };
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!KEY_SET.has(k)) return { ok: false, error: "unknownKey", detail: k.slice(0, 40) };
      const hex = normalizeHex(v);
      if (!hex || typeof v !== "string" || v.length > 9) return { ok: false, error: "badColor", detail: k };
      palettes[mode][k as TokenKey] = hex;
    }
  }
  return { ok: true, name, light: palettes.light, dark: palettes.dark };
}

/** Text on page contrast for the editor's warning (WCAG AA is 4.5). */
export const textContrast = (p: Palette) => contrastRatio(p.text, p.bg);
