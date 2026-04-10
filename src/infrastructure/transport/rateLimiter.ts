import { Clock } from '../../application/ports/Clock.js';

export interface RateLimitDecision {
  allowed: boolean;
  retry_after_seconds: number;
}

interface Bucket {
  window_start_ms: number;
  count: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock) {}

  consume(key: string, limit: number, windowMs: number): RateLimitDecision {
    const now = this.clock.now().getTime();
    const existing = this.buckets.get(key);

    if (!existing || now - existing.window_start_ms >= windowMs) {
      this.buckets.set(key, { window_start_ms: now, count: 1 });
      return { allowed: true, retry_after_seconds: 0 };
    }

    if (existing.count >= limit) {
      const retryAfterMs = Math.max(0, existing.window_start_ms + windowMs - now);
      return {
        allowed: false,
        retry_after_seconds: Math.ceil(retryAfterMs / 1000)
      };
    }

    existing.count += 1;
    this.buckets.set(key, existing);
    return { allowed: true, retry_after_seconds: 0 };
  }
}

