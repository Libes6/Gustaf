const APPIMAGE_RUNTIME_ENV_KEYS = new Set(["APPIMAGE", "APPDIR", "ARGV0", "OWD"]);

function isUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

/**
 * An AppImage's AppRun points PATH, libraries and GTK/GIO modules into its read-only mount.
 * Programs the server starts for the user (terminals, editors, the file manager, the browser)
 * load those instead of the system's and fail, so every value under the mount is dropped.
 */
export function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;
  const appDir = env.APPDIR?.replace(/\/+$/, "");
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || APPIMAGE_RUNTIME_ENV_KEYS.has(key)) continue;
    if (!appDir || !value.includes(appDir)) {
      scrubbed[key] = value;
      continue;
    }
    const segments = value.split(":");
    const kept = segments.filter(
      (segment) => segment.length > 0 && !isUnderAppDir(segment, appDir),
    );
    if (kept.length === segments.length) scrubbed[key] = value;
    else if (kept.length > 0) scrubbed[key] = kept.join(":");
  }
  return scrubbed;
}
