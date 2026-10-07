// The per-project settings folder `.gustaf/` (review rules, hooks, verification checks, skills). Projects set up before
// the rename keep these files in `.mcode/`: every read falls back to the same file there when `.gustaf/` lacks it.
// Pure (no Tauri, no React): Node runs it directly in the tests.

export const PROJECT_DIR = ".gustaf";
/** Read-only fallback for projects set up before the rename. */
export const LEGACY_PROJECT_DIR = ".mcode";

/** `.mcode/<rest>` for a `.gustaf/<rest>` path, else null. */
export function legacyProjectPath(path: string): string | null {
  return path.startsWith(PROJECT_DIR + "/") ? LEGACY_PROJECT_DIR + path.slice(PROJECT_DIR.length) : null;
}

/**
 * Reads `path` with `read`; when that fails and the path is inside `.gustaf/`, reads the same file in `.mcode/`.
 * Resolves to the value and the path it came from; rejects with the first error when neither can be read.
 */
export async function readProjectFile<T>(
  read: (path: string) => Promise<T>,
  path: string,
): Promise<{ value: T; path: string }> {
  try {
    return { value: await read(path), path };
  } catch (first) {
    const legacy = legacyProjectPath(path);
    if (!legacy) throw first;
    try {
      return { value: await read(legacy), path: legacy };
    } catch {
      throw first;
    }
  }
}
