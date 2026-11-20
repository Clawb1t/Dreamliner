/**
 * The solo quiz run: start (intro), begin or resume an attempt, show the current question, take
 * answers (idempotent, time limits enforced on the server), feedback, finish (score, outcome,
 * rewards, results post, DM) and the results / review screens.
 *
 * All state lives in quiz_attempts; every screen is rebuilt from it, so a dismissed ephemeral
 * message or an expired interaction token loses nothing: pressing Start again resumes.
 */
import type { Guild, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zQuizzesConfig, type QuizzesConfig } from "../../../config/schemas/quizzes.js";
import { getPluginSettings, hasPermission } from "../../../core/permissionRoles.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { autoGrantableRoleIds, safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { getLogger } from "../../../core/logger.js";
import { gradeAnswer, parseNumberAnswer } from "./matching.js";
import { attemptTotals, hasPassed, isLate, LATE_GRACE_MS, pointsFor, questionLimitSec, resolveOutcome } from "./scoring.js";
import { checkEligibility, quizIsOpen } from "./rules.js";
import { newSeed, optionOrder, pickQuestionOrder } from "./shuffle.js";
import * as render from "./render.js";
import * as store from "./store.js";
import type { AnswerValue, Quiz, QuizAttempt, QuizQuestion } from "./types.js";

const log = getLogger("quizzes");

export type Screen = { ok: true; payload: render.QuizPayload } | { ok: false; title: string; body: string };

function fail(title: string, body: string): Screen {
  return { ok: false, title, body };
}

export async function getQuizzesConfig(guildId: string): Promise<QuizzesConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const parsed = zQuizzesConfig.safeParse(getPluginSettings(guildConfig, "quizzes"));
  return parsed.success ? parsed.data : zQuizzesConfig.parse({});
}

export async function memberCan(member: GuildMember, permission: "can_take" | "can_host_live" | "can_view_results" | "can_manage"): Promise<boolean> {
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  return hasPermission(member.guild.id, "quizzes", permission, member, guildConfig);
}

export async function quizzesEnabled(guildId: string): Promise<boolean> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return (guildConfig.plugins as Record<string, { enabled?: boolean } | undefined>).quizzes?.enabled === true;
}

function memberRoleIds(member: GuildMember): string[] {
  return [...member.roles.cache.keys()];
}

function askedQuestions(attempt: QuizAttempt, questions: QuizQuestion[]): QuizQuestion[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return attempt.questionOrder.map((id) => byId.get(id)).filter((q): q is QuizQuestion => Boolean(q));
}

function bestFor(guildId: string, quizId: number, userId: string): { percent: number; rank: number } | null {
  const best = store
    .listAttempts(guildId, { quizId, userId, status: "completed", limit: 500 })
    .attempts.sort((a, b) => b.score - a.score || (a.durationMs ?? 9e15) - (b.durationMs ?? 9e15))[0];
  if (!best) return null;
  return { percent: best.percent, rank: store.rankOf(guildId, quizId, best.score, best.durationMs, userId).rank };
}

/** The intro card (or the reason they can't take it). Pressing Start on a panel or /quiz take. */
export async function startScreen(member: GuildMember, quizId: number): Promise<Screen> {
  const quiz = store.getQuiz(member.guild.id, quizId);
  if (!quiz) return fail("Quiz not found", "This quiz no longer exists.");
  if (!(await memberCan(member, "can_take"))) return fail("Permission denied", "You don't have permission to take quizzes here.");
  const questions = store.listQuestions(quiz.id);
  if (!questions.length) return fail("Quiz not ready", "This quiz doesn't have any questions yet.");
  const open = store.getOpenAttempt(quiz.id, member.id);
  const stats = store.memberAttemptStats(quiz.id, member.id);
  const eligibility = checkEligibility({
    quiz,
    now: Date.now(),
    memberRoleIds: memberRoleIds(member),
    finishedAttempts: stats.finished,
    lastFinishedAt: stats.lastFinishedAt,
    hasOpenAttempt: Boolean(open),
  });
  if (!eligibility.ok) return fail("You can't take this quiz", eligibility.reason);
  const resume = open ? { answered: Math.min(open.currentIndex, open.questionOrder.length), total: open.questionOrder.length } : null;
  return {
    ok: true,
    payload: render.introPayload(quiz, questions.length, {
      resume,
      attemptsLeft: eligibility.attemptsLeft,
      best: quiz.kind === "graded" ? bestFor(member.guild.id, quiz.id, member.id) : null,
    }),
  };
}

