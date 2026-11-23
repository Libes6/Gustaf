/**
 * One cached value that reloads after `ttlMs`. Concurrent callers share one load. A failed load is
 * not retried for `retryMs`; during that time the last good value is served if there is one.
 */
export class TtlCache<T> {
  private value: { data: T; fetchedAt: Date } | undefined;
  private failure: { error: unknown; at: number } | undefined;
  private loading: Promise<{ data: T; fetchedAt: Date }> | undefined;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly retryMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<{ data: T; fetchedAt: Date }> {
    const now = this.now();
    if (this.value && now - this.value.fetchedAt.getTime() < this.ttlMs) {
      return Promise.resolve(this.value);
    }
    if (this.failure && now - this.failure.at < this.retryMs) {
      return this.value ? Promise.resolve(this.value) : Promise.reject(this.failure.error);
    }
    this.loading ??= this.load()
      .then(
        (data) => {
          this.value = { data, fetchedAt: new Date(this.now()) };
          this.failure = undefined;
          return this.value;
        },
        (error: unknown) => {
          this.failure = { error, at: this.now() };
          if (this.value) return this.value;
          throw error;
        },
      )
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
}
