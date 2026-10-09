// Per-key serialisation: calls with the same key run one after another, different keys never wait for each other.

export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  /** Runs `fn` after everything queued earlier under `key` has finished (failed or not). */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  busy(key: string) {
    return this.tails.has(key);
  }
}
