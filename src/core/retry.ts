export type RetryOptions = {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Base delay between attempts, multiplied by the attempt number (linear backoff). Default 350ms. */
  delayMs?: number;
  onError?: (error: unknown, attempt: number) => void;
};

/**
 * Retries an async operation a few times with a short linear backoff before giving up, instead
 * of treating a single failure as final. Meant for calls where a transient hiccup (rate limit,
 * network blip) shouldn't mean "never got this data" — e.g. a forced Discord REST fetch for a
 * user's banner, which otherwise silently and permanently stays unset for that process's
 * lifetime once one attempt fails. Resolves to `null` (never rejects) once every attempt has
 * failed, so callers can fall back gracefully.
 */
export async function retryAsync<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T | null> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 350;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      options.onError?.(error, attempt);
      if (attempt === attempts) return null;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return null;
}
