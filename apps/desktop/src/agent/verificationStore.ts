import { fsx, getSetting, setSetting } from "../lib/api";
import { readProjectFile } from "../lib/projectFolder";
import { detectDiagnostics } from "./diagnostics";
import { normalizeProjectPath } from "./rules";
import { defaultSettings, effectiveConfig, normalizeSettings, parseDoneText, PROJECT_DONE_FILE, SETTING_PREFIX, type DoneFile, type VerificationConfig, type VerificationSettings } from "./verificationCore";

export const verificationKey = (project: string) => `${SETTING_PREFIX}${normalizeProjectPath(project)}`;

/** The per-project settings (checks, fix attempts, the project-file switch). Never throws: unreadable settings are the defaults. */
export async function loadVerificationSettings(project: string): Promise<VerificationSettings> {
  const raw = await getSetting<unknown>(verificationKey(project), null).catch(() => null);
  return raw == null ? defaultSettings() : normalizeSettings(raw);
}

export const saveVerificationSettings = (project: string, value: VerificationSettings) => setSetting(verificationKey(project), normalizeSettings(value));

/** `<project>/.gustaf/done.json` (else the legacy `.mcode/done.json`), read-only. A missing file is not an error (`null`). */
export async function loadDoneFile(project: string | null): Promise<(DoneFile & { exists: true }) | null> {
  if (!project) return null;
  let text: string;
  try {
    text = (await readProjectFile((path) => fsx.read(project, path, 1, 5000), PROJECT_DONE_FILE)).value;
  } catch {
    return null;
  }
  return { ...parseDoneText(text), exists: true };
}

export type VerificationView = { settings: VerificationSettings; file: DoneFile | null; config: VerificationConfig };

/** Everything the settings editor and the agent need for one project. The file is read only when its switch is on or the editor asks for it. */
export async function loadVerificationView(project: string, o: { readFile?: boolean } = {}): Promise<VerificationView> {
  const settings = await loadVerificationSettings(project);
  const file = settings.useProjectFile || o.readFile ? await loadDoneFile(project) : null;
  return { settings, file, config: effectiveConfig(settings, file) };
}

/** The checks one agent run uses (the project file only with its switch on). */
export async function loadVerificationConfig(project: string): Promise<VerificationConfig> {
  return (await loadVerificationView(project)).config;
}

export type SuggestedCheck = { name: string; command: string; timeoutMs?: number };

/**
 * Suggestions for the editor, never run by themselves: the diagnostics auto-detect (an installed JS typecheck or lint
 * script, else the installed TypeScript binary) plus the project's own `lint` and `test` npm scripts when they exist.
 */
export async function suggestChecks(root: string): Promise<SuggestedCheck[]> {
  const out: SuggestedCheck[] = [];
  const add = (name: string, command: string, timeoutMs?: number) => {
    if (command && !out.some((c) => c.command === command)) out.push({ name, command, ...(timeoutMs ? { timeoutMs } : {}) });
  };
  const diag = await detectDiagnostics(root).catch(() => "");
  add(/\blint\b/.test(diag) ? "lint" : "typecheck", diag);
  try {
    const manifest = JSON.parse((await fsx.read(root, "package.json", 1, 2000)).replace(/^\s*\d+\|/gm, ""));
    const scripts = manifest.scripts ?? {};
    if (typeof scripts.lint === "string") add("lint", "npm run lint");
    if (typeof scripts.test === "string") add("test", "npm test", 300_000);
  } catch {
    /* not a JS project */
  }
  return out;
}
