/**
 * Fuzzy word-pack matching for Automod.
 *
 * Catches obfuscation like:
 * - leetspeak: f0ck, sh1t, a$$
 * - spacing / punctuation: F - UCK, f.u.c.k, f_u_c_k
 * - elongation: fuuuuck, shiiit
 */

/** Spaced alphanumeric form used for duplicate/spam style checks. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/@/g, "a")
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "g")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Leet-tolerant character class for a base letter. */
function letterClass(ch: string): string {
  switch (ch) {
    case "a":
      return "[a4@]";
    case "b":
      return "[b8]";
    case "c":
      return "[c(¢]";
    case "e":
      return "[e3]";
    case "g":
      return "[g9]";
    case "i":
      return "[i1!|l]";
    case "o":
      return "[o0]";
    case "s":
      return "[s5$]";
    case "t":
      return "[t7+]";
    case "u":
      // 0 is a common stand-in in "f0ck"
      return "[uv0]";
    default:
      return escapeRegex(ch);
  }
}

const patternCache = new Map<string, RegExp>();

/**
 * Build a regex that matches `word` with optional junk between letters
 * and optional letter elongation (f+u+c+k), including leet substitutes.
 */
function fuzzyWordPattern(word: string): RegExp {
  const cached = patternCache.get(word);
  if (cached) return cached;

  const letters = [...word.toLowerCase()].filter((c) => c >= "a" && c <= "z");
  if (!letters.length) {
    const empty = /(?!)/;
    patternCache.set(word, empty);
    return empty;
  }

  // Separators between letters: spaces, punctuation, underscores, ZW*, etc.
  // Digits/symbols used as leet stay inside letter classes, not separators.
  const sep = "[^a-z0-9@$!|+]*";
  const body = letters.map((c) => `${letterClass(c)}+`).join(sep);
  const pattern = new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "i");
  patternCache.set(word, pattern);
  return pattern;
}

/** Return which pack words appear in `text` (deduped, pack order). */
export function matchWordPack(text: string, words: readonly string[]): string[] {
  if (!text.trim() || !words.length) return [];

  // ph → f helps "phuck"; keep original symbols for leet classes
  const haystack = text.toLowerCase().replace(/ph/g, "f");
  const spaced = normalizeForMatch(text);
  const tokens = new Set(spaced.split(" ").filter(Boolean));

  const hits: string[] = [];
  for (const word of words) {
    const w = word.toLowerCase();
    if (!w) continue;

    // Fast path: exact token after soft normalize
    if (
      tokens.has(w) ||
      spaced === w ||
      spaced.startsWith(`${w} `) ||
      spaced.endsWith(` ${w}`) ||
      spaced.includes(` ${w} `)
    ) {
      hits.push(word);
      continue;
    }

    // Fuzzy path: F - UCK, f.u.c.k, fuuuuck, sh1t, a$$, f0ck
    if (fuzzyWordPattern(w).test(haystack)) {
      hits.push(word);
    }
  }
  return hits;
}
