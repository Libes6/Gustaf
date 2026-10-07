// One provider check and "Check all" (pure, tested): the check never throws, it returns the text to record for the
// provider ("" means it works), so one provider's failure stays on its own row and never stops the others.

export const PROVIDER_CHECK_TIMEOUT_MS = 30_000;

/**
 * Runs `run` with an abort signal that fires after `timeoutMs`. Returns "" on success, otherwise the error text; a run that
 * was aborted by the timeout reports `timeoutMessage` (already translated by the caller) instead of the abort error.
 */
export async function runProviderCheck(run: (signal: AbortSignal) => Promise<void>, timeoutMessage: string, timeoutMs = PROVIDER_CHECK_TIMEOUT_MS): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await run(ctl.signal);
    return ctl.signal.aborted ? timeoutMessage : "";
  } catch (e) {
    return ctl.signal.aborted ? timeoutMessage : String(e instanceof Error ? e.message : e) || "Error";
  } finally {
    clearTimeout(timer);
  }
}

/** Checks the providers one after another (they share the CLI and the network, so no parallel burst) and records each result under its own id. */
export async function checkProviders<P extends { id: string }>(providers: readonly P[], check: (p: P) => Promise<string>, record: (id: string, message: string) => void, onStart: (id: string | null) => void = () => {}): Promise<void> {
  try {
    for (const p of providers) {
      onStart(p.id);
      let message: string;
      try { message = await check(p); } catch (e) { message = String(e instanceof Error ? e.message : e) || "Error"; }
      record(p.id, message);
    }
  } finally {
    onStart(null);
  }
}
