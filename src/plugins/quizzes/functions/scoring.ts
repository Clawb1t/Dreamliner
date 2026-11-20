/**
 * Scoring: attempt totals, pass/fail, personality outcomes and live trivia points. Pure functions,
 * unit-tested in quizzes.test.ts.
 */
import type { AnswerValue, QuizOutcome, QuizQuestion } from "./types.js";

/** Grace for network lag before a timed answer counts as late. */
export const LATE_GRACE_MS = 1500;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Points for one graded answer. Late answers score nothing. */
export function pointsFor(question: QuizQuestion, credit: number, late: boolean): number {
  if (late) return 0;
  return round2(Math.max(0, Math.min(1, credit)) * Math.max(0, question.points));
}

/** Effective per-question limit in seconds (question override, else quiz default). 0 = none. */
export function questionLimitSec(question: Pick<QuizQuestion, "timeLimitSec">, quizDefaultSec: number): number {
  return question.timeLimitSec > 0 ? question.timeLimitSec : Math.max(0, quizDefaultSec);
}

/**
 * Whether an answer arriving at `now` is late. Per-question limit counts from when the question was
 * shown; a whole-quiz deadline also applies. A small grace covers Discord round trips.
 */
export function isLate(input: { now: number; questionStartedAt: number | null; limitSec: number; deadlineAt: number | null }): boolean {
  if (input.deadlineAt !== null && input.now > input.deadlineAt + LATE_GRACE_MS) return true;
  if (input.limitSec > 0 && input.questionStartedAt !== null && input.now > input.questionStartedAt + input.limitSec * 1000 + LATE_GRACE_MS) return true;
  return false;
}

export type ScoredAnswer = { questionId: number; credit: number; points: number; correct: boolean | null; late: boolean; timedOut: boolean };

export type AttemptTotals = {
  score: number;
  maxScore: number;
  percent: number;
  correctCount: number;
  bestStreak: number;
};

/** Totals over the questions this attempt was asked (unanswered ones count as wrong). */
export function attemptTotals(asked: QuizQuestion[], answers: ScoredAnswer[]): AttemptTotals {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let streak = 0;
  let bestStreak = 0;
  for (const q of asked) {
    maxScore += Math.max(0, q.points);
    const a = byId.get(q.id);
    const right = Boolean(a && a.correct && !a.late);
    if (a) score += a.points;
    if (right) {
      correctCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
    }
  }
  score = round2(score);
  maxScore = round2(maxScore);
  const percent = maxScore > 0 ? round2((score / maxScore) * 100) : 0;
  return { score, maxScore, percent, correctCount, bestStreak };
}

export function hasPassed(percent: number, passPercent: number): boolean | null {
  if (!passPercent || passPercent <= 0) return null;
  return percent + 1e-9 >= passPercent;
}

/** Points each outcome collected from the chosen options. */
export function outcomeTallies(asked: QuizQuestion[], answers: { questionId: number; answer: AnswerValue }[]): Map<string, number> {
  const tally = new Map<string, number>();
  const byId = new Map(asked.map((q) => [q.id, q]));
  for (const a of answers) {
    if (a.answer.kind !== "options") continue;
    const q = byId.get(a.questionId);
    if (!q) continue;
    for (const optionId of a.answer.optionIds) {
      const option = q.options.find((o) => o.id === optionId);
      if (!option) continue;
      for (const [outcomeId, pts] of Object.entries(option.outcomes ?? {})) {
        if (!Number.isFinite(pts) || pts <= 0) continue;
        tally.set(outcomeId, (tally.get(outcomeId) ?? 0) + pts);
      }
    }
  }
  return tally;
}

/**
 * The personality result: the outcome with the most points. Ties go to the outcome that won the
 * most recent tied question (the last answer that gave points to a tied outcome), then to the
 * outcome listed first, so the same answers always give the same result.
 */
export function resolveOutcome(
  outcomes: QuizOutcome[],
  asked: QuizQuestion[],
  answers: { questionId: number; answer: AnswerValue }[],
): QuizOutcome | null {
  if (!outcomes.length) return null;
  const tally = outcomeTallies(asked, answers);
  let best = -1;
  for (const o of outcomes) best = Math.max(best, tally.get(o.id) ?? 0);
  const tied = outcomes.filter((o) => (tally.get(o.id) ?? 0) === best);
  if (tied.length === 1) return tied[0]!;
  const tiedIds = new Set(tied.map((o) => o.id));
  const byId = new Map(asked.map((q) => [q.id, q]));
  for (let i = answers.length - 1; i >= 0; i--) {
    const a = answers[i]!;
    if (a.answer.kind !== "options") continue;
    const q = byId.get(a.questionId);
    if (!q) continue;
    let top: { id: string; pts: number } | null = null;
    for (const optionId of a.answer.optionIds) {
      const option = q.options.find((o) => o.id === optionId);
      for (const [outcomeId, pts] of Object.entries(option?.outcomes ?? {})) {
        if (!tiedIds.has(outcomeId) || pts <= 0) continue;
        if (!top || pts > top.pts) top = { id: outcomeId, pts };
      }
    }
    if (top) return tied.find((o) => o.id === top!.id) ?? tied[0]!;
  }
  return tied[0]!;
}

// -- Live trivia ---------------------------------------------------------------------------------

export const LIVE_BASE_POINTS = 1000;
export const LIVE_STREAK_STEP = 100;
export const LIVE_STREAK_MAX = 500;

/**
 * Points for a live answer. Right answers earn 1000, scaled between 50% and 100% by speed when the
 * speed bonus is on, plus 100 per answer in the current streak beyond the first (max +500).
 * `streakBefore` is the player's streak before this answer.
 */
export function livePoints(input: { correct: boolean; timeMs: number; limitMs: number; speedBonus: boolean; streakBefore: number }): number {
  if (!input.correct) return 0;
  const limit = Math.max(1, input.limitMs);
  const t = Math.max(0, Math.min(limit, input.timeMs));
  const base = input.speedBonus ? Math.round(LIVE_BASE_POINTS * (1 - (t / limit) * 0.5)) : LIVE_BASE_POINTS;
  const streakBonus = Math.min(LIVE_STREAK_MAX, Math.max(0, input.streakBefore) * LIVE_STREAK_STEP);
  return base + streakBonus;
}

export type LiveStanding = { userId: string; score: number; correctCount: number; joinedAt: number };

/** Live leaderboard order: score, then right answers, then who joined first. */
export function rankLive<T extends LiveStanding>(players: T[]): T[] {
  return [...players].sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.joinedAt - b.joinedAt);
}

/** Leaderboard order for solo attempts: score, then fastest, then earliest finish. */
export function compareAttempts(
  a: { score: number; durationMs: number | null; finishedAt: number | null },
  b: { score: number; durationMs: number | null; finishedAt: number | null },
): number {
  return b.score - a.score || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity) || (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity);
}

/** "3 in a row!" style callouts at these streak lengths. */
export function streakCallout(streak: number): string | null {
  if (streak >= 10 && streak % 5 === 0) return `${streak} in a row. Unstoppable!`;
  if (streak === 7) return "7 in a row. On fire!";
  if (streak === 5) return "5 in a row!";
  if (streak === 3) return "3 in a row!";
  return null;
}
