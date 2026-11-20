/**
 * Quizzes data access. better-sqlite3 is synchronous, so these are plain functions; conditional
 * updates (`WHERE current_index = ?`) and primary keys make answering and finishing idempotent.
 * Every read that takes an id from outside is scoped by guild_id.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { quizAttemptAnswers, quizAttempts, quizEvents, quizLiveAnswers, quizLiveGames, quizLivePlayers, quizQuestions, quizzes } from "../../../db/schema.js";
import { normalizeOutcomes, normalizeSettings, type CleanQuiz } from "./validate.js";
import {
  DEFAULT_QUIZ_SETTINGS,
  type AnswerValue,
  type AttemptAnswer,
  type AttemptStatus,
  type LiveStatus,
  type QuestionType,
  type Quiz,
  type QuizAttempt,
  type QuizKind,
  type QuizOption,
  type QuizQuestion,
  type QuizStatus,
} from "./types.js";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type QuizRow = typeof quizzes.$inferSelect;
type QuestionRow = typeof quizQuestions.$inferSelect;
type AttemptRow = typeof quizAttempts.$inferSelect;
type AnswerRow = typeof quizAttemptAnswers.$inferSelect;
type LiveRow = typeof quizLiveGames.$inferSelect;

export function toQuiz(row: QuizRow): Quiz {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: (row.kind === "personality" ? "personality" : "graded") as QuizKind,
    status: row.status as QuizStatus,
    title: row.title,
    description: row.description,
    coverImageUrl: row.coverImageUrl,
    color: row.color ?? null,
    category: row.category,
    tags: parseJson<string[]>(row.tags, []),
    settings: normalizeSettings(parseJson(row.settings, {}), DEFAULT_QUIZ_SETTINGS),
    outcomes: normalizeOutcomes(parseJson(row.outcomes, [])),
    opensAt: row.opensAt ?? null,
    closesAt: row.closesAt ?? null,
    panelChannelId: row.panelChannelId ?? null,
    panelMessageId: row.panelMessageId ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

export function toQuestion(row: QuestionRow): QuizQuestion {
  const options = parseJson<QuizOption[]>(row.options, []).map((o) => ({ ...o, outcomes: o.outcomes ?? {}, correct: o.correct === true }));
  return {
    id: row.id,
    position: row.position,
    type: row.type as QuestionType,
    prompt: row.prompt,
    imageUrl: row.imageUrl,
    explanation: row.explanation,
    points: row.points,
    timeLimitSec: row.timeLimitSec,
    options,
    accepted: parseJson<string[]>(row.accepted, []),
    numberAnswer: row.numberAnswer ?? null,
    numberTolerance: row.numberTolerance,
    partialCredit: row.partialCredit,
    typoTolerance: row.typoTolerance,
  };
}

export function toAttempt(row: AttemptRow): QuizAttempt {
  return {
    id: row.id,
    guildId: row.guildId,
    quizId: row.quizId,
    userId: row.userId,
    status: row.status as AttemptStatus,
    seed: row.seed,
    questionOrder: parseJson<number[]>(row.questionOrder, []),
    currentIndex: row.currentIndex,
    questionStartedAt: row.questionStartedAt ?? null,
    awaitingNext: row.awaitingNext,
    score: row.score,
    maxScore: row.maxScore,
    percent: row.percent,
    passed: row.passed ?? null,
    outcomeId: row.outcomeId ?? null,
    correctCount: row.correctCount,
    streak: row.streak,
    bestStreak: row.bestStreak,
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt ?? null,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.durationMs ?? null,
    rewardRoleId: row.rewardRoleId ?? null,
  };
}

export function toAnswer(row: AnswerRow): AttemptAnswer {
  return {
    attemptId: row.attemptId,
    questionId: row.questionId,
    position: row.position,
    answer: parseJson<AnswerValue>(row.answer, { kind: "none" }),
    correct: row.correct ?? null,
    credit: row.credit,
    points: row.points,
    timeMs: row.timeMs,
    late: row.late,
    timedOut: row.timedOut,
    answeredAt: row.answeredAt,
  };
}

// -- Quizzes ---------------------------------------------------------------------------------------

export function listQuizzes(guildId: string): Quiz[] {
  return getDb().select().from(quizzes).where(eq(quizzes.guildId, guildId)).orderBy(desc(quizzes.createdAt)).all().map(toQuiz);
}

export function countQuizzes(guildId: string): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(quizzes).where(eq(quizzes.guildId, guildId)).get()?.n ?? 0;
}

export function getQuiz(guildId: string, id: number): Quiz | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = getDb().select().from(quizzes).where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id))).get();
  return row ? toQuiz(row) : null;
}

export function listQuestions(quizId: number): QuizQuestion[] {
  return getDb().select().from(quizQuestions).where(eq(quizQuestions.quizId, quizId)).orderBy(asc(quizQuestions.position), asc(quizQuestions.id)).all().map(toQuestion);
}

export function questionCounts(quizIds: number[]): Map<number, number> {
  if (!quizIds.length) return new Map();
  const rows = getDb()
    .select({ quizId: quizQuestions.quizId, n: sql<number>`count(*)` })
    .from(quizQuestions)
    .where(inArray(quizQuestions.quizId, quizIds))
    .groupBy(quizQuestions.quizId)
    .all();
  return new Map(rows.map((r) => [r.quizId, r.n]));
}

function questionValues(guildId: string, quizId: number, q: QuizQuestion, now: Date) {
  return {
    quizId,
    guildId,
    position: q.position,
    type: q.type,
    prompt: q.prompt,
    imageUrl: q.imageUrl,
    explanation: q.explanation,
    points: q.points,
    timeLimitSec: q.timeLimitSec,
    options: JSON.stringify(q.options),
    accepted: JSON.stringify(q.accepted),
    numberAnswer: q.numberAnswer,
    numberTolerance: q.numberTolerance,
    partialCredit: q.partialCredit,
    typoTolerance: q.typoTolerance,
    updatedAt: now,
  };
}

/**
 * Saves the question list: existing ids are updated in place (keeping their answers and
 * analytics), new ones inserted, and questions no longer in the list deleted.
 */
