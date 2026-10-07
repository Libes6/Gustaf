import { fsx } from "../lib/api";
import { listMemories } from "./memory";
import { AGENTS_FILE, currentAgentsMd, mergeSection, renderSection, type MergeAction } from "./memoryExport";

export type ExportPreview = { text: string; action: MergeAction; projectCount: number; globalCount: number };

/**
 * What exporting would produce: reads `<root>/AGENTS.md` (the existing instruction-file reader plus a directory listing, so an
 * unreadable file is refused rather than treated as missing) and merges the managed section. Nothing is written.
 */
export async function previewAgentsExport(root: string, includeGlobal: boolean): Promise<ExportPreview> {
  const [project, global, files, listing] = await Promise.all([
    listMemories(root),
    includeGlobal ? listMemories(null) : Promise.resolve([]),
    fsx.instructions(root),
    fsx.list(root, ".").catch(() => ""),
  ]);
  const { text, action } = mergeSection(currentAgentsMd(files, listing), renderSection(project, global));
  return { text, action, projectCount: project.length, globalCount: global.length };
}

/**
 * Writes the previewed text through the project-confined `fs_write`. The merge is recomputed from the file as it is now: if it
 * no longer matches what the user confirmed (the file or the entries changed meanwhile) nothing is written and the new
 * preview is returned for another confirmation.
 */
export async function writeAgentsExport(
  root: string,
  includeGlobal: boolean,
  confirmed: string,
): Promise<{ written: true } | { written: false; preview: ExportPreview }> {
  const fresh = await previewAgentsExport(root, includeGlobal);
  if (fresh.text !== confirmed) return { written: false, preview: fresh };
  if (fresh.action !== "unchanged") await fsx.write(root, AGENTS_FILE, fresh.text);
  return { written: true };
}