/** Begin (or continue) an attempt and show where it's at. */
export async function beginAttempt(member: GuildMember, quizId: number): Promise<Screen> {
  const quiz = store.getQuiz(member.guild.id, quizId);
  if (!quiz) return fail("Quiz not found", "This quiz no longer exists.");
  if (!(await memberCan(member, "can_take"))) return fail("Permission denied", "You don't have permission to take quizzes here.");
  const questions = store.listQuestions(quiz.id);
  if (!questions.length) return fail("Quiz not ready", "This quiz doesn't have any questions yet.");
  let attempt = store.getOpenAttempt(quiz.id, member.id);
  const stats = store.memberAttemptStats(quiz.id, member.id);
  const eligibility = checkEligibility({
    quiz,
    now: Date.now(),
    memberRoleIds: memberRoleIds(member),
    finishedAttempts: stats.finished,
    lastFinishedAt: stats.lastFinishedAt,
    hasOpenAttempt: Boolean(attempt),
  });
  if (!eligibility.ok) return fail("You can't take this quiz", eligibility.reason);
  if (!attempt) {
    const seed = newSeed();
    const order = pickQuestionOrder(questions, quiz.settings, seed);
    const asked = order.map((id) => questions.find((q) => q.id === id)!).filter(Boolean);
    const maxScore = quiz.kind === "graded" ? asked.reduce((sum, q) => sum + Math.max(0, q.points), 0) : 0;
    attempt = store.createAttempt({
      guildId: member.guild.id,
      quizId: quiz.id,
      userId: member.id,
      seed,
      questionOrder: order,
      maxScore,
      deadlineAt: quiz.settings.quizTimeLimitSec > 0 ? new Date(Date.now() + quiz.settings.quizTimeLimitSec * 1000) : null,
    });
  }
  return renderCurrent(member.guild, quiz, questions, attempt);
}

/**
 * Builds the screen for the attempt's current state: results when it's done, the feedback screen
 * when one is waiting, otherwise the current question (recording timeouts for questions whose
 * time ran out while nobody was looking, and finishing once the whole-quiz time is up).
 */
