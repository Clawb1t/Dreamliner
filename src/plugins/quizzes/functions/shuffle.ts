/**
 * Deterministic per-attempt randomness: the attempt stores a seed, and the question pool, question
 * order and every question's option order are derived from it. The same attempt always shows the
 * same order (so resuming or re-rendering never reshuffles), while each attempt gets its own.
 */
import { createHash, randomBytes } from "node:crypto";
import type { QuizOption, QuizQuestion, QuizSettings } from "./types.js";

export function newSeed(): string {
  return randomBytes(12).toString("hex");
}

/** mulberry32 seeded from a SHA-256 of the seed and a salt. */
export function seededRandom(seed: string, salt = ""): () => number {
  const digest = createHash("sha256").update(`${seed}:${salt}`).digest();
  let a = digest.readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The question ids an attempt asks, in order. With a pool size, a random N of the questions are
 * picked (then kept in quiz order unless questions are shuffled too).
 */
export function pickQuestionOrder(questions: Pick<QuizQuestion, "id" | "position">[], settings: Pick<QuizSettings, "poolSize" | "shuffleQuestions">, seed: string): number[] {
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  let picked = ordered;
  if (settings.poolSize > 0 && settings.poolSize < ordered.length) {
    const chosen = new Set(shuffled(ordered, seededRandom(seed, "pool")).slice(0, settings.poolSize).map((q) => q.id));
    picked = ordered.filter((q) => chosen.has(q.id));
  }
  if (settings.shuffleQuestions) picked = shuffled(picked, seededRandom(seed, "order"));
  return picked.map((q) => q.id);
}

/** The options of one question in the order this attempt shows them. True/false never shuffles. */
export function optionOrder(question: Pick<QuizQuestion, "id" | "type" | "options">, shuffleAnswers: boolean, seed: string): QuizOption[] {
  if (!shuffleAnswers || question.type === "truefalse") return [...question.options];
  return shuffled(question.options, seededRandom(seed, `q${question.id}`));
}