export function replaceQuestions(guildId: string, quizId: number, questions: QuizQuestion[]): void {
  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    const existing = new Set(tx.select({ id: quizQuestions.id }).from(quizQuestions).where(eq(quizQuestions.quizId, quizId)).all().map((r) => r.id));
    const kept = new Set<number>();
    questions.forEach((q, i) => {
      const values = questionValues(guildId, quizId, { ...q, position: i }, now);
      if (q.id && existing.has(q.id) && !kept.has(q.id)) {
        tx.update(quizQuestions).set(values).where(and(eq(quizQuestions.id, q.id), eq(quizQuestions.quizId, quizId))).run();
        kept.add(q.id);
      } else {
        tx.insert(quizQuestions).values({ ...values, createdAt: now }).run();
      }
    });
    const removed = [...existing].filter((id) => !kept.has(id));
    if (removed.length) tx.delete(quizQuestions).where(and(eq(quizQuestions.quizId, quizId), inArray(quizQuestions.id, removed))).run();
  });
}

export function createQuiz(guildId: string, clean: CleanQuiz, createdBy: string, status: QuizStatus): Quiz {
  const now = new Date();
  const row = getDb()
    .insert(quizzes)
    .values({
      guildId,
      kind: clean.kind,
      status,
      title: clean.title,
      description: clean.description,
      coverImageUrl: clean.coverImageUrl,
      color: clean.color,
      category: clean.category,
      tags: JSON.stringify(clean.tags),
      settings: JSON.stringify(clean.settings),
      outcomes: JSON.stringify(clean.outcomes),
      opensAt: clean.opensAt,
      closesAt: clean.closesAt,
      createdBy,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === "published" ? now : null,
    })
    .returning()
    .get();
  replaceQuestions(guildId, row.id, clean.questions);
  return toQuiz(row);
}

export function updateQuizFields(guildId: string, id: number, clean: CleanQuiz, questionsChanged: boolean): Quiz | null {
  const row = getDb()
    .update(quizzes)
    .set({
      kind: clean.kind,
      title: clean.title,
      description: clean.description,
      coverImageUrl: clean.coverImageUrl,
      color: clean.color,
      category: clean.category,
      tags: JSON.stringify(clean.tags),
      settings: JSON.stringify(clean.settings),
      outcomes: JSON.stringify(clean.outcomes),
      opensAt: clean.opensAt,
      closesAt: clean.closesAt,
      updatedAt: new Date(),
    })
    .where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id)))
    .returning()
    .get();
  if (!row) return null;
  if (questionsChanged) replaceQuestions(guildId, id, clean.questions);
  return toQuiz(row);
}

export function setQuizStatus(guildId: string, id: number, status: QuizStatus): Quiz | null {
  const now = new Date();
  const row = getDb()
    .update(quizzes)
    .set({ status, updatedAt: now, ...(status === "published" ? { publishedAt: now } : {}) })
    .where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id)))
    .returning()
    .get();
  return row ? toQuiz(row) : null;
}

export function setQuizPanel(guildId: string, id: number, channelId: string | null, messageId: string | null): void {
  getDb().update(quizzes).set({ panelChannelId: channelId, panelMessageId: messageId, lastError: null }).where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id))).run();
}

export function setQuizError(guildId: string, id: number, error: string | null): void {
  getDb().update(quizzes).set({ lastError: error ? error.slice(0, 300) : null }).where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id))).run();
}

