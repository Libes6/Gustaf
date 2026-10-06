import { fsx, getSetting, setSetting } from "../lib/api";
import { readProjectFile } from "../lib/projectFolder";
import { normalizeProjectPath, sameProject } from "./rules";
import { effectiveHooks, GLOBAL_HOOKS_SETTING, parseHooksText, PROJECT_HOOKS_FILE, PROJECT_HOOKS_SETTING, validateHooks, type Hook, type HooksConfig } from "./hooksCore";

/** Hooks defined in the app settings (apply to every project). Never throws: unreadable settings mean no hooks. */
export async function loadGlobalHooks(): Promise<HooksConfig> {
  const raw = await getSetting<unknown>(GLOBAL_HOOKS_SETTING, null).catch(() => null);
  return raw == null ? { hooks: [], issues: [] } : validateHooks(raw, "global");
}

/** The text of the global hooks setting as shown in the editor. */
export async function loadGlobalHooksText(): Promise<string> {
  const raw = await getSetting<unknown>(GLOBAL_HOOKS_SETTING, null).catch(() => null);
  return raw == null ? "" : JSON.stringify(raw, null, 2);
}

/** Saves the editor text: only JSON that parses is stored (invalid entries inside it are reported by the validation, not stored away). */
export async function saveGlobalHooksText(text: string): Promise<HooksConfig> {
  if (!text.trim()) {
    await setSetting(GLOBAL_HOOKS_SETTING, null);
    return { hooks: [], issues: [] };
  }
  const parsed = parseHooksText(text, "global");
  if (parsed.issues.some((i) => i.index === null)) return parsed;
  await setSetting(GLOBAL_HOOKS_SETTING, JSON.parse(text));
  return parsed;
}

/** `<project>/.gustaf/hooks.json` (else the legacy `.mcode/hooks.json`), read-only. A missing file is not an error. */
export async function loadProjectHooks(project: string | null): Promise<HooksConfig & { exists: boolean }> {
  if (!project) return { hooks: [], issues: [], exists: false };
  let text: string;
  try {
    text = (await readProjectFile((path) => fsx.read(project, path, 1, 5000), PROJECT_HOOKS_FILE)).value;
  } catch {
    return { hooks: [], issues: [], exists: false };
  }
  return { ...parseHooksText(text, "project"), exists: true };
}

async function enabledProjects(): Promise<string[]> {
  const v = await getSetting<unknown>(PROJECT_HOOKS_SETTING, []).catch(() => []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** True when the user switched project hooks on for this project (default: off). */
export async function projectHooksEnabled(project: string | null): Promise<boolean> {
  return !!project && (await enabledProjects()).some((p) => sameProject(p, project));
}

export async function setProjectHooksEnabled(project: string, enabled: boolean) {
  const rest = (await enabledProjects()).filter((p) => !sameProject(p, project));
  await setSetting(PROJECT_HOOKS_SETTING, enabled ? [...rest, normalizeProjectPath(project)] : rest);
}

export type HooksView = { global: HooksConfig; project: HooksConfig & { exists: boolean }; enabled: boolean; effective: Hook[] };

/** Everything the settings viewer and the agent need for one project (`project` null: global hooks only). */
export async function loadHooksView(project: string | null): Promise<HooksView> {
  const [global, proj, enabled] = await Promise.all([loadGlobalHooks(), loadProjectHooks(project), projectHooksEnabled(project)]);
  return { global, project: proj, enabled, effective: effectiveHooks(global, proj, enabled) };
}
