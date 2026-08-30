import { MAX_TESTED_CONTENT_LENGTH, validateRegexPatternSync } from "./regexSafety.js";

const cache = new Map<string, RegExp | null>();
const CACHE_LIMIT = 500;

/** Patterns already logged as rejected, so a hot loop doesn't spam the console every message. */
const warnedRejections = new Set<string>();

export type CompileUserRegexOptions = {
  /** Default true so regex matches the same way as contains / exact. */
  caseInsensitive?: boolean;
};

/**
 * Compiles a user-supplied pattern, rejecting anything that fails the
 * catastrophic-backtracking static scan (see core/regexSafety.ts) before it
 * ever reaches `new RegExp`. This runs on every match attempt (cached), so
 * it also retroactively protects patterns that were saved before this check
 * existed — they simply stop matching instead of being able to hang the bot.
 */
export function compileUserRegex(raw: string, options?: CompileUserRegexOptions): RegExp | null {
  const pattern = raw.trim();
  const caseInsensitive = options?.caseInsensitive !== false;
  const flags = caseInsensitive ? "i" : "";
  const cacheKey = `${caseInsensitive ? "i" : "s"}:${pattern}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let compiled: RegExp | null = null;
  if (pattern) {
    const validation = validateRegexPatternSync(pattern, flags);
    if (validation.ok) {
      try {
        compiled = new RegExp(pattern, flags);
      } catch {
        compiled = null;
      }
    } else if (!warnedRejections.has(cacheKey)) {
      warnedRejections.add(cacheKey);
      console.error(`Rejected unsafe user regex pattern (${validation.error}): ${pattern}`);
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
  if (!re) return false;
  const bounded = content.length > MAX_TESTED_CONTENT_LENGTH ? content.slice(0, MAX_TESTED_CONTENT_LENGTH) : content;
  return re.test(bounded);
}
