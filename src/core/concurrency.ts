/**
 * Small concurrency-limited helpers for batching expensive per-item work (Discord REST
 * fetches, mostly) instead of firing everything at once — a leaderboard/stats payload
 * resolving 15-50 users in one giant `Promise.all` can trip Discord's rate limiter and
 * stalls the whole response on the slowest straggler. A worker-pool keeps a fixed number
 * in flight at a time (batches of N, back to back) without idling between batches.
 */

/**
 * Run `mapper` over `items` with at most `limit` calls in flight at once. Equivalent in
 * spirit to processing fixed-size batches ("5 then the next 5, ...") but keeps `limit`
 * workers continuously busy instead of waiting for every item in a batch before starting
 * the next one, so a single slow item doesn't stall items behind it in later batches.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
