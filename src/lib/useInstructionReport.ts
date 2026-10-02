import { useCallback, useEffect, useState } from "react";
import { nativeInstructionFiles, type InstructionPrompt } from "../agent/instructions";
import { loadProjectInstructions } from "../agent/instructionsStore";
import type { ProviderConfig } from "../providers/types";

/** Fired when a project's custom instructions are saved, so open composers refresh their list. */
const SAVED = "mcode:instructions-saved";
export const announceInstructionsSaved = () => window.dispatchEvent(new Event(SAVED));

/** Which instruction files (and custom text) the next run of `root` would load with `provider`; `reload` re-reads the disk. */
export function useInstructionReport(root: string | null, provider: ProviderConfig | undefined) {
  const [report, setReport] = useState<InstructionPrompt | null>(null);
  const kind = provider?.kind;
  const cli = provider?.cli;
  const reload = useCallback(() => {
    if (!root) return setReport(null);
    loadProjectInstructions({ root, project: root, native: nativeInstructionFiles(kind ? { kind, cli } : undefined) }).then(setReport, () => setReport(null));
  }, [root, kind, cli]);
  useEffect(() => {
    reload();
    window.addEventListener(SAVED, reload);
    return () => window.removeEventListener(SAVED, reload);
  }, [reload]);
  return { report, reload };
}
