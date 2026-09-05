/**
 * Name-similarity matching for Impersonation Detection. Impersonators lean on tricks a
 * plain string-equals check misses entirely: swapping a Latin letter for a Cyrillic/Greek
 * lookalike ("Mоderator" with a Cyrillic о), inserting zero-width characters, or just being
 * "off by one" (an extra underscore, a trailing "_" or "1"). Normalizing those away before
 * comparing, then scoring the remaining edit distance, catches all of that with one check.
 */

// Common confusable characters mapped to the Latin letter they're impersonating. Not
// exhaustive (full Unicode confusables tables run into the thousands) — covers the
// characters actually available on a normal keyboard/emoji picker, which is what this
// is for: catching someone who typed a lookalike, not academic completeness.
const CONFUSABLES: Record<string, string> = {
  а: "a", // Cyrillic a
  Α: "a",
  α: "a",
  ａ: "a",
  ь: "b",
  Β: "b",
  β: "b",
  ｂ: "b",
  с: "c",
  Ϲ: "c",
  ϲ: "c",
  ｃ: "c",
  ԁ: "d",
  ｄ: "d",
  е: "e", // Cyrillic e
  Ε: "e",
  ε: "e",
  ｅ: "e",
  ｆ: "f",
  ɡ: "g",
  ｇ: "g",
  һ: "h",
  Η: "h",
  ｈ: "h",
  і: "i", // Cyrillic i
  Ι: "i",
  ι: "i",
  ｉ: "i",
  ϳ: "j",
  ｊ: "j",
  Κ: "k",
  κ: "k",
  ｋ: "k",
  ⅼ: "l",
  ｌ: "l",
  м: "m",
  Μ: "m",
  μ: "m",
  ｍ: "m",
  ո: "n",
  Ν: "n",
  ν: "n",
  ｎ: "n",
  о: "o", // Cyrillic o
  Ο: "o",
  ο: "o",
  ｏ: "o",
  р: "p", // Cyrillic p
  Ρ: "p",
  ρ: "p",
  ｐ: "p",
  ԛ: "q",
  ｑ: "q",
  ｒ: "r",
  ѕ: "s", // Cyrillic s
  ｓ: "s",
  т: "t", // Cyrillic t
  Τ: "t",
  τ: "t",
  ｔ: "t",
  ս: "u",
  ｕ: "u",
  ѵ: "v",
  ｖ: "v",
  ԝ: "w",
  ｗ: "w",
  х: "x", // Cyrillic x
  Χ: "x",
  χ: "x",
  ｘ: "x",
  у: "y", // Cyrillic u/y
  Υ: "y",
  υ: "y",
  ｙ: "y",
  ｚ: "z",
  Ζ: "z",
  "０": "0",
  "１": "1",
  "２": "2",
  "３": "3",
  "４": "4",
  "５": "5",
  "６": "6",
  "７": "7",
  "８": "8",
  "９": "9",
};

/** Lowercases, strips accents/diacritics, zero-width characters, and common lookalike
 * Unicode, and collapses whitespace/punctuation runs — the form two names are compared in. */
export function normalizeIdentityName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining diacritics after NFKD decomposition
    .replace(new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]", "g"), "") // zero-width / bidi control chars
    .split("")
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Classic Levenshtein edit distance. Names are short (Discord caps them well under 100
 * chars), so the naive O(n*m) DP table is plenty fast — no need for a banded/optimized variant. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]!
          : 1 + Math.min(prev[j - 1]!, prev[j]!, curr[j - 1]!);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** 0-100 similarity between two raw (not yet normalized) names. 100 = identical after
 * normalization; falls off with edit distance relative to the longer name's length. */
export function nameSimilarityPercent(rawA: string, rawB: string): number {
  const a = normalizeIdentityName(rawA);
  const b = normalizeIdentityName(rawB);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.max(0, Math.round((1 - distance / maxLen) * 100));
}