export async function renderCurrent(guild: Guild, quiz: Quiz, questions: QuizQuestion[], start: QuizAttempt): Promise<Screen> {
  let attempt = start;
  for (let guard = 0; guard < 200; guard++) {
    if (attempt.status !== "in_progress") return resultsScreen(guild, quiz, questions, attempt);
    const now = Date.now();
    const deadline = attempt.deadlineAt?.getTime() ?? null;
    if (deadline !== null && now > deadline + LATE_GRACE_MS) return finish(guild, quiz, questions, attempt);

    if (attempt.awaitingNext && attempt.currentIndex > 0) {
      const prevId = attempt.questionOrder[attempt.currentIndex - 1]!;
      const prev = questions.find((q) => q.id === prevId);
      const answer = store.listAnswers(attempt.id).find((a) => a.questionId === prevId);
      if (prev && answer) {
        return {
          ok: true,
          payload: render.feedbackPayload({ quiz, attempt, question: prev, answer, index: attempt.currentIndex - 1, total: attempt.questionOrder.length, streak: attempt.streak }),
        };
      }
      store.clearAwaitingNext(attempt.id);
      attempt = { ...attempt, awaitingNext: false };
    }

    if (attempt.currentIndex >= attempt.questionOrder.length) return finish(guild, quiz, questions, attempt);

    const index = attempt.currentIndex;
    const question = questions.find((q) => q.id === attempt.questionOrder[index]);
    if (!question) {
      // Deleted from the quiz mid-attempt: skip it without scoring.
      store.recordAnswer({ attempt, index, questionId: attempt.questionOrder[index]!, answer: { kind: "none" }, correct: null, credit: 0, points: 0, timeMs: 0, late: false, timedOut: true, awaitNext: false });
      attempt = store.getAttempt(guild.id, attempt.id) ?? attempt;
      continue;
    }
    const limit = questionLimitSec(question, quiz.settings.questionTimeLimitSec);
    const startedAt = attempt.questionStartedAt?.getTime() ?? null;
    if (startedAt !== null && limit > 0 && now > startedAt + limit * 1000 + LATE_GRACE_MS) {
      // Time ran out on this question while they were away.
      store.recordAnswer({
        attempt,
        index,
        questionId: question.id,
        answer: { kind: "none" },
        correct: quiz.kind === "graded" ? false : null,
        credit: 0,
        points: 0,
        timeMs: limit * 1000,
        late: false,
        timedOut: true,
        awaitNext: false,
      });
      attempt = store.getAttempt(guild.id, attempt.id) ?? attempt;
      continue;
    }
    let shownAt = startedAt;
    if (shownAt === null) {
      const at = new Date();
      store.markQuestionShown(attempt.id, index, at);
      shownAt = (store.getAttempt(guild.id, attempt.id)?.questionStartedAt ?? at).getTime();
    }
    const endsAt = limit > 0 ? shownAt + limit * 1000 : null;
    return {
      ok: true,
      payload: render.questionPayload({
        quiz,
        attempt,
        question,
        options: optionOrder(question, quiz.settings.shuffleAnswers, attempt.seed),
        index,
        total: attempt.questionOrder.length,
        endsAt: endsAt !== null && deadline !== null ? Math.min(endsAt, deadline) : (endsAt ?? null),
        deadlineAt: deadline,
      }),
    };
  }
  return fail("Something went wrong", "This attempt got stuck. Press Start again to continue.");
}

type Loaded = { quiz: Quiz; questions: QuizQuestion[]; attempt: QuizAttempt };

/** Loads an attempt for its owner. Anyone else pressing a button on it gets an error. */
export function loadOwnAttempt(guildId: string, userId: string, attemptId: number): Loaded | { error: string } {
  const attempt = store.getAttempt(guildId, attemptId);
  if (!attempt || attempt.userId !== userId) return { error: "This quiz run isn't yours. Start your own from the quiz panel or with /quiz take." };
  const quiz = store.getQuiz(guildId, attempt.quizId);
  if (!quiz) return { error: "This quiz no longer exists." };
  return { quiz, questions: store.listQuestions(quiz.id), attempt };
}

export type RawAnswer = { kind: "option"; display: number } | { kind: "options"; display: number[] } | { kind: "text"; text: string };