export function clearSchedule(guildId: string, id: number, field: "opens" | "closes"): void {
  getDb()
    .update(quizzes)
    .set(field === "opens" ? { opensAt: null } : { closesAt: null })
    .where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id)))
    .run();
}

/** Deletes the quiz and everything under it. */
export function deleteQuiz(guildId: string, id: number): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const quiz = tx.select({ id: quizzes.id }).from(quizzes).where(and(eq(quizzes.guildId, guildId), eq(quizzes.id, id))).get();
    if (!quiz) return false;
    tx.delete(quizAttemptAnswers).where(eq(quizAttemptAnswers.quizId, id)).run();
    tx.delete(quizAttempts).where(eq(quizAttempts.quizId, id)).run();
    tx.delete(quizQuestions).where(eq(quizQuestions.quizId, id)).run();
    tx.delete(quizEvents).where(eq(quizEvents.quizId, id)).run();
    const games = tx.select({ id: quizLiveGames.id }).from(quizLiveGames).where(eq(quizLiveGames.quizId, id)).all().map((g) => g.id);
    if (games.length) {
      tx.delete(quizLiveAnswers).where(inArray(quizLiveAnswers.gameId, games)).run();
      tx.delete(quizLivePlayers).where(inArray(quizLivePlayers.gameId, games)).run();
      tx.delete(quizLiveGames).where(inArray(quizLiveGames.id, games)).run();
    }
    tx.delete(quizzes).where(eq(quizzes.id, id)).run();
    return true;
  });
}

/** Published quizzes whose close time passed, and published quizzes with a future/past open time. */
export function quizzesDueToClose(now: Date): Quiz[] {
  return getDb()
    .select()
    .from(quizzes)
    .where(and(eq(quizzes.status, "published"), isNotNull(quizzes.closesAt), lte(quizzes.closesAt, now)))
    .all()
    .map(toQuiz);
}

/** Published quizzes that just opened (opens_at passed) and have a panel to refresh. */
export function quizzesJustOpened(now: Date, since: Date): Quiz[] {
  return getDb()
    .select()
    .from(quizzes)
    .where(and(eq(quizzes.status, "published"), isNotNull(quizzes.opensAt), lte(quizzes.opensAt, now), gte(quizzes.opensAt, since)))
    .all()
    .map(toQuiz);
}

// -- Events ----------------------------------------------------------------------------------------

export function addEvent(guildId: string, quizId: number, kind: string, actorId: string | null, detail: string | null = null): void {
  getDb()
    .insert(quizEvents)
    .values({ guildId, quizId, kind, actorId, detail: detail ? detail.slice(0, 500) : null, createdAt: new Date() })
    .run();
}

export function listEvents(guildId: string, quizId: number, limit = 50) {
  return getDb()
    .select()
    .from(quizEvents)
    .where(and(eq(quizEvents.guildId, guildId), eq(quizEvents.quizId, quizId)))
    .orderBy(desc(quizEvents.createdAt), desc(quizEvents.id))
    .limit(limit)
    .all();
}

// -- Attempts --------------------------------------------------------------------------------------

export function getAttempt(guildId: string, id: number): QuizAttempt | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = getDb().select().from(quizAttempts).where(and(eq(quizAttempts.guildId, guildId), eq(quizAttempts.id, id))).get();
  return row ? toAttempt(row) : null;
}

export function getOpenAttempt(quizId: number, userId: string): QuizAttempt | null {
  const row = getDb()
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")))
    .get();
  return row ? toAttempt(row) : null;
}

export function memberAttemptStats(quizId: number, userId: string): { finished: number; lastFinishedAt: number | null } {
  const row = getDb()
    .select({ n: sql<number>`count(*)`, last: sql<number | null>`max(${quizAttempts.finishedAt})` })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId), ne(quizAttempts.status, "in_progress")))
    .get();
  return { finished: row?.n ?? 0, lastFinishedAt: row?.last ?? null };
}

/** Creates an attempt, or returns the member's open one if two Starts raced (partial unique index). */
export function createAttempt(input: {
  guildId: string;
  quizId: number;
  userId: string;
  seed: string;
  questionOrder: number[];
  maxScore: number;
  deadlineAt: Date | null;
}): QuizAttempt {
  const now = new Date();
  try {
    const row = getDb()
      .insert(quizAttempts)
      .values({
        guildId: input.guildId,
        quizId: input.quizId,
        userId: input.userId,
        status: "in_progress",
        seed: input.seed,
        questionOrder: JSON.stringify(input.questionOrder),
        currentIndex: 0,
        maxScore: input.maxScore,
        startedAt: now,
        deadlineAt: input.deadlineAt,
      })
      .returning()
      .get();
    return toAttempt(row);
  } catch (error) {
    const open = getOpenAttempt(input.quizId, input.userId);
    if (open) return open;
    throw error;
  }
}

