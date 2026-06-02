import { RateLimitInfo } from './platform-scan-adapter';

// In-memory pool of interchangeable platform tokens (e.g. several connected X
// accounts, or several Reddit app credentials). Spreads scan load across tokens
// so no single token carries the whole firehose — both a rate-limit ceiling and
// an anti-abuse signal when one token does everything.
//
// Selection is least-recently-used among tokens not currently cooling down.
// When a token hits a rate limit the caller reports it; that token is parked
// until its reset/retry time. Cool-down state is per-process (the durable
// per-unit back-off lives in EngageScanCursor.cooldownUntil).
//
// Time is injected (`now`) so the pool is deterministic under test.
export class TokenPool {
  private readonly lastUsedAt = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly tokens: string[],
    private readonly now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.tokens.length;
  }

  // Number of tokens usable right now (not cooling down).
  available(): number {
    const t = this.now();
    return this.tokens.filter((tok) => (this.cooldownUntil.get(tok) ?? 0) <= t).length;
  }

  // Pick the least-recently-used token that is not cooling down, or null when
  // every token is parked. Marks the chosen token as used now.
  acquire(): string | null {
    const t = this.now();
    const usable = this.tokens
      .filter((tok) => (this.cooldownUntil.get(tok) ?? 0) <= t)
      .sort((a, b) => (this.lastUsedAt.get(a) ?? 0) - (this.lastUsedAt.get(b) ?? 0));
    const chosen = usable[0];
    if (!chosen) return null;
    this.lastUsedAt.set(chosen, t);
    return chosen;
  }

  // Feed back the rate-limit outcome for a token. A hard limit parks the token
  // until its retry/reset time (default 60s when the platform gives no hint);
  // a near-empty remaining count parks it briefly until the window resets.
  report(token: string, rate: RateLimitInfo): void {
    const t = this.now();
    if (rate.limited) {
      const wait = rate.retryAfterMs ?? 60_000;
      this.cooldownUntil.set(token, t + Math.max(1_000, wait));
      return;
    }
    if (rate.remaining != null && rate.remaining <= 0 && rate.resetAt) {
      this.cooldownUntil.set(token, Math.max(t, rate.resetAt.getTime()));
    }
  }

  // Earliest time any token becomes usable again (for next-due estimation), or
  // null if a token is already available.
  nextAvailableAt(): Date | null {
    const t = this.now();
    if (this.available() > 0) return null;
    const soonest = Math.min(
      ...this.tokens.map((tok) => this.cooldownUntil.get(tok) ?? t)
    );
    return new Date(soonest);
  }
}
