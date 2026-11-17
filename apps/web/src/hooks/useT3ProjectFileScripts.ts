import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}

const PACKAGE_JSON_NAME = "package.json";
const MAX_PACKAGE_SCRIPTS = 50;
const NO_PACKAGE_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

function runnerForPackageManager(packageManager: unknown): string {
  const name = typeof packageManager === "string" ? packageManager.split("@")[0] : "";
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

export function parsePackageJsonScripts(contents: string): ReadonlyArray<T3ProjectFileScript> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return NO_PACKAGE_SCRIPTS;
  }
  if (typeof parsed !== "object" || parsed === null) return NO_PACKAGE_SCRIPTS;
  const { scripts, packageManager } = parsed as { scripts?: unknown; packageManager?: unknown };
  if (typeof scripts !== "object" || scripts === null) return NO_PACKAGE_SCRIPTS;
  const runner = runnerForPackageManager(packageManager);
  const names = Object.entries(scripts).flatMap(([name, body]) =>
    typeof body === "string" && body.trim() !== "" && name.trim() !== "" ? [name] : [],
  );
  // npm runs pre/post hooks implicitly, so listing them next to their base script is noise.
  return names
    .filter(
      (name) => !/^(pre|post)(.+)$/.test(name) || !names.includes(name.replace(/^(pre|post)/, "")),
    )
    .slice(0, MAX_PACKAGE_SCRIPTS)
    .map((name) => ({ name, command: `${runner} run ${name}` }));
}

export function usePackageJsonScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  const query = useProjectFileQuery(environmentId, cwd ?? "", PACKAGE_JSON_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return contents === null ? NO_PACKAGE_SCRIPTS : parsePackageJsonScripts(contents);
}
