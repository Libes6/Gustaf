import { stopAllProcesses } from "../providers/processHost";
import { liveSessions } from "../providers/sessionManager";

// Ends every agent this window started (live sessions, per-turn CLI processes, sidecars) before the window goes:
// window close, reload, update relaunch. Bounded, so a hung agent never keeps the window open; Rust kills whatever is
// still in the process ledger when the app exits (src-tauri/src/proc_ledger.rs).

export const SHUTDOWN_BUDGET_MS = 2000;

/** Releases all live sessions and stops all agent processes; resolves after at most `budgetMs`. Never throws. */
export async function shutdownAgents(budgetMs = SHUTDOWN_BUDGET_MS) {
  const all = Promise.all([
    // Processes first: a session's release reuses the stop already under way, so this grace (not the default one) applies.
    stopAllProcesses(Math.min(1500, budgetMs)),
    liveSessions.releaseAll(),
  ]).then(
    () => {},
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, budgetMs)))]);
  clearTimeout(timer);
}

/** Main window: shut agents down when the window is asked to close (and, fire and forget, on reload). Returns cleanup. */
export function installAgentShutdown(): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // The window is destroyed once the handler resolves (needs `core:window:allow-destroy`).
      const off = await getCurrentWindow().onCloseRequested(() => shutdownAgents());
      if (disposed) off();
      else unlisten = off;
    } catch {
      /* outside Tauri */
    }
  })();
  // A reload cannot wait: start the graceful stop; the ledger cleans up whatever outlives the page.
  const onUnload = () => void shutdownAgents();
  addEventListener("pagehide", onUnload);
  return () => {
    disposed = true;
    unlisten?.();
    removeEventListener("pagehide", onUnload);
  };
}