/** Marks the current question as shown (starts its timer) unless it already was. */
export function markQuestionShown(attemptId: number, index: number, at: Date): boolean {
  const result = getDb()
    .update(quizAttempts)
    .set({ questionStartedAt: at })
    .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.currentIndex, index), eq(quizAttempts.status, "in_progress"), sql`${quizAttempts.questionStartedAt} IS NULL`))
    .run();
  return result.changes > 0;
}

/**
 * Records the answer to question `index` and moves the attempt on, atomically. Returns false when
 * this question was already answered (a double press, a second device): nothing changes.
 */
export function recordAnswer(input: {
  attempt: QuizAttempt;
  index: number;
  questionId: number;
  answer: AnswerValue;
  correct: boolean | null;
  credit: number;
  points: number;
  timeMs: number;
  late: boolean;
  timedOut: boolean;
  awaitNext: boolean;
}): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const moved = tx
      .update(quizAttempts)
      .set({
        currentIndex: input.index + 1,
        questionStartedAt: null,
        awaitingNext: input.awaitNext,
        score: sql`${quizAttempts.score} + ${input.points}`,
        correctCount: sql`${quizAttempts.correctCount} + ${input.correct && !input.late ? 1 : 0}`,
        streak: input.correct && !input.late ? sql`${quizAttempts.streak} + 1` : 0,
        bestStreak: input.correct && !input.late ? sql`max(${quizAttempts.bestStreak}, ${quizAttempts.streak} + 1)` : sql`${quizAttempts.bestStreak}`,
      })
      .where(and(eq(quizAttempts.id, input.attempt.id), eq(quizAttempts.currentIndex, input.index), eq(quizAttempts.status, "in_progress")))
      .run();
    if (moved.changes === 0) return false;
    tx.insert(quizAttemptAnswers)
      .values({
        attemptId: input.attempt.id,
        questionId: input.questionId,
        quizId: input.attempt.quizId,
        guildId: input.attempt.guildId,
        position: input.index,
        answer: JSON.stringify(input.answer),
        correct: input.correct,
        credit: input.credit,
        points: input.points,
        timeMs: Math.max(0, Math.round(input.timeMs)),
        late: input.late,
        timedOut: input.timedOut,
        answeredAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    return true;
  });
}

export function clearAwaitingNext(attemptId: number): void {
  getDb().update(quizAttempts).set({ awaitingNext: false }).where(eq(quizAttempts.id, attemptId)).run();
}

export function listAnswers(attemptId: number): AttemptAnswer[] {
  return getDb().select().from(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, attemptId)).orderBy(asc(quizAttemptAnswers.position)).all().map(toAnswer);
}

/** Closes an attempt with its final numbers. Only the first caller wins (status guard). */
export function finishAttempt(
  attemptId: number,
  status: Exclude<AttemptStatus, "in_progress">,
  totals: { score: number; maxScore: number; percent: number; passed: boolean | null; outcomeId: string | null; correctCount: number; bestStreak: number; durationMs: number },
): QuizAttempt | null {
  const row = getDb()
    .update(quizAttempts)
    .set({ status, ...totals, awaitingNext: false, finishedAt: new Date() })
    .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.status, "in_progress")))
    .returning()
    .get();
  return row ? toAttempt(row) : null;
}

export function setRewardRole(attemptId: number, roleId: string): void {
  getDb().update(quizAttempts).set({ rewardRoleId: roleId }).where(eq(quizAttempts.id, attemptId)).run();
}

/** Unfinished attempts whose whole-quiz deadline has passed (or that sat untouched for a day). */
export function staleOpenAttempts(now: Date): QuizAttempt[] {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  return getDb()
    .select()
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.status, "in_progress"),
        or(and(isNotNull(quizAttempts.deadlineAt), lte(quizAttempts.deadlineAt, new Date(now.getTime() - 60_000))), lte(quizAttempts.startedAt, dayAgo)),
      ),
    )
    .limit(200)
    .all()
    .map(toAttempt);
}

export type AttemptFilter = { quizId?: number; userId?: string; userIds?: string[]; status?: AttemptStatus | "finished"; offset?: number; limit?: number };

function attemptWhere(guildId: string, f: AttemptFilter) {
  const parts = [eq(quizAttempts.guildId, guildId)];
  if (f.quizId) parts.push(eq(quizAttempts.quizId, f.quizId));
  if (f.userId) parts.push(eq(quizAttempts.userId, f.userId));
  if (f.userIds) parts.push(f.userIds.length ? inArray(quizAttempts.userId, f.userIds) : sql`0`);
  if (f.status === "finished") parts.push(ne(quizAttempts.status, "in_progress"));
  else if (f.status) parts.push(eq(quizAttempts.status, f.status));
  return and(...parts);
}

