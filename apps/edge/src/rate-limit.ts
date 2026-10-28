/**
 * In-memory sliding-window rate limiter.
 *
 * The edge is a single process with a small amount of state, so a per-key list
 * of timestamps is enough. Keys are action + client address; callers decide
 * what an action is. Failed attempts count the same as successful ones so a
 * brute-force loop cannot outrun the window.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const MAX_KEYS = 20_000;

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.now();
    this.sweep(now, windowMs);
    const bucket = this.buckets.get(key) ?? [];
    const cutoff = now - windowMs;
    let first = 0;
    while (first < bucket.length && (bucket[first] ?? 0) <= cutoff) first += 1;
    if (first > 0) bucket.splice(0, first);
    if (bucket.length >= limit) {
      const oldest = bucket[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      this.buckets.set(key, bucket);
      return { ok: false, remaining: 0, retryAfterSeconds };
    }
    bucket.push(now);
    this.buckets.set(key, bucket);
    return { ok: true, remaining: limit - bucket.length, retryAfterSeconds: 0 };
  }

  /** Forget a key (used after a successful pairing so a typo cost is refunded). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number, windowMs: number): void {
    if (this.buckets.size < MAX_KEYS) return;
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    const cutoff = now - windowMs;
    for (const [key, bucket] of this.buckets) {
      const newest = bucket[bucket.length - 1] ?? 0;
      if (newest <= cutoff) this.buckets.delete(key);
    }
  }
}