/** Takes an answer to question `index` (from a button, the select menu or the modal). */
export async function submitAnswer(member: GuildMember, attemptId: number, index: number, raw: RawAnswer): Promise<Screen> {
  const loaded = loadOwnAttempt(member.guild.id, member.id, attemptId);
  if ("error" in loaded) return fail("Not your quiz", loaded.error);
  const { quiz, questions, attempt } = loaded;
  // Already answered (double press, an old message): just show where they are now.
  if (attempt.status !== "in_progress" || attempt.currentIndex !== index || attempt.awaitingNext) return renderCurrent(member.guild, quiz, questions, attempt);
  const question = questions.find((q) => q.id === attempt.questionOrder[index]);
  if (!question) return renderCurrent(member.guild, quiz, questions, attempt);

  const options = optionOrder(question, quiz.settings.shuffleAnswers, attempt.seed);
  let answer: AnswerValue;
  if (raw.kind === "option") {
    const option = options[raw.display];
    if (!option || (question.type !== "single" && question.type !== "truefalse")) return renderCurrent(member.guild, quiz, questions, attempt);
    answer = { kind: "options", optionIds: [option.id] };
  } else if (raw.kind === "options") {
    const ids = [...new Set(raw.display)].map((i) => options[i]?.id).filter((id): id is string => Boolean(id));
    if (!ids.length || question.type !== "multi") return renderCurrent(member.guild, quiz, questions, attempt);
    answer = { kind: "options", optionIds: ids };
  } else {
    if (question.type === "number") {
      const value = parseNumberAnswer(raw.text);
      answer = value === null ? { kind: "text", text: raw.text.slice(0, 100) } : { kind: "number", value };
    } else if (question.type === "text") {
      answer = { kind: "text", text: raw.text.slice(0, 100) };
    } else {
      return renderCurrent(member.guild, quiz, questions, attempt);
    }
  }

  const now = Date.now();
  const limit = questionLimitSec(question, quiz.settings.questionTimeLimitSec);
  const startedAt = attempt.questionStartedAt?.getTime() ?? now;
  const late = isLate({ now, questionStartedAt: startedAt, limitSec: limit, deadlineAt: attempt.deadlineAt?.getTime() ?? null });
  const graded = quiz.kind === "graded";
  const grade = graded ? gradeAnswer(question, answer) : { correct: false, credit: 0 };
  const points = graded ? pointsFor(question, grade.credit, late) : 0;
  const awaitNext = graded && quiz.settings.revealMode === "each";
  store.recordAnswer({
    attempt,
    index,
    questionId: question.id,
    answer,
    correct: graded ? grade.correct && !late : null,
    credit: late ? 0 : grade.credit,
    points,
    timeMs: now - startedAt,
    late,
    timedOut: false,
    awaitNext,
  });
  const fresh = store.getAttempt(member.guild.id, attempt.id) ?? attempt;
  return renderCurrent(member.guild, quiz, questions, fresh);
}

/** "Next question" after the feedback screen. */
export async function nextQuestion(member: GuildMember, attemptId: number, index: number): Promise<Screen> {
  const loaded = loadOwnAttempt(member.guild.id, member.id, attemptId);
  if ("error" in loaded) return fail("Not your quiz", loaded.error);
  const { quiz, questions, attempt } = loaded;
  if (attempt.awaitingNext && attempt.currentIndex === index) {
    store.clearAwaitingNext(attempt.id);
    return renderCurrent(member.guild, quiz, questions, { ...attempt, awaitingNext: false });
  }
  return renderCurrent(member.guild, quiz, questions, attempt);
}

/**
 * Closes the attempt: totals, pass/fail or personality result, then rewards, the results post
 * and the DM. Safe to call twice: only the first call to close the row does the side effects.
 */
export async function finish(guild: Guild, quiz: Quiz, questions: QuizQuestion[], attempt: QuizAttempt): Promise<Screen> {
  const closed = closeAttempt(guild, quiz, questions, attempt);
  if (!closed) {
    const current = store.getAttempt(guild.id, attempt.id) ?? attempt;
    return resultsScreen(guild, quiz, questions, current);
  }
  const rewardNote = await applyRewardsAndNotify(guild, quiz, questions, closed);
  return resultsScreen(guild, quiz, questions, closed, rewardNote);
}

/** Pure-ish part of finishing (DB only). Returns the closed attempt, or null when it was already closed. */
export function closeAttempt(_guild: Guild | { id: string }, quiz: Quiz, questions: QuizQuestion[], attempt: QuizAttempt, status: "completed" | "expired" = "completed"): QuizAttempt | null {
  const asked = askedQuestions(attempt, questions);
  const answers = store.listAnswers(attempt.id);
  const totals = attemptTotals(
    asked,
    answers.map((a) => ({ questionId: a.questionId, credit: a.credit, points: a.points, correct: a.correct, late: a.late, timedOut: a.timedOut })),
  );
  const outcome = quiz.kind === "personality" ? resolveOutcome(quiz.outcomes, asked, answers) : null;
  const end = attempt.deadlineAt ? Math.min(Date.now(), attempt.deadlineAt.getTime()) : Date.now();
  return store.finishAttempt(attempt.id, status, {
    score: quiz.kind === "graded" ? totals.score : 0,
    maxScore: quiz.kind === "graded" ? totals.maxScore : 0,
    percent: quiz.kind === "graded" ? totals.percent : 0,
    passed: quiz.kind === "graded" ? hasPassed(totals.percent, quiz.settings.passPercent) : null,
    outcomeId: outcome?.id ?? null,
    correctCount: quiz.kind === "graded" ? totals.correctCount : 0,
    bestStreak: quiz.kind === "graded" ? totals.bestStreak : 0,
    durationMs: Math.max(0, end - attempt.startedAt.getTime()),
  });
}

