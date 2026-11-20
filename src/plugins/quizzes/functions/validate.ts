/**
 * Cleans and validates quiz input from the dashboard (and from import / Autopilot drafts). Clamps
 * numbers, trims text, fixes ids, and returns the first problem as a readable error. Pure.
 */
import {
  DEFAULT_QUIZ_SETTINGS,
  QUESTION_TYPES,
  QUIZ_LIMITS,
  REVEAL_MODES,
  type QuestionType,
  type QuizKind,
  type QuizOption,
  type QuizOutcome,
  type QuizQuestion,
  type QuizSettings,
} from "./types.js";

const SNOWFLAKE = /^\d{15,22}$/;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function num(value: unknown, fallback: number | null): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function ids(value: unknown, max = 25): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && SNOWFLAKE.test(v)))].slice(0, max);
}

/** https only (Discord won't render anything else), or empty. */
export function cleanUrl(value: unknown): string {
  const raw = str(value, QUIZ_LIMITS.url);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function cleanColor(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim())) return parseInt(value.trim().replace("#", ""), 16);
  return null;
}

export function normalizeSettings(raw: unknown, base: QuizSettings = DEFAULT_QUIZ_SETTINGS): QuizSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const resultsRaw = typeof s.resultsChannelId === "string" ? s.resultsChannelId.trim() : base.resultsChannelId;
  return {
    shuffleQuestions: bool(s.shuffleQuestions, base.shuffleQuestions),
    shuffleAnswers: bool(s.shuffleAnswers, base.shuffleAnswers),
    poolSize: int(s.poolSize, 0, QUIZ_LIMITS.questions, base.poolSize),
    questionTimeLimitSec: int(s.questionTimeLimitSec, 0, QUIZ_LIMITS.questionSeconds, base.questionTimeLimitSec),
    quizTimeLimitSec: int(s.quizTimeLimitSec, 0, QUIZ_LIMITS.quizSeconds, base.quizTimeLimitSec),
    maxAttempts: int(s.maxAttempts, 0, QUIZ_LIMITS.attempts, base.maxAttempts),
    cooldownMinutes: int(s.cooldownMinutes, 0, QUIZ_LIMITS.cooldownMinutes, base.cooldownMinutes),
    requiredRoleIds: s.requiredRoleIds !== undefined ? ids(s.requiredRoleIds) : base.requiredRoleIds,
    blockedRoleIds: s.blockedRoleIds !== undefined ? ids(s.blockedRoleIds) : base.blockedRoleIds,
    revealMode: REVEAL_MODES.includes(s.revealMode as never) ? (s.revealMode as QuizSettings["revealMode"]) : base.revealMode,
    allowReview: bool(s.allowReview, base.allowReview),
    passPercent: int(s.passPercent, 0, 100, base.passPercent),
    passRoleId: typeof s.passRoleId === "string" ? (SNOWFLAKE.test(s.passRoleId) ? s.passRoleId : "") : base.passRoleId,
    resultsChannelId: resultsRaw === "none" || resultsRaw === "" || SNOWFLAKE.test(resultsRaw) ? resultsRaw : "",
    dmResult: bool(s.dmResult, base.dmResult),
    showLeaderboard: bool(s.showLeaderboard, base.showLeaderboard),
  };
}

function cleanOutcomeWeights(raw: unknown, outcomeIds: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!outcomeIds.has(key)) continue;
    const n = int(value, 0, QUIZ_LIMITS.outcomeWeight, 0);
    if (n > 0) out[key] = n;
  }
  return out;
}