export function listAttempts(guildId: string, f: AttemptFilter = {}): { attempts: QuizAttempt[]; total: number } {
  const where = attemptWhere(guildId, f);
  const total = getDb().select({ n: sql<number>`count(*)` }).from(quizAttempts).where(where).get()?.n ?? 0;
  const rows = getDb()
    .select()
    .from(quizAttempts)
    .where(where)
    .orderBy(desc(quizAttempts.startedAt), desc(quizAttempts.id))
    .limit(Math.min(500, Math.max(1, f.limit ?? 25)))
    .offset(Math.max(0, f.offset ?? 0))
    .all();
  return { attempts: rows.map(toAttempt), total };
}

export function deleteAttempt(guildId: string, id: number): QuizAttempt | null {
  const attempt = getAttempt(guildId, id);
  if (!attempt) return null;
  getDb().transaction((tx) => {
    tx.delete(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, id)).run();
    tx.delete(quizAttempts).where(and(eq(quizAttempts.guildId, guildId), eq(quizAttempts.id, id))).run();
  });
  return attempt;
}

/** Deletes every attempt on a quiz, or one member's. Returns how many went. */
export function resetAttempts(guildId: string, quizId: number, userId?: string): number {
  return getDb().transaction((tx) => {
    const where = and(eq(quizAttempts.guildId, guildId), eq(quizAttempts.quizId, quizId), ...(userId ? [eq(quizAttempts.userId, userId)] : []));
    const ids = tx.select({ id: quizAttempts.id }).from(quizAttempts).where(where).all().map((r) => r.id);
    if (!ids.length) return 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      tx.delete(quizAttemptAnswers).where(inArray(quizAttemptAnswers.attemptId, chunk)).run();
      tx.delete(quizAttempts).where(inArray(quizAttempts.id, chunk)).run();
    }
    return ids.length;
  });
}

export type LeaderboardRow = { userId: string; attemptId: number; score: number; maxScore: number; percent: number; durationMs: number | null; finishedAt: Date | null; attempts: number };

