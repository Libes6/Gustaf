// Host OS as seen from the webview (pure apart from `currentPlatform`, which reads `navigator`).
export type Platform = "macos" | "windows" | "linux";

/** Maps `navigator.platform` / the user-agent string to a platform. Unknown values count as Linux (the generic Unix case). */
export function detectPlatform(platform = "", userAgent = ""): Platform {
  const s = `${platform} ${userAgent}`.toLowerCase();
  if (/\b(win32|win64|windows)\b|\bwin\b/.test(s)) return "windows";
  if (/\b(mac|macintel|macppc|darwin|macintosh)\b|mac os/.test(s)) return "macos";
  return "linux";
}

let cached: Platform | undefined;

export function currentPlatform(): Platform {
  if (cached) return cached;
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  cached = detectPlatform(nav?.platform, nav?.userAgent);
  return cached;
}

/** Test hook. */
export function setPlatformForTests(p: Platform | undefined) {
  cached = p;
}

export const isMac = () => currentPlatform() === "macos";
export const isWindows = () => currentPlatform() === "windows";
