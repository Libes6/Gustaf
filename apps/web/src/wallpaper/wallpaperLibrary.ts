import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";

const InstalledWallpaper = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  sky: Schema.optionalKey(Schema.String),
  source: Schema.String,
});
type InstalledWallpaper = typeof InstalledWallpaper.Type;

const WallpaperLibrary = Schema.Struct({
  activeId: Schema.NullOr(Schema.String),
  /** Off draws one still frame; a moving scene repaints the canvas for as long as it shows. */
  animate: Schema.optionalKey(Schema.Boolean),
  installed: Schema.Array(InstalledWallpaper),
});
type WallpaperLibrary = typeof WallpaperLibrary.Type;

const WALLPAPER_STORAGE_KEY = "t3code:wallpaper:v1";
const EMPTY_LIBRARY: WallpaperLibrary = { activeId: null, installed: [] };
export const MAX_SCENE_FILE_BYTES = 200_000;

export interface WallpaperOption {
  readonly id: string;
  readonly name: string;
  readonly sky?: string;
  /** Present for installed scenes; built-in scenes are fetched from the app's static files. */
  readonly source?: string;
}

// Skies are the ones the scenes were drawn against in Claude Desktop Themes.
export const BUILT_IN_WALLPAPERS: ReadonlyArray<WallpaperOption> = [
  {
    id: "koi-pond",
    name: "Koi Pond",
    sky: "linear-gradient(175deg, #4aa08c, #2f8070 50%, #1f6156)",
  },
  { id: "jellyfish", name: "Jellyfish", sky: "linear-gradient(#174784, #0c2b58 50%, #071a3a)" },
  {
    id: "moonlit",
    name: "Moonlit",
    sky: "radial-gradient(120% 90% at 75% 10%, #1a2a5e, #0d1530 60%, #090f24)",
  },
  { id: "cloud-drift", name: "Cloud Drift", sky: "linear-gradient(#4fa3e8, #86c3f0 55%, #b6dbf6)" },
];

export interface WallpaperInstallFile {
  readonly name: string;
  readonly text: string;
}

export type WallpaperInstallResult =
  | { readonly ok: true; readonly wallpaper: InstalledWallpaper }
  | { readonly ok: false; readonly reason: "no-scene" | "not-a-scene" | "too-large" };

const SCENE_REGISTRATION = /SCENES\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=/;

function isSafeSky(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[;{}<>\\]|url\(|image-set|@import/i.test(value)
  );
}

function readThemeFile(text: string | undefined): { name?: string; sky?: string } {
  if (text === undefined) return {};
  try {
    const theme: unknown = JSON.parse(text);
    if (typeof theme !== "object" || theme === null) return {};
    const name = "name" in theme && typeof theme.name === "string" ? theme.name.trim() : "";
    const vars =
      "vars" in theme && typeof theme.vars === "object" && theme.vars !== null ? theme.vars : null;
    const sky = vars !== null && "wall-sky" in vars ? vars["wall-sky"] : undefined;
    return {
      ...(name.length > 0 ? { name: name.slice(0, 60) } : {}),
      ...(isSafeSky(sky) ? { sky } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Reads a scene in the Claude Desktop Themes format: a `.js` file that registers
 * `SCENES['<id>']`, with an optional theme `.json` beside it naming the scene and its sky.
 */
export function parseWallpaperInstall(
  files: ReadonlyArray<WallpaperInstallFile>,
): WallpaperInstallResult {
  const scene = files.find((file) => /\.m?js$/i.test(file.name));
  if (!scene) return { ok: false, reason: "no-scene" };
  if (scene.text.length > MAX_SCENE_FILE_BYTES) return { ok: false, reason: "too-large" };
  const registration = SCENE_REGISTRATION.exec(scene.text);
  if (!registration) return { ok: false, reason: "not-a-scene" };
  const sceneId = registration[1] ?? registration[2] ?? "scene";
  const theme = readThemeFile(files.find((file) => /\.json$/i.test(file.name))?.text);
  const fallbackName = sceneId
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
  return {
    ok: true,
    wallpaper: {
      // Prefixed so an installed scene never shadows a built-in one with the same name.
      id: `installed:${sceneId}`,
      name: theme.name ?? fallbackName,
      ...(theme.sky ? { sky: theme.sky } : {}),
      source: scene.text,
    },
  };
}

/** Turns a GitHub file page into its raw URL; other URLs are used as given. */
export function resolveWallpaperSceneUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname === "github.com") {
    const [owner, repo, kind, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo || kind !== "blob" || rest.length < 2) return null;
    return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`);
  }
  return url;
}

/** The scene id the frame looks up; installed ids carry a prefix the scene file does not know. */
export function wallpaperSceneId(id: string): string {
  return id.replace(/^installed:/, "");
}

export function useWallpaperLibrary() {
  const [library, setLibrary] = useLocalStorage(
    WALLPAPER_STORAGE_KEY,
    EMPTY_LIBRARY,
    WallpaperLibrary,
  );
  const options: ReadonlyArray<WallpaperOption> = [...BUILT_IN_WALLPAPERS, ...library.installed];
  return {
    active: options.find((option) => option.id === library.activeId) ?? null,
    animate: library.animate === true,
    options,
    installed: library.installed,
    select: (id: string | null) => setLibrary((current) => ({ ...current, activeId: id })),
    setAnimate: (animate: boolean) => setLibrary((current) => ({ ...current, animate })),
    install: (wallpaper: InstalledWallpaper) =>
      setLibrary((current) => ({
        ...current,
        activeId: wallpaper.id,
        installed: [
          ...current.installed.filter((existing) => existing.id !== wallpaper.id),
          wallpaper,
        ],
      })),
    remove: (id: string) =>
      setLibrary((current) => ({
        ...current,
        activeId: current.activeId === id ? null : current.activeId,
        installed: current.installed.filter((existing) => existing.id !== id),
      })),
  };
}
