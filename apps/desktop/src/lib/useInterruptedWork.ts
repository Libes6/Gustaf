import { useMemo } from "react";
import { useApp } from "../state";
import { findInterruptedWork, linkedTaskIds, type InterruptedWork } from "./interruptedWork";
import { useWorkspaces } from "./workspaceStore";

/** Interrupted agent work of a project (see lib/interruptedWork.ts), read from the shared workspace list: read-only. */
export function useInterruptedWork(root: string | null | undefined): InterruptedWork[] {
  const app = useApp();
  const entry = useWorkspaces(root);
  return useMemo(() => findInterruptedWork(entry.list, linkedTaskIds(app.chats)), [entry.list, app.chats]);
}
