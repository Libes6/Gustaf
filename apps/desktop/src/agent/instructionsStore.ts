import { fsx, getSetting, setSetting } from "../lib/api";
import {
  assembleInstructions,
  CUSTOM_INSTRUCTIONS_CAP,
  projectInstructionsKey,
  type InstructionPrompt,
} from "./instructions";
import { normalizeProjectPath } from "./rules";

const key = (project: string) => projectInstructionsKey(normalizeProjectPath(project));

export async function getProjectInstructionText(project: string): Promise<string> {
  const v = await getSetting<unknown>(key(project), "");
  return typeof v === "string" ? v : "";
}

export const setProjectInstructionText = (project: string, text: string) =>
  setSetting(key(project), text.trim().slice(0, CUSTOM_INSTRUCTIONS_CAP));

/**
 * Reads the project's instruction files from `root` (the run's folder, which is a review copy in review mode) and the custom
 * text stored for `project` (the original folder). Failures degrade to "no instructions" instead of failing the run.
 */
export async function loadProjectInstructions(o: {
  root: string;
  project: string | null;
  native?: string[];
}): Promise<InstructionPrompt> {
  const [files, custom] = await Promise.all([
    fsx.instructions(o.root).catch(() => []),
    o.project ? getProjectInstructionText(o.project).catch(() => "") : "",
  ]);
  return assembleInstructions(files, { native: o.native, custom });
}
