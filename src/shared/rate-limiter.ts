/**
 * Rate limiting. In-process until there is a second application node
 * (ADR-0014) — at which point the Redis adapter replaces the implementation
 * and nothing else changes, because callers hold the interface.
 *
 * Nothing here is required for correctness: exceeding a limit degrades to a
 * 429, never a wrong answer.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict>;
  /** Test-only: forget everything. */
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter.
 *
 * A sliding window is more precise, and the precision does not matter here:
 * these limits exist to stop enumeration and runaway SMS spend, not to meter
 * anything billable to the millisecond.
 */
export function createInProcessRateLimiter(
  clock: () => number = () => Date.now(),
): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = clock();

  /** Buckets are tiny but unbounded in key space; sweep expired ones lazily. */
  const sweep = (now: number): void => {
    if (now - lastSweep < 60_000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    lastSweep = now;
  };

  return {
    async check(key, limit, windowSeconds) {
      const now = clock();
      sweep(now);

      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      existing.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

      if (existing.count > limit) {
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      return {
        allowed: true,
        remaining: Math.max(0, limit - existing.count),
        retryAfterSeconds: 0,
      };
    },

    reset() {
      buckets.clear();
      lastSweep = clock();
    },
  };
}

/** The process-wide limiter. Swapped for Redis at the second node. */
export const rateLimiter: RateLimiter = createInProcessRateLimiter();