/** Each member's best completed attempt: highest score, then fastest, then earliest. */
export function leaderboard(guildId: string, quizId: number, limit = 10): LeaderboardRow[] {
  type Raw = { user_id: string; id: number; score: number; max_score: number; percent: number; duration_ms: number | null; finished_at: number | null; attempts: number };
  const rows = getDb().all<Raw>(sql`
    SELECT user_id, id, score, max_score, percent, duration_ms, finished_at, attempts FROM (
      SELECT a.user_id, a.id, a.score, a.max_score, a.percent, a.duration_ms, a.finished_at,
        COUNT(*) OVER (PARTITION BY a.user_id) AS attempts,
        ROW_NUMBER() OVER (PARTITION BY a.user_id ORDER BY a.score DESC, COALESCE(a.duration_ms, 9e15) ASC, a.finished_at ASC) AS rn
      FROM quiz_attempts a
      WHERE a.guild_id = ${guildId} AND a.quiz_id = ${quizId} AND a.status = 'completed'
    ) WHERE rn = 1
    ORDER BY score DESC, COALESCE(duration_ms, 9e15) ASC, finished_at ASC
    LIMIT ${Math.min(100, Math.max(1, limit))}
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    attemptId: r.id,
    score: r.score,
    maxScore: r.max_score,
    percent: r.percent,
    durationMs: r.duration_ms,
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    attempts: r.attempts,
  }));
}

/** 1-based rank of this attempt's score among members' best attempts (ties share the faster rank). */
export function rankOf(guildId: string, quizId: number, score: number, durationMs: number | null, userId: string): { rank: number; total: number } {
  type Raw = { better: number; total: number };
  const row = getDb().get<Raw>(sql`
    WITH best AS (
      SELECT user_id, score, duration_ms FROM (
        SELECT user_id, score, duration_ms,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY score DESC, COALESCE(duration_ms, 9e15) ASC) AS rn
        FROM quiz_attempts WHERE guild_id = ${guildId} AND quiz_id = ${quizId} AND status = 'completed'
      ) WHERE rn = 1
    )
    SELECT
      (SELECT COUNT(*) FROM best WHERE user_id != ${userId} AND (score > ${score} OR (score = ${score} AND COALESCE(duration_ms, 9e15) < ${durationMs ?? 9e15}))) AS better,
      (SELECT COUNT(*) FROM best) AS total
  `);
  return { rank: (row?.better ?? 0) + 1, total: Math.max(1, row?.total ?? 1) };
}

/** Server leaderboard: per member, the sum of their best score on each graded quiz. */
export function serverLeaderboard(guildId: string, limit = 10) {
  type Raw = { user_id: string; quizzes: number; passed: number; total_score: number; avg_percent: number | null };
  return getDb().all<Raw>(sql`
    SELECT user_id, COUNT(*) AS quizzes, SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
      ROUND(SUM(score), 2) AS total_score, ROUND(AVG(percent), 1) AS avg_percent
    FROM (
      SELECT a.user_id, a.quiz_id, a.score, a.percent, a.passed,
        ROW_NUMBER() OVER (PARTITION BY a.user_id, a.quiz_id ORDER BY a.score DESC, COALESCE(a.duration_ms, 9e15) ASC) AS rn
      FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.guild_id = ${guildId} AND q.guild_id = ${guildId} AND q.kind = 'graded' AND a.status = 'completed'
    ) WHERE rn = 1
    GROUP BY user_id
    ORDER BY total_score DESC, passed DESC, avg_percent DESC
    LIMIT ${Math.min(100, Math.max(1, limit))}
  `);
}

export type QuizAttemptAgg = { quizId: number; attempts: number; attempts30d: number; players: number; avgPercent: number | null; passRate: number | null; inProgress: number };

/** Per-quiz attempt numbers for the list page. */
export function attemptAggregates(guildId: string, since30d: Date): Map<number, QuizAttemptAgg> {
  type Raw = { quiz_id: number; attempts: number; attempts30d: number; players: number; avg_percent: number | null; pass_rate: number | null; in_progress: number };
  const rows = getDb().all<Raw>(sql`
    SELECT quiz_id,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS attempts,
      SUM(CASE WHEN status = 'completed' AND started_at >= ${since30d.getTime()} THEN 1 ELSE 0 END) AS attempts30d,
      COUNT(DISTINCT CASE WHEN status = 'completed' THEN user_id END) AS players,
      AVG(CASE WHEN status = 'completed' THEN percent END) AS avg_percent,
      AVG(CASE WHEN status = 'completed' AND passed IS NOT NULL THEN passed END) AS pass_rate,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
    FROM quiz_attempts WHERE guild_id = ${guildId}
    GROUP BY quiz_id
  `);
  return new Map(
    rows.map((r) => [
      r.quiz_id,
      {
        quizId: r.quiz_id,
        attempts: r.attempts ?? 0,
        attempts30d: r.attempts30d ?? 0,
        players: r.players ?? 0,
        avgPercent: r.avg_percent === null ? null : Math.round(r.avg_percent * 10) / 10,
        passRate: r.pass_rate === null ? null : Math.round(r.pass_rate * 1000) / 10,
        inProgress: r.in_progress ?? 0,
      },
    ]),
  );
}

export function completedAttemptsForQuiz(guildId: string, quizId: number): QuizAttempt[] {
  return getDb()
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.guildId, guildId), eq(quizAttempts.quizId, quizId), eq(quizAttempts.status, "completed")))
    .orderBy(asc(quizAttempts.startedAt))
    .all()
    .map(toAttempt);
}

/** Every answer on a quiz from completed attempts (for analytics). */
export function answersForQuiz(guildId: string, quizId: number): AttemptAnswer[] {
  type Raw = AnswerRow;
  return getDb()
    .select({
      attemptId: quizAttemptAnswers.attemptId,
      questionId: quizAttemptAnswers.questionId,
      quizId: quizAttemptAnswers.quizId,
      guildId: quizAttemptAnswers.guildId,
      position: quizAttemptAnswers.position,
      answer: quizAttemptAnswers.answer,
      correct: quizAttemptAnswers.correct,
      credit: quizAttemptAnswers.credit,
      points: quizAttemptAnswers.points,
      timeMs: quizAttemptAnswers.timeMs,
      late: quizAttemptAnswers.late,
      timedOut: quizAttemptAnswers.timedOut,
      answeredAt: quizAttemptAnswers.answeredAt,
    })
    .from(quizAttemptAnswers)
    .innerJoin(quizAttempts, eq(quizAttempts.id, quizAttemptAnswers.attemptId))
    .where(and(eq(quizAttemptAnswers.guildId, guildId), eq(quizAttemptAnswers.quizId, quizId), eq(quizAttempts.status, "completed")))
    .all()
    .map((r) => toAnswer(r as Raw));
}

/** Attempts started per UTC day since `since` (with distinct players). */
export function dailyAttempts(guildId: string, since: Date, quizId?: number): { date: string; attempts: number; players: number }[] {
  type Raw = { day: string; attempts: number; players: number };
  return getDb().all<Raw>(sql`
    SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day, COUNT(*) AS attempts, COUNT(DISTINCT user_id) AS players
    FROM quiz_attempts
    WHERE guild_id = ${guildId} AND status = 'completed' AND started_at >= ${since.getTime()} ${quizId ? sql`AND quiz_id = ${quizId}` : sql``}
    GROUP BY day ORDER BY day
  `).map((r) => ({ date: r.day, attempts: r.attempts, players: r.players }));
}

export function guildAttemptTotals(guildId: string, since30d: Date) {
  type Raw = { attempts: number; attempts30d: number; players: number; players30d: number; avg30d: number | null };
  return (
    getDb().get<Raw>(sql`
      SELECT
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS attempts,
        SUM(CASE WHEN a.status = 'completed' AND a.started_at >= ${since30d.getTime()} THEN 1 ELSE 0 END) AS attempts30d,
        COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN a.user_id END) AS players,
        COUNT(DISTINCT CASE WHEN a.status = 'completed' AND a.started_at >= ${since30d.getTime()} THEN a.user_id END) AS players30d,
        AVG(CASE WHEN a.status = 'completed' AND a.started_at >= ${since30d.getTime()} AND q.kind = 'graded' THEN a.percent END) AS avg30d
      FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.guild_id = ${guildId}
    `) ?? { attempts: 0, attempts30d: 0, players: 0, players30d: 0, avg30d: null }
  );
}

/** Question-level correctness across the server, hardest first (min 3 answers). */
export function hardestQuestions(guildId: string, limit = 8) {
  type Raw = { quiz_id: number; question_id: number; answered: number; correct: number };
  return getDb().all<Raw>(sql`
    SELECT ans.quiz_id, ans.question_id, COUNT(*) AS answered, SUM(CASE WHEN ans.correct = 1 AND ans.late = 0 THEN 1 ELSE 0 END) AS correct
    FROM quiz_attempt_answers ans
    JOIN quizzes q ON q.id = ans.quiz_id
    JOIN quiz_questions qq ON qq.id = ans.question_id
    WHERE ans.guild_id = ${guildId} AND q.guild_id = ${guildId} AND q.kind = 'graded'
    GROUP BY ans.quiz_id, ans.question_id
    HAVING COUNT(*) >= 3
    ORDER BY (CAST(correct AS REAL) / COUNT(*)) ASC, answered DESC
    LIMIT ${limit}
  `);
}

export function getQuestionsByIds(ids: number[]): QuizQuestion[] {
  if (!ids.length) return [];
  return getDb().select().from(quizQuestions).where(inArray(quizQuestions.id, ids)).all().map(toQuestion);
}

// -- Live games ------------------------------------------------------------------------------------

export type LiveGame = {
  id: number;
  guildId: string;
  quizId: number;
  channelId: string;
  messageId: string | null;
  hostId: string;
  status: LiveStatus;
  questionOrder: number[];
  optionOrders: Record<string, string[]>;
  currentIndex: number;
  questionStartedAt: Date | null;
  phaseEndsAt: Date | null;
  questionSeconds: number;
  revealSeconds: number;
  speedBonus: boolean;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
};

export type LivePlayer = typeof quizLivePlayers.$inferSelect;

export function toLive(row: LiveRow): LiveGame {
  return {
    ...row,
    status: row.status as LiveStatus,
    questionOrder: parseJson<number[]>(row.questionOrder, []),
    optionOrders: parseJson<Record<string, string[]>>(row.optionOrders, {}),
    messageId: row.messageId ?? null,
    questionStartedAt: row.questionStartedAt ?? null,
    phaseEndsAt: row.phaseEndsAt ?? null,
    endedAt: row.endedAt ?? null,
    endReason: row.endReason ?? null,
  };
}

export const RUNNING: LiveStatus[] = ["lobby", "question", "reveal"];

export function createLiveGame(input: Omit<LiveGame, "id" | "messageId" | "status" | "currentIndex" | "questionStartedAt" | "endedAt" | "endReason">): LiveGame | null {
  try {
    const row = getDb()
      .insert(quizLiveGames)
      .values({
        ...input,
        questionOrder: JSON.stringify(input.questionOrder),
        optionOrders: JSON.stringify(input.optionOrders),
        status: "lobby",
        currentIndex: -1,
      })
      .returning()
      .get();
    return toLive(row);
  } catch {
    // The partial unique index: a game is already running in this channel.
    return null;
  }
}

export function getLiveGame(id: number): LiveGame | null {
  const row = getDb().select().from(quizLiveGames).where(eq(quizLiveGames.id, id)).get();
  return row ? toLive(row) : null;
}

export function getLiveGameForGuild(guildId: string, id: number): LiveGame | null {
  const row = getDb().select().from(quizLiveGames).where(and(eq(quizLiveGames.guildId, guildId), eq(quizLiveGames.id, id))).get();
  return row ? toLive(row) : null;
}

export function runningGameInChannel(channelId: string): LiveGame | null {
  const row = getDb().select().from(quizLiveGames).where(and(eq(quizLiveGames.channelId, channelId), inArray(quizLiveGames.status, RUNNING))).get();
  return row ? toLive(row) : null;
}

export function runningGames(guildId?: string): LiveGame[] {
  return getDb()
    .select()
    .from(quizLiveGames)
    .where(guildId ? and(eq(quizLiveGames.guildId, guildId), inArray(quizLiveGames.status, RUNNING)) : inArray(quizLiveGames.status, RUNNING))
    .all()
    .map(toLive);
}

export function recentGames(guildId: string, limit = 20): LiveGame[] {
  return getDb().select().from(quizLiveGames).where(eq(quizLiveGames.guildId, guildId)).orderBy(desc(quizLiveGames.startedAt)).limit(limit).all().map(toLive);
}

/** Moves a game between phases only if it's still in `from` (so a stop and a timer can't both win). */
export function transitionGame(id: number, from: LiveStatus[], set: Partial<Omit<typeof quizLiveGames.$inferInsert, "id">>): LiveGame | null {
  const row = getDb()
    .update(quizLiveGames)
    .set(set)
    .where(and(eq(quizLiveGames.id, id), inArray(quizLiveGames.status, from)))
    .returning()
    .get();
  return row ? toLive(row) : null;
}

export function setGameMessage(id: number, messageId: string): void {
  getDb().update(quizLiveGames).set({ messageId }).where(eq(quizLiveGames.id, id)).run();
}

export function livePlayers(gameId: number): LivePlayer[] {
  return getDb().select().from(quizLivePlayers).where(eq(quizLivePlayers.gameId, gameId)).all();
}

export function liveAnswersFor(gameId: number, questionIndex: number) {
  return getDb()
    .select()
    .from(quizLiveAnswers)
    .where(and(eq(quizLiveAnswers.gameId, gameId), eq(quizLiveAnswers.questionIndex, questionIndex)))
    .all();
}

export function liveAnswerCount(gameId: number, questionIndex: number): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(quizLiveAnswers)
      .where(and(eq(quizLiveAnswers.gameId, gameId), eq(quizLiveAnswers.questionIndex, questionIndex)))
      .get()?.n ?? 0
  );
}

/**
 * One live answer, scored, once per player per question. Returns null if they already answered.
 * `score` receives the player's streak before this answer and returns the points.
 */
export function recordLiveAnswer(input: {
  gameId: number;
  questionIndex: number;
  userId: string;
  optionId: string;
  correct: boolean;
  timeMs: number;
  score: (streakBefore: number) => number;
}): { points: number; streak: number } | null {
  const db = getDb();
  return db.transaction((tx) => {
    const now = new Date();
    tx.insert(quizLivePlayers).values({ gameId: input.gameId, userId: input.userId, joinedAt: now }).onConflictDoNothing().run();
    const player = tx
      .select()
      .from(quizLivePlayers)
      .where(and(eq(quizLivePlayers.gameId, input.gameId), eq(quizLivePlayers.userId, input.userId)))
      .get()!;
    const points = input.score(player.streak);
    const inserted = tx
      .insert(quizLiveAnswers)
      .values({
        gameId: input.gameId,
        questionIndex: input.questionIndex,
        userId: input.userId,
        optionId: input.optionId,
        correct: input.correct,
        points,
        timeMs: Math.max(0, Math.round(input.timeMs)),
        answeredAt: now,
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return null;
    const streak = input.correct ? player.streak + 1 : 0;
    tx.update(quizLivePlayers)
      .set({
        score: player.score + points,
        correctCount: player.correctCount + (input.correct ? 1 : 0),
        answeredCount: player.answeredCount + 1,
        streak,
        bestStreak: Math.max(player.bestStreak, streak),
      })
      .where(and(eq(quizLivePlayers.gameId, input.gameId), eq(quizLivePlayers.userId, input.userId)))
      .run();
    return { points, streak };
  });
}

/** Players who didn't answer a question lose their streak. */
export function breakStreaksForMissing(gameId: number, questionIndex: number): void {
  getDb().run(sql`
    UPDATE quiz_live_players SET streak = 0
    WHERE game_id = ${gameId} AND user_id NOT IN (
      SELECT user_id FROM quiz_live_answers WHERE game_id = ${gameId} AND question_index = ${questionIndex}
    )
  `);
}

export function playerCounts(gameIds: number[]): Map<number, number> {
  if (!gameIds.length) return new Map();
  const rows = getDb()
    .select({ gameId: quizLivePlayers.gameId, n: sql<number>`count(*)` })
    .from(quizLivePlayers)
    .where(inArray(quizLivePlayers.gameId, gameIds))
    .groupBy(quizLivePlayers.gameId)
    .all();
  return new Map(rows.map((r) => [r.gameId, r.n]));
}
