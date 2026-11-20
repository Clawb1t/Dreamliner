/**
 * Quiz component ids. Answers carry only the attempt (or game), the question index and the index
 * of the option as shown on screen; which option that is lives in server-side state (the attempt's
 * seed), so nothing about the right answer is ever in a custom id.
 */
export const QUIZ_PREFIX = "dl:quiz:";

export type QuizCustomId =
  | { kind: "start"; quizId: number }
  | { kind: "begin"; quizId: number }
  | { kind: "leaderboard"; quizId: number }
  | { kind: "answer"; attemptId: number; index: number; option: number }
  | { kind: "multi"; attemptId: number; index: number }
  | { kind: "type"; attemptId: number; index: number }
  | { kind: "modal"; attemptId: number; index: number }
  | { kind: "next"; attemptId: number; index: number }
  | { kind: "review"; attemptId: number; page: number }
  | { kind: "results"; attemptId: number }
  | { kind: "liveAnswer"; gameId: number; index: number; option: number }
  | { kind: "liveGo"; gameId: number }
  | { kind: "liveStop"; gameId: number }
  | { kind: "liveMe"; gameId: number };

const CODES: Record<QuizCustomId["kind"], string> = {
  start: "start",
  begin: "begin",
  leaderboard: "lb",
  answer: "a",
  multi: "ms",
  type: "ty",
  modal: "md",
  next: "n",
  review: "rv",
  results: "res",
  liveAnswer: "la",
  liveGo: "lgo",
  liveStop: "lx",
  liveMe: "lme",
};

const FIELDS: Record<QuizCustomId["kind"], string[]> = {
  start: ["quizId"],
  begin: ["quizId"],
  leaderboard: ["quizId"],
  answer: ["attemptId", "index", "option"],
  multi: ["attemptId", "index"],
  type: ["attemptId", "index"],
  modal: ["attemptId", "index"],
  next: ["attemptId", "index"],
  review: ["attemptId", "page"],
  results: ["attemptId"],
  liveAnswer: ["gameId", "index", "option"],
  liveGo: ["gameId"],
  liveStop: ["gameId"],
  liveMe: ["gameId"],
};

export function quizId(id: QuizCustomId): string {
  const values = FIELDS[id.kind].map((f) => String((id as unknown as Record<string, number>)[f]));
  return `${QUIZ_PREFIX}${CODES[id.kind]}:${values.join(":")}`;
}

export function parseQuizId(customId: string): QuizCustomId | null {
  if (!customId.startsWith(QUIZ_PREFIX)) return null;
  const [code, ...parts] = customId.slice(QUIZ_PREFIX.length).split(":");
  const kind = (Object.keys(CODES) as QuizCustomId["kind"][]).find((k) => CODES[k] === code);
  if (!kind) return null;
  const fields = FIELDS[kind];
  if (parts.length !== fields.length) return null;
  const out: Record<string, unknown> = { kind };
  for (let i = 0; i < fields.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0) return null;
    out[fields[i]!] = n;
  }
  return out as QuizCustomId;
}
