/**
 * Pre-filters chat noise so auto-translate does not fire on emojis,
 * elongated slang ("alriiiight", "nooooo"), links, or other low-signal text.
 */

const CUSTOM_EMOJI_RE = /<a?:\w+:\d{5,20}>/g;
const MENTION_RE = /<@[!&]?\d{5,20}>/g;
const CHANNEL_RE = /<#\d{5,20}>/g;
const TIMESTAMP_RE = /<t:\d+(?::[tTdDfFR])?>/g;
const URL_RE = /https?:\/\/\S+/gi;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const SPOILER_RE = /\|\|[\s\S]*?\|\|/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;
const REGIONAL_FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F]/g;
/** Collapse 3+ repeated letters (alriiiight → alriight, nooooo → noo). */
const ELONGATION_RE = /(\p{L})\1{2,}/gu;

/** Minimum letters after cleanup before we bother detecting. */
export const MIN_DETECT_LETTERS = 10;
/** Prefer at least this many letter-bearing words, or enough letters alone. */
export const MIN_DETECT_WORDS = 3;

export function collapseElongatedLetters(text: string): string {
  return text.replace(ELONGATION_RE, "$1$1");
}

/** Strip Discord/chat noise that confuses language detection. */
export function stripDetectNoise(text: string): string {
  return text
    .replace(CODE_BLOCK_RE, " ")
    .replace(INLINE_CODE_RE, " ")
    .replace(SPOILER_RE, " ")
    .replace(CUSTOM_EMOJI_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(CHANNEL_RE, " ")
    .replace(TIMESTAMP_RE, " ")
    .replace(URL_RE, " ")
    .replace(UNICODE_EMOJI_RE, " ")
    .replace(REGIONAL_FLAG_RE, " ")
    .replace(VARIATION_SELECTORS_RE, " ")
    .replace(/[_*~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countLetters(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

export function countLetterWords(text: string): number {
  return text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
}

/**
 * Returns cleaned text suitable for language detection, or null when the
 * message does not have enough real language signal.
 */
export function prepareForLanguageDetect(raw: string): string | null {
  const cleaned = collapseElongatedLetters(stripDetectNoise(raw));
  if (!cleaned) return null;

  const letters = countLetters(cleaned);
  const words = countLetterWords(cleaned);

  // Single elongated/slang tokens ("okkkkk", "bruhhhhh") and emoji leftovers.
  if (letters < MIN_DETECT_LETTERS && words < MIN_DETECT_WORDS) return null;
  if (letters < 8) return null;

  // Mostly punctuation / digits after cleanup.
  if (letters / Math.max(cleaned.length, 1) < 0.45) return null;

  return cleaned;
}

function normalizeComparable(text: string): string {
  return collapseElongatedLetters(stripDetectNoise(text))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when Google actually changed the wording — false positives usually
 * leave the string effectively unchanged ("okkkkk" → "okkkkk").
 */
export function isMeaningfulTranslation(source: string, translated: string): boolean {
  const a = normalizeComparable(source);
  const b = normalizeComparable(translated);
  if (!a || !b) return false;
  if (a === b) return false;

  // Tiny edits only (punctuation / one char) are not worth offering.
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinLimited(a, b, Math.ceil(maxLen * 0.2) + 2);
  if (distance < 0) return true; // edited beyond the low threshold
  if (maxLen <= 4) return distance >= 2;
  return distance / maxLen >= 0.18;
}

/** Early-exit Levenshtein; returns -1 once edits exceed `limit`. */
function levenshteinLimited(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return -1;

  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let curr = new Array<number>(cols);

  for (let j = 0; j < cols; j++) prev[j] = j;

  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > limit) return -1;
    [prev, curr] = [curr, prev];
  }

  const dist = prev[b.length]!;
  return dist > limit ? -1 : dist;
}