export function normalizeOutcomes(raw: unknown): QuizOutcome[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuizOutcome[] = [];
  for (const item of raw.slice(0, QUIZ_LIMITS.outcomes)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let id = str(o.id, 24).replace(/[^a-z0-9_-]/gi, "");
    if (!id || seen.has(id)) id = `r${out.length + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    out.push({
      id,
      title: str(o.title, QUIZ_LIMITS.outcomeTitle),
      description: str(o.description, QUIZ_LIMITS.outcomeDescription),
      imageUrl: cleanUrl(o.imageUrl),
      roleId: typeof o.roleId === "string" && SNOWFLAKE.test(o.roleId) ? o.roleId : "",
      color: cleanColor(o.color),
    });
  }
  return out;
}

/** One question, cleaned. Unknown types become single choice; truefalse always gets True/False. */
export function normalizeQuestion(raw: unknown, position: number, outcomeIds: Set<string>): QuizQuestion {
  const q = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type: QuestionType = QUESTION_TYPES.includes(q.type as QuestionType) ? (q.type as QuestionType) : "single";
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const usedIds = new Set<string>();
  let options: QuizOption[] = rawOptions.slice(0, QUIZ_LIMITS.options).map((item, i) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    let id = str(o.id, 16).replace(/[^a-z0-9_-]/gi, "");
    if (!id || usedIds.has(id)) id = `o${i + 1}`;
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);
    return { id, text: str(o.text, QUIZ_LIMITS.option), correct: o.correct === true, outcomes: cleanOutcomeWeights(o.outcomes, outcomeIds) };
  });
  if (type === "truefalse") {
    const trueOption = options.find((o) => /^true$/i.test(o.text));
    const falseOption = options.find((o) => /^false$/i.test(o.text));
    const trueCorrect = trueOption ? trueOption.correct : falseOption ? !falseOption.correct : (options[0]?.correct ?? true);
    const pick = (text: string) => options.find((o) => o.text.toLowerCase() === text.toLowerCase());
    options = [
      { id: pick("true")?.id ?? "t", text: "True", correct: trueCorrect, outcomes: pick("true")?.outcomes ?? {} },
      { id: pick("false")?.id ?? "f", text: "False", correct: !trueCorrect, outcomes: pick("false")?.outcomes ?? {} },
    ];
    if (options[0]!.id === options[1]!.id) options[1]!.id = `${options[1]!.id}2`;
  }
  if (type === "single") {
    // Exactly one correct: keep the first marked one.
    let seenCorrect = false;
    options = options.map((o) => {
      if (o.correct && !seenCorrect) {
        seenCorrect = true;
        return o;
      }
      return { ...o, correct: false };
    });
  }
  if (type === "text" || type === "number") options = [];
  const accepted =
    type === "text"
      ? [...new Set((Array.isArray(q.accepted) ? q.accepted : []).map((a) => str(a, QUIZ_LIMITS.acceptedLength)).filter(Boolean))].slice(0, QUIZ_LIMITS.accepted)
      : [];
  return {
    id: int(q.id, 0, Number.MAX_SAFE_INTEGER, 0),
    position,
    type,
    prompt: str(q.prompt, QUIZ_LIMITS.prompt),
    imageUrl: cleanUrl(q.imageUrl),
    explanation: str(q.explanation, QUIZ_LIMITS.explanation),
    points: int(q.points, 0, QUIZ_LIMITS.points, 1),
    timeLimitSec: int(q.timeLimitSec, 0, QUIZ_LIMITS.questionSeconds, 0),
    options,
    accepted,
    numberAnswer: type === "number" ? num(q.numberAnswer, null) : null,
    numberTolerance: type === "number" ? Math.max(0, num(q.numberTolerance, 0) ?? 0) : 0,
    partialCredit: type === "multi" ? bool(q.partialCredit, false) : false,
    typoTolerance: type === "text" ? bool(q.typoTolerance, true) : false,
  };
}

/** The first problem with this question for a quiz of `kind`, or null. `n` is 1-based for messages. */
export function questionProblem(q: QuizQuestion, kind: QuizKind, n: number): string | null {
  const label = `Question ${n}`;
  if (!q.prompt) return `${label} needs the question text.`;
  if (kind === "personality") {
    if (q.type !== "single" && q.type !== "multi") return `${label}: personality quizzes use single or multiple choice questions.`;
    if (q.options.length < 2) return `${label} needs at least 2 answers.`;
    if (q.options.some((o) => !o.text)) return `${label} has an empty answer.`;
    if (q.options.some((o) => !Object.keys(o.outcomes).length)) return `${label}: every answer needs to give points to at least one result.`;
    return uniqueProblem(q, label);
  }
  switch (q.type) {
    case "single":
    case "multi": {
      if (q.options.length < 2) return `${label} needs at least 2 answers.`;
      if (q.options.some((o) => !o.text)) return `${label} has an empty answer.`;
      const correct = q.options.filter((o) => o.correct).length;
      if (q.type === "single" && correct !== 1) return `${label} needs exactly one right answer.`;
      if (q.type === "multi" && correct < 1) return `${label} needs at least one right answer.`;
      return uniqueProblem(q, label);
    }
    case "truefalse":
      return null;
    case "text":
      return q.accepted.length ? null : `${label} needs at least one accepted answer.`;
    case "number":
      return q.numberAnswer === null ? `${label} needs the right number.` : null;
  }
}

function uniqueProblem(q: QuizQuestion, label: string): string | null {
  const texts = q.options.map((o) => o.text.toLowerCase());
  return new Set(texts).size === texts.length ? null : `${label} has two answers with the same text.`;
}

export type CleanQuiz = {
  kind: QuizKind;
  title: string;
  description: string;
  coverImageUrl: string;
  color: number | null;
  category: string;
  tags: string[];
  settings: QuizSettings;
  outcomes: QuizOutcome[];
  questions: QuizQuestion[];
  opensAt: Date | null;
  closesAt: Date | null;
};

function date(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Cleans a full quiz body. `current` supplies values for fields the body leaves out (PATCH).
 * `strict` (publishing) also requires a complete, answerable quiz.
 */
export function cleanQuizInput(
  body: Record<string, unknown>,
  current: CleanQuiz | null,
  options: { strict: boolean },
): { ok: true; quiz: CleanQuiz } | { ok: false; error: string } {
  const kind: QuizKind = body.kind === "personality" || body.kind === "graded" ? body.kind : (current?.kind ?? "graded");
  const title = body.title !== undefined ? str(body.title, QUIZ_LIMITS.title) : (current?.title ?? "");
  if (!title) return { ok: false, error: "Give the quiz a title." };
  const outcomes = body.outcomes !== undefined ? normalizeOutcomes(body.outcomes) : (current?.outcomes ?? []);
  const outcomeIds = new Set(outcomes.map((o) => o.id));
  const questions =
    body.questions !== undefined
      ? (Array.isArray(body.questions) ? body.questions : []).slice(0, QUIZ_LIMITS.questions).map((q, i) => normalizeQuestion(q, i, outcomeIds))
      : (current?.questions ?? []);
  if (Array.isArray(body.questions) && body.questions.length > QUIZ_LIMITS.questions) return { ok: false, error: `A quiz can have up to ${QUIZ_LIMITS.questions} questions.` };
  const settings = body.settings !== undefined ? normalizeSettings(body.settings, current?.settings ?? DEFAULT_QUIZ_SETTINGS) : (current?.settings ?? { ...DEFAULT_QUIZ_SETTINGS });
  const opensAt = date(body.opensAt);
  const closesAt = date(body.closesAt);
  const quiz: CleanQuiz = {
    kind,
    title,
    description: body.description !== undefined ? str(body.description, QUIZ_LIMITS.description) : (current?.description ?? ""),
    coverImageUrl: body.coverImageUrl !== undefined ? cleanUrl(body.coverImageUrl) : (current?.coverImageUrl ?? ""),
    color: body.color !== undefined ? cleanColor(body.color) : (current?.color ?? null),
    category: body.category !== undefined ? str(body.category, QUIZ_LIMITS.category) : (current?.category ?? ""),
    tags:
      body.tags !== undefined
        ? [...new Set((Array.isArray(body.tags) ? body.tags : []).map((t) => str(t, QUIZ_LIMITS.tag)).filter(Boolean))].slice(0, QUIZ_LIMITS.tags)
        : (current?.tags ?? []),
    settings,
    outcomes,
    questions,
    opensAt: opensAt === undefined ? (current?.opensAt ?? null) : opensAt,
    closesAt: closesAt === undefined ? (current?.closesAt ?? null) : closesAt,
  };
  if (kind === "personality") {
    quiz.settings = { ...quiz.settings, passPercent: 0, passRoleId: "", revealMode: "never" };
    // Points don't apply; keep them at 1 so totals stay sane if it's switched back.
    quiz.questions = quiz.questions.map((q) => ({ ...q, points: q.points || 1 }));
  }
  if (quiz.opensAt && quiz.closesAt && quiz.closesAt.getTime() <= quiz.opensAt.getTime()) return { ok: false, error: "The quiz has to close after it opens." };
  if (quiz.settings.poolSize > 0 && quiz.settings.poolSize > quiz.questions.length && quiz.questions.length > 0) {
    return { ok: false, error: `The question pool (${quiz.settings.poolSize}) is bigger than the number of questions (${quiz.questions.length}).` };
  }
  if (options.strict) {
    const problem = publishProblem(quiz);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, quiz };
}

/** Why a quiz can't be published yet, or null. */
export function publishProblem(quiz: Pick<CleanQuiz, "kind" | "questions" | "outcomes" | "settings">): string | null {
  if (!quiz.questions.length) return "Add at least one question before publishing.";
  if (quiz.kind === "personality") {
    if (quiz.outcomes.length < 2) return "Personality quizzes need at least 2 results.";
    if (quiz.outcomes.some((o) => !o.title)) return "Every result needs a title.";
  }
  for (let i = 0; i < quiz.questions.length; i++) {
    const problem = questionProblem(quiz.questions[i]!, quiz.kind, i + 1);
    if (problem) return problem;
  }
  if (quiz.kind === "graded" && quiz.questions.every((q) => q.points <= 0)) return "At least one question needs to be worth points.";
  return null;
}
