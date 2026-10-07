// What the providers page shows about one provider's connection (pure, node-tested): the state, why it is not usable,
// and whether the last check is too old to trust.

export type ProviderHealth = {
  status: "ok" | "auth" | "error";
  message: string;
  /** When the check or run that produced this status finished (ms). */ at?: number;
};

/** A status older than this is shown as outdated (the sign-in may have expired or the service may have changed since). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type Diagnosis = {
  state: "disabled" | "cliMissing" | "auth" | "error" | "ok" | "unchecked";
  /** Raw error text from the provider / CLI, when there is one. */
  detail: string;
  /** When the status was recorded; null if never or unknown (statuses saved before timestamps existed). */
  checkedAt: number | null;
  /** The status exists but is older than STALE_AFTER_MS (or has no timestamp): re-check before trusting it. */
  stale: boolean;
};

/**
 * `cliFound` is undefined while the CLI list is loading or for providers without a CLI; false when this is a CLI provider
 * and its binary was not found. A model-listing error (`listError`) counts as unavailable when no direct check was made.
 */
export function diagnose(o: {
  disabled?: boolean;
  health?: ProviderHealth;
  listError?: string;
  cliFound?: boolean;
  now: number;
}): Diagnosis {
  const { health } = o;
  const checkedAt = health?.at ?? null;
  const stale = !!health && (checkedAt === null || o.now - checkedAt > STALE_AFTER_MS);
  const base = { checkedAt, stale };
  if (o.disabled) return { ...base, state: "disabled", detail: "" };
  if (o.cliFound === false && health?.status !== "ok")
    return { ...base, state: "cliMissing", detail: health?.message ?? "" };
  if (health?.status === "auth") return { ...base, state: "auth", detail: health.message };
  const err = health?.status === "error" ? health.message : o.listError;
  if (err) return { ...base, state: "error", detail: err };
  if (health?.status === "ok") return { ...base, state: "ok", detail: "" };
  return { ...base, state: "unchecked", detail: "", stale: false };
}
