import RE2 from "re2";
import { MAX_TESTED_CONTENT_LENGTH, validateRegexPatternSync } from "./regexSafety.js";
import { getLogger } from "./logger.js";
const log = getLogger("core");

const cache = new Map<string, RegExp | null>();
const CACHE_LIMIT = 500;

/** Patterns already logged as rejected, so a hot loop doesn't spam the console every message. */
const warnedRejections = new Set<string>();

export type CompileUserRegexOptions = {
  /** Default true so regex matches the same way as contains / exact. */
  caseInsensitive?: boolean;
};

/**
 * Compiles a user-supplied pattern with RE2 (Google's linear-time regex engine) instead of the
 * native `RegExp`, so a match can never hit catastrophic backtracking no matter how the pattern
 * is shaped ((a+)+, (b+){10}, or anything else). That's what actually makes the hot path safe,
 * not the static scan below, which is a heuristic and known to miss shapes like bounded nested
 * quantifiers. The static scan still runs first as a cheap, clearer-error early reject for the
 * obvious cases; RE2 is the real guarantee underneath it.
 *
 * Only `.test()` is ever called on the result, and flags are always "" or "i" (never "g"/"y"),
 * matching `userRegexMatches` below exactly, keep it that way. RE2's own known CVEs
 * (GHSA-ff84-5f28-78qj, GHSA-6hxr-mr5r-9836, GHSA-j4r3-hg7j-8chg, GHSA-8hcv-x26h-mcgp) all require
 * a sticky/global regex with a manipulated `lastIndex`, a global `.match()`, or `.replace()`/
 * `.split()` on a Buffer, none of which this module does. If a future change needs `.exec()`,
 * `.replace()`, `.split()`, `.match()`, or the `g`/`y` flags here, re-check those advisories first.
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
        compiled = new RE2(pattern, flags);
      } catch {
        compiled = null;
      }
    } else if (!warnedRejections.has(cacheKey)) {
      warnedRejections.add(cacheKey);
      log.error(`Rejected unsafe user regex pattern (${validation.error}): ${pattern}`);
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
