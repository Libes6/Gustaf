/** Reconnect delay in ms for the Nth consecutive failure (0-based): exponential from 1 s, capped at 30 s, with jitter in [0.5, 1). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random() * 0.5));
}
