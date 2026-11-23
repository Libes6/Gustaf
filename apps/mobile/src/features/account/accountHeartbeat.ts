import type { AccountApi, AccountHeartbeat } from "./accountApi";

export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AccountHeartbeatDeps {
  readonly send: AccountApi["heartbeat"];
  /** The registered phone's credential, or null when signed out or not registered. */
  readonly deviceToken: () => Promise<string | null>;
  readonly report: () => AccountHeartbeat | null;
  readonly now: () => number;
  readonly onError: (cause: unknown) => void;
}

/** Sends at most once a day unless forced; a failed send is retried on the next trigger. */
export function createAccountHeartbeat(deps: AccountHeartbeatDeps) {
  let lastSentAt: number | null = null;
  let sending = false;
  return async ({ force = false }: { readonly force?: boolean } = {}) => {
    if (sending) return;
    if (!force && lastSentAt !== null && deps.now() - lastSentAt < HEARTBEAT_INTERVAL_MS) return;
    sending = true;
    try {
      const report = deps.report();
      const token = report ? await deps.deviceToken() : null;
      if (!report || !token) return;
      await deps.send(token, report);
      lastSentAt = deps.now();
    } catch (cause) {
      deps.onError(cause);
    } finally {
      sending = false;
    }
  };
}
