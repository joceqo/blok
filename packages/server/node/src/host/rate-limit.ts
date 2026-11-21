interface Window {
  start: number;
  count: number;
}

/** Fixed one-minute window per key; limit ≤ 0 turns the limiter off. */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  constructor(
    readonly limit: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    if (this.limit <= 0) {
      return true;
    }
    const now = this.now();
    if (now - this.lastSweep >= 60_000) {
      this.lastSweep = now;
      for (const [k, window] of this.windows) {
        if (now - window.start >= 60_000) {
          this.windows.delete(k);
        }
      }
    }
    let window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (window.count >= this.limit) {
      return false;
    }
    window.count += 1;
    return true;
  }
}