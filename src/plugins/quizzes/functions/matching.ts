/**
 * Answer checking. Pure functions, unit-tested in quizzes.test.ts.
 *
 * Typed answers are compared after normalising (case, accents, punctuation, extra spaces and a
 * leading "the/a/an"), with optional typo tolerance; numbers within a tolerance; multiple select
 * either all-or-nothing or with partial credit (right picks minus wrong picks, never below 0).
 */
import type { AnswerValue, QuizQuestion } from "./types.js";

/** "  The Eiffel-Tower! " -> "eiffel tower". */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) (?=\S)/, "");
}

/** Damerau-Levenshtein (optimal string alignment) distance, capped early once it passes `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** Typos allowed for an accepted answer of this (normalised) length: none under 5, 1 up to 8, 2 from 9. */
export function allowedTypos(length: number): number {
  if (length < 5) return 0;
  if (length < 9) return 1;
  return 2;
}

/** Whether a typed answer matches any accepted answer. Numbers inside answers must match exactly. */
export function matchTypedAnswer(input: string, accepted: string[], typoTolerance: boolean): boolean {
  const given = normalizeAnswer(input);
  if (!given) return false;
  for (const raw of accepted) {
    const want = normalizeAnswer(raw);
    if (!want) continue;
    if (given === want) return true;
    if (given.replace(/ /g, "") === want.replace(/ /g, "")) return true;
    if (!typoTolerance) continue;
    // Digits are facts ("1914" vs "1941"), so typo tolerance never forgives them.
    if (given.replace(/\D/g, "") !== want.replace(/\D/g, "")) continue;
    const max = allowedTypos(want.length);
    if (max > 0 && editDistance(given, want, max) <= max) return true;
  }
  return false;
}

/** Parses "1,234.5", "1 234,5" (comma decimal only when unambiguous), "-3", "1e3", "50%". Null when it isn't a number. */
export function parseNumberAnswer(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, "").replace(/%$/, "");
  if (!s) return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function matchNumberAnswer(value: number, answer: number | null, tolerance: number): boolean {
  if (answer === null || !Number.isFinite(value)) return false;
  const tol = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0);
  // A tiny epsilon so 0.1 + 0.2 style float noise never fails an exact answer.
  return Math.abs(value - answer) <= tol + 1e-9 * Math.max(1, Math.abs(answer));
}

/**
 * Credit (0..1) for a multiple-select answer. All or nothing unless partial credit is on, in which
 * case it's (right picks - wrong picks) / right options, floored at 0.
 */
export function multiSelectCredit(picked: string[], correctIds: string[], partial: boolean): number {
  const want = new Set(correctIds);
  const got = new Set(picked);
  if (!want.size) return 0;
  let right = 0;
  let wrong = 0;
  for (const id of got) {
    if (want.has(id)) right += 1;
    else wrong += 1;
  }
  if (right === want.size && wrong === 0) return 1;
  if (!partial) return 0;
  return Math.max(0, (right - wrong) / want.size);
}

export type GradeResult = { correct: boolean; credit: number };

/** Grades one answer for a graded quiz question. */
export function gradeAnswer(question: QuizQuestion, answer: AnswerValue): GradeResult {
  if (answer.kind === "none") return { correct: false, credit: 0 };
  switch (question.type) {
    case "single":
    case "truefalse": {
      if (answer.kind !== "options" || answer.optionIds.length !== 1) return { correct: false, credit: 0 };
      const option = question.options.find((o) => o.id === answer.optionIds[0]);
      const ok = Boolean(option?.correct);
      return { correct: ok, credit: ok ? 1 : 0 };
    }
    case "multi": {
      if (answer.kind !== "options") return { correct: false, credit: 0 };
      const credit = multiSelectCredit(
        answer.optionIds,
        question.options.filter((o) => o.correct).map((o) => o.id),
        question.partialCredit,
      );
      return { correct: credit >= 1, credit };
    }
    case "text": {
      if (answer.kind !== "text") return { correct: false, credit: 0 };
      const ok = matchTypedAnswer(answer.text, question.accepted, question.typoTolerance);
      return { correct: ok, credit: ok ? 1 : 0 };
    }
    case "number": {
      const value = answer.kind === "number" ? answer.value : answer.kind === "text" ? parseNumberAnswer(answer.text) : null;
      const ok = value !== null && matchNumberAnswer(value, question.numberAnswer, question.numberTolerance);
      return { correct: ok, credit: ok ? 1 : 0 };
    }
  }
}

/** The right answer as display text ("Paris", "A, C" style labels resolved by the caller). */
export function correctAnswerText(question: QuizQuestion): string {
  switch (question.type) {
    case "single":
    case "truefalse":
    case "multi":
      return question.options
        .filter((o) => o.correct)
        .map((o) => o.text)
        .join(", ");
    case "text":
      return question.accepted[0] ?? "";
    case "number": {
      if (question.numberAnswer === null) return "";
      const n = formatNumber(question.numberAnswer);
      return question.numberTolerance > 0 ? `${n} (give or take ${formatNumber(question.numberTolerance)})` : n;
    }
  }
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** What the member answered, as display text. */
export function answerText(question: QuizQuestion, answer: AnswerValue): string {
  if (answer.kind === "none") return "No answer";
  if (answer.kind === "options") {
    const texts = answer.optionIds.map((id) => question.options.find((o) => o.id === id)?.text ?? "Removed option");
    return texts.length ? texts.join(", ") : "No answer";
  }
  if (answer.kind === "number") return formatNumber(answer.value);
  return answer.text.trim() || "No answer";
}
