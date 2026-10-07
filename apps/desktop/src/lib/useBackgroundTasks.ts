import { useEffect, useRef, useState } from "react";
import { useAgentRuns } from "../agent/agentRuns";
import { isActiveStatus } from "../agent/agentRunsModel";
import { isCliAgentActive, useCliAgents } from "../agent/cliAgents";

/** Pure: the keys of `active` that were not in `seen` yet (a new run); `seen` is updated. */
export function takeNewRuns(seen: Set<string>, active: readonly string[]): string[] {
  const fresh = active.filter((k) => !seen.has(k));
  for (const k of fresh) seen.add(k);
  return fresh;
}

/**
 * State of the right-hand "Background tasks" column of one chat view. The column opens by itself the first time a run
 * of this project appears as running (once per run); closing it is respected until the next new run. Runs that were
 * already active when the view mounted never open it. `interrupted` (leftover agent worktrees) only keeps the toggle visible.
 */
export function useBackgroundTasks(root: string | null, interrupted = 0) {
  const runs = useAgentRuns(root);
  const cli = useCliAgents(root);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const active = [
    ...runs.filter((r) => isActiveStatus(r.status)).map((r) => `run:${r.id}`),
    ...cli.filter(isCliAgentActive).map((a) => `cli:${a.key}`),
  ];
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(active);
  const signature = active.join("|");
  useEffect(() => {
    if (takeNewRuns(seen.current!, active).length) setOpen(true);
  }, [signature]);
  const close = () => {
    setOpen(false);
    setExpanded(false);
  };
  return {
    open,
    setOpen,
    expanded,
    setExpanded,
    close,
    running: active.length,
    hasAgents: runs.length + cli.length + interrupted > 0,
  };
}

export type BackgroundTasks = ReturnType<typeof useBackgroundTasks>;
