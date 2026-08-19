const cache = new Map<string, RegExp | null>();
const CACHE_LIMIT = 500;

export type CompileUserRegexOptions = {
  /** Default true so regex matches the same way as contains / exact. */
  caseInsensitive?: boolean;
};

export function compileUserRegex(raw: string, options?: CompileUserRegexOptions): RegExp | null {
  const pattern = raw.trim();
  const caseInsensitive = options?.caseInsensitive !== false;
  const cacheKey = `${caseInsensitive ? "i" : "s"}:${pattern}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let compiled: RegExp | null = null;
  if (pattern) {
    try {
      compiled = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch {
      compiled = null;
    }
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, compiled);
  return compiled;
}

export function userRegexMatches(
  content: string,
  pattern: string,
  options?: CompileUserRegexOptions,
): boolean {
  const re = compileUserRegex(pattern, options);
  return re ? re.test(content) : false;
}