async function applyRewardsAndNotify(guild: Guild, quiz: Quiz, questions: QuizQuestion[], attempt: QuizAttempt): Promise<string | null> {
  let note: string | null = null;
  const outcome = quiz.outcomes.find((o) => o.id === attempt.outcomeId) ?? null;
  const member = await guild.members.fetch(attempt.userId).catch(() => null);
  if (member) {
    try {
      if (quiz.kind === "graded" && attempt.passed && quiz.settings.passRoleId) {
        const [roleId] = autoGrantableRoleIds(guild, [quiz.settings.passRoleId]);
        if (roleId) {
          const result = await safeAddRole(member, roleId, `Passed the quiz "${quiz.title}"`);
          if (result.ok) {
            store.setRewardRole(attempt.id, roleId);
            note = `${render.QUIZ_EMOJI.roles} You got the <@&${roleId}> role.`;
          }
        }
      }
      if (quiz.kind === "personality" && outcome?.roleId) {
        const grantable = new Set(autoGrantableRoleIds(guild, quiz.outcomes.map((o) => o.roleId).filter(Boolean)));
        // One result role at a time: a retake that lands elsewhere swaps the role.
        for (const other of quiz.outcomes) {
          if (other.id !== outcome.id && other.roleId && grantable.has(other.roleId) && member.roles.cache.has(other.roleId)) {
            await safeRemoveRole(member, other.roleId, `New result in the quiz "${quiz.title}"`).catch(() => null);
          }
        }
        if (grantable.has(outcome.roleId)) {
          const result = await safeAddRole(member, outcome.roleId, `Quiz result in "${quiz.title}"`);
          if (result.ok) {
            store.setRewardRole(attempt.id, outcome.roleId);
            note = `${render.QUIZ_EMOJI.roles} You got the <@&${outcome.roleId}> role.`;
          }
        }
      }
    } catch (error) {
      log.warn(`Couldn't give the reward role for quiz #${quiz.id}:`, error);
    }
  }

  const questionCount = attempt.questionOrder.length;
  const config = await getQuizzesConfig(guild.id);
  const channelId = quiz.settings.resultsChannelId === "none" ? "" : quiz.settings.resultsChannelId || config.results_channel_id || "";
  if (channelId) {
    const channel = await fetchGuildTextChannel(guild.client, guild.id, channelId);
    if (channel) {
      await channel.send(render.resultPostPayload(quiz, attempt, outcome, questionCount)).catch((error) => {
        log.warn(`Couldn't post quiz #${quiz.id} results in ${channelId}:`, error);
      });
    }
  }
  if (quiz.settings.dmResult && member) {
    await member.send(render.resultDmPayload(quiz, attempt, outcome, questionCount, guild.name)).catch(() => null);
  }
  void questions;
  return note;
}

/** The results screen for a finished attempt. */
export async function resultsScreen(guild: Guild, quiz: Quiz, _questions: QuizQuestion[], attempt: QuizAttempt, rewardNote: string | null = null): Promise<Screen> {
  const outcome = quiz.outcomes.find((o) => o.id === attempt.outcomeId) ?? null;
  const rank = quiz.kind === "graded" && attempt.status === "completed" ? store.rankOf(guild.id, quiz.id, attempt.score, attempt.durationMs, attempt.userId) : null;
  const stats = store.memberAttemptStats(quiz.id, attempt.userId);
  const member = await guild.members.fetch(attempt.userId).catch(() => null);
  const eligibility = checkEligibility({
    quiz,
    now: Date.now(),
    memberRoleIds: member ? memberRoleIds(member) : [],
    finishedAttempts: stats.finished,
    lastFinishedAt: stats.lastFinishedAt,
    hasOpenAttempt: false,
  });
  const retryNote = eligibility.ok
    ? eligibility.attemptsLeft !== null
      ? `${eligibility.attemptsLeft} ${eligibility.attemptsLeft === 1 ? "attempt" : "attempts"} left.`
      : null
    : quizIsOpen(quiz, Date.now())
      ? eligibility.reason
      : null;
  if (!rewardNote && attempt.rewardRoleId) rewardNote = `${render.QUIZ_EMOJI.roles} You have the <@&${attempt.rewardRoleId}> role.`;
  return {
    ok: true,
    payload: render.resultsPayload({ quiz, attempt, outcome, rank, questionCount: attempt.questionOrder.length, canRetry: eligibility.ok, retryNote, rewardNote }),
  };
}

