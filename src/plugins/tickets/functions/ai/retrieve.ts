import type { KnowledgeEntry } from "./store.js";

/**
 * Picks the knowledge entries most relevant to a ticket, so the prompt carries what matters rather
 * than a server's whole knowledge base. Plain keyword scoring (BM25-style weights): entries are
 * short and server-specific, so this finds the right ones without an embeddings service.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does did for from get got has have hi hello hey how i if in " +
    "into is it its just me my no not of on or our please so some than that the their them then there these they " +
    "this to too up us was we were what when where which who why will with would you your yours im ive dont cant " +
    "thanks thank help need want also about any all am"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[a-z0-9][a-z0-9_'-]{1,}/g) ?? [])
    .map((token) => token.replace(/'s$/, "").replace(/'/g, ""))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/** A light stemmer: enough to match "ban"/"banned"/"bans", "role"/"roles". */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export type RankedKnowledge = { entry: KnowledgeEntry; score: number };

/**
 * Up to `limit` entries, best first, that fit in `charBudget` characters. FAQs and notes written
 * by staff get a small boost over automatic facts. Entries with no overlap at all are left out,
 * except that short knowledge bases are included whole (they're cheap, and often all relevant).
 */
export function rankKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  options: { limit?: number; charBudget?: number; includeAllUnder?: number } = {},
): RankedKnowledge[] {
  const limit = options.limit ?? 14;
  const charBudget = options.charBudget ?? 9000;
  const includeAllUnder = options.includeAllUnder ?? 2500;
  if (entries.length === 0) return [];

  const totalChars = entries.reduce((sum, e) => sum + e.title.length + e.content.length, 0);
  const queryTokens = new Set(tokenize(query));

  const docs = entries.map((entry) => ({ entry, tokens: tokenize(`${entry.title} ${entry.title} ${entry.content}`) }));
  const docFreq = new Map<string, number>();
  for (const doc of docs) for (const token of new Set(doc.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  const avgLength = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length || 1;

  const k1 = 1.4;
  const b = 0.75;
  const ranked: RankedKnowledge[] = docs.map(({ entry, tokens }) => {
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const freq = tf.get(token);
      if (!freq) continue;
      const df = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * tokens.length) / avgLength)));
    }
    if (score > 0 && (entry.kind === "faq" || entry.kind === "note")) score *= 1.25;
    return { entry, score };
  });

  const pool =
    totalChars <= includeAllUnder ? ranked : ranked.filter((item) => item.score > 0);
  pool.sort((a, b2) => b2.score - a.score || b2.entry.uses - a.entry.uses);

  const out: RankedKnowledge[] = [];
  let used = 0;
  for (const item of pool) {
    const size = item.entry.title.length + item.entry.content.length + 20;
    if (out.length >= limit) break;
    if (used + size > charBudget) continue;
    out.push(item);
    used += size;
  }
  return out;
}
