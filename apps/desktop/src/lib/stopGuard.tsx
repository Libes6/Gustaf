import { useRef } from "react";
import { useT } from "../i18n";
import { useConfirm } from "../components/WorkspaceDialogs";

/**
 * Asks before a stop that would also kill background agents: "N agents are running, stop them?". `count` is read at the
 * moment of the stop (through a ref), `stopAgents` is called once after the user agrees. Render `node` in the tree and
 * pass `confirmStop` to whatever performs the stop: it is true (or resolves true) when the stop may go on and resolves false when the user keeps the agents running.
 */
export function useStopGuard(count: number, stopAgents?: () => void) {
  const t = useT();
  const { ask, node } = useConfirm();
  const latest = useRef({ count, stopAgents });
  latest.current = { count, stopAgents };
  const confirmStop = (): boolean | Promise<boolean> => {
    const n = latest.current.count;
    if (n <= 0) return true;
    return ask({ title: t("stopAgentsTitle", { count: n }), body: <p>{t("stopAgentsBody", { count: n })}</p>, confirmLabel: t("stopAgentsConfirm"), cancelLabel: t("stopAgentsKeep") }).then((ok) => {
      if (ok) latest.current.stopAgents?.();
      return ok;
    });
  };
  return { confirmStop, node };
}
