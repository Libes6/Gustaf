// Pure FIFO scheduler with a concurrency limit: subagents wait in a queue until a slot is free. No app imports, so it is
// unit-tested in tests/scheduler.test.mjs. A task is only invoked when it gets its slot; an abort signal removes a queued
// task (it rejects with an AbortError) and is passed on to a running one, which is expected to stop by itself.

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

export const clampConcurrency = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n))) : DEFAULT_CONCURRENCY);

const abortError = () => new DOMException("Aborted", "AbortError");
export const isAbortError = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

type Waiting = { start: () => void; cleanup: () => void };

export class Scheduler {
  private limit: number;
  private active = 0;
  private queue: Waiting[] = [];
  private listeners = new Set<() => void>();

  constructor(limit: number = DEFAULT_CONCURRENCY) {
    this.limit = clampConcurrency(limit);
  }

  get running() {
    return this.active;
  }
  get queued() {
    return this.queue.length;
  }
  get concurrency() {
    return this.limit;
  }

  /** Changes the limit; raising it starts queued tasks right away, lowering it never interrupts running ones. */
  setConcurrency(n: number) {
    this.limit = clampConcurrency(n);
    this.pump();
  }

  onChange(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  run<T>(task: (signal: AbortSignal | undefined) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        start: () => {
          entry.cleanup();
          this.active++;
          this.emit();
          let p: Promise<T>;
          try {
            p = Promise.resolve(task(signal));
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(resolve, reject).finally(() => {
            this.active--;
            this.emit();
            this.pump();
          });
        },
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i < 0) return;
        this.queue.splice(i, 1);
        entry.cleanup();
        this.emit();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
      this.emit();
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!.start();
  }
}