export async function resultsFor(member: GuildMember, attemptId: number): Promise<Screen> {
  const loaded = loadOwnAttempt(member.guild.id, member.id, attemptId);
  if ("error" in loaded) return fail("Not your quiz", loaded.error);
  if (loaded.attempt.status === "in_progress") return renderCurrent(member.guild, loaded.quiz, loaded.questions, loaded.attempt);
  return resultsScreen(member.guild, loaded.quiz, loaded.questions, loaded.attempt);
}

export async function reviewFor(member: GuildMember, attemptId: number, page: number): Promise<Screen> {
  const loaded = loadOwnAttempt(member.guild.id, member.id, attemptId);
  if ("error" in loaded) return fail("Not your quiz", loaded.error);
  const { quiz, attempt } = loaded;
  if (attempt.status === "in_progress") return renderCurrent(member.guild, quiz, loaded.questions, attempt);
  if (!quiz.settings.allowReview) return fail("Review is off", "This quiz doesn't show a review of your answers.");
  const questions = store.getQuestionsByIds(attempt.questionOrder);
  return { ok: true, payload: render.reviewPayload({ quiz, attempt, questions, answers: store.listAnswers(attempt.id), page, outcomes: quiz.outcomes }) };
}

/** Leaderboard screen (respects leaderboards_public / can_view_results). */
export async function leaderboardFor(member: GuildMember, quizId: number, ephemeral: boolean): Promise<Screen> {
  const quiz = store.getQuiz(member.guild.id, quizId);
  if (!quiz) return fail("Quiz not found", "This quiz no longer exists.");
  if (quiz.kind !== "graded") return fail("No leaderboard", "Personality quizzes don't have scores, so there's no leaderboard.");
  const config = await getQuizzesConfig(member.guild.id);
  const staff = await memberCan(member, "can_view_results");
  if (!staff && (!config.leaderboards_public || !quiz.settings.showLeaderboard)) return fail("Leaderboard hidden", "This server keeps quiz leaderboards private.");
  if (!staff && !(await memberCan(member, "can_take"))) return fail("Permission denied", "You don't have permission to view quiz leaderboards.");
  const entries = store.leaderboard(member.guild.id, quiz.id, 10);
  const best = bestFor(member.guild.id, quiz.id, member.id);
  return { ok: true, payload: render.leaderboardPayload(quiz, entries, { userId: member.id, rank: best?.rank ?? null }, ephemeral) };
}

/** Scheduler: closes attempts that were abandoned (whole-quiz time up, or untouched for a day). */
export function expireStaleAttempts(): number {
  let closed = 0;
  for (const attempt of store.staleOpenAttempts(new Date())) {
    const quiz = store.getQuiz(attempt.guildId, attempt.quizId);
    if (!quiz) {
      store.finishAttempt(attempt.id, "expired", { score: 0, maxScore: 0, percent: 0, passed: null, outcomeId: null, correctCount: 0, bestStreak: 0, durationMs: 0 });
      continue;
    }
    // Ran out of whole-quiz time: score what they answered. Abandoned without a deadline: expired.
    const status = attempt.deadlineAt && attempt.deadlineAt.getTime() < Date.now() ? "completed" : "expired";
    if (closeAttempt({ id: attempt.guildId }, quiz, store.listQuestions(quiz.id), attempt, status)) closed++;
  }
  return closed;
}
