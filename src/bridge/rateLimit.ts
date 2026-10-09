/**
 * Rate limits for the dashboard bridge. The website runs on many short-lived serverless
 * instances, so its own limits are per instance; this process sees every request, so the
 * limits here are the authoritative ones.
 *
 * Sliding-window counters (the current window plus a weighted share of the last one), in memory.
 * Limits are set well above anything a person clicking around the dashboard does, so they only
 * ever catch scripts.
 */

type Window = { start: number; count: number; previous: number };

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one hit. `ok: false` means over the limit, with how long until a slot frees up. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const current = this.roll(key, now);
    const elapsed = (now - current.start) / this.windowMs;
    const estimate = current.previous * (1 - elapsed) + current.count;
    if (estimate >= this.limit) {
      return { ok: false, retryAfterMs: Math.max(1000, Math.ceil(this.windowMs * (1 - elapsed))) };
    }
    current.count += 1;
    return { ok: true };
  }

  /** Like take() without counting: whether a hit would be allowed right now. */
  check(key: string, now = Date.now()): boolean {
    const current = this.roll(key, now);
    const elapsed = (now - current.start) / this.windowMs;
    return current.previous * (1 - elapsed) + current.count < this.limit;
  }

  /** Forget a key (e.g. after a correct password, so typos before it don't count). */
  reset(key: string): void {
    this.windows.delete(key);
  }

  private roll(key: string, now: number): Window {
    let current = this.windows.get(key);
    if (!current) {
      if (this.windows.size > 50_000) this.prune(now);
      current = { start: now, count: 0, previous: 0 };
      this.windows.set(key, current);
      return current;
    }
    const passed = Math.floor((now - current.start) / this.windowMs);
    if (passed >= 1) {
      current.previous = passed === 1 ? current.count : 0;
      current.count = 0;
      current.start += passed * this.windowMs;
    }
    return current;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs * 2) this.windows.delete(key);
    }
  }
}

const MINUTE = 60_000;

/** Per signed-in user (the `userId` the website forwards from its session). */
const USER_BUCKETS = {
  read: new SlidingWindowLimiter(1200, MINUTE),
  write: new SlidingWindowLimiter(240, MINUTE),
  upload: new SlidingWindowLimiter(30, MINUTE),
  ai: new SlidingWindowLimiter(40, MINUTE),
};

/** Per server, for writes that don't say who's asking (or carry it in the body): 4x the above. */
const GUILD_BUCKETS = {
  read: new SlidingWindowLimiter(4800, MINUTE),
  write: new SlidingWindowLimiter(960, MINUTE),
  upload: new SlidingWindowLimiter(120, MINUTE),
  ai: new SlidingWindowLimiter(160, MINUTE),
};

type Bucket = keyof typeof USER_BUCKETS;

function bucketFor(method: string, pathname: string): Bucket {
  if (/\/ai(?:\/|$)/.test(pathname)) return "ai";
  if (method !== "GET" && /\/(?:assets|images|evidence|upload|avatar|banner|brand-art)(?:\/|$)/.test(pathname)) return "upload";
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/**
 * Checks one bridge request against the user (or server) limits. Returns null when it may
 * proceed, or the number of seconds to wait.
 */
export function bridgeRateLimit(method: string, url: URL): number | null {
  const bucket = bucketFor(method, url.pathname);
  const userId = url.searchParams.get("userId")?.trim();
  if (userId && /^\d{15,22}$/.test(userId)) {
    const result = USER_BUCKETS[bucket].take(userId);
    return result.ok ? null : Math.ceil(result.retryAfterMs / 1000);
  }
  // Anonymous reads (public server pages, leaderboards) aren't capped per server: a popular page
  // would hit it with real visitors. Those are cached and limited per IP on the website instead.
  if (bucket === "read") return null;
  const guildId = /^\/bridge\/guilds\/(\d+)/.exec(url.pathname)?.[1];
  if (guildId) {
    const result = GUILD_BUCKETS[bucket].take(guildId);
    return result.ok ? null : Math.ceil(result.retryAfterMs / 1000);
  }
  return null;
}

/** Wrong clip passwords: per clip, so guessing is slow no matter how many IPs it comes from. */
export const clipPasswordFailures = new SlidingWindowLimiter(20, 10 * MINUTE);
