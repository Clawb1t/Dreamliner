/**
 * Quizzes on the dashboard: list/create/edit/duplicate/delete quizzes, publish and close, post
 * panels, run live games, analytics, leaderboards, attempts (view, delete, reset), CSV export,
 * bulk import and Autopilot drafts. The route contract is in webQuizzesTypes.ts.
 *
 * Every id from the request is looked up with the guild id, every channel through
 * fetchGuildChannel, and every role must be one of this guild's roles before it's saved.
 */
import type { Client, Guild } from "discord.js";
import { consumeAiGate } from "../core/ai/gate.js";
import { getAiGateStatus, refundFreeAiUse } from "../core/ai/usage.js";
import { configManager } from "../config/manager.js";
import { hasPermission } from "../core/permissionRoles.js";
import { ACTOR_UNRESOLVED_MESSAGE, grantableRoleProblems, grantableRolesMessage, resolveActor } from "../core/actorPermissions.js";
import { fetchGuildTextChannel, isGuildChannel } from "../core/guildChannel.js";
import { getLogger } from "../core/logger.js";
import { generateQuizDraft, parseGenerateRequest } from "../plugins/quizzes/functions/ai.js";
import { parseQuestionCsv, parseQuestionText } from "../plugins/quizzes/functions/importParser.js";
import { isLivePlayable, startLiveGame, stopLiveGame } from "../plugins/quizzes/functions/live.js";
import { answerText, correctAnswerText } from "../plugins/quizzes/functions/matching.js";
import { panelUrl, postPanel, refreshPanel } from "../plugins/quizzes/functions/panel.js";
import { getQuizzesConfig } from "../plugins/quizzes/functions/run.js";
import { cleanQuizInput, publishProblem, type CleanQuiz } from "../plugins/quizzes/functions/validate.js";
import * as store from "../plugins/quizzes/functions/store.js";
import { QUIZ_LIMITS, QUIZ_STATUSES, type AttemptStatus, type Quiz, type QuizAttempt, type QuizQuestion, type QuizStatus } from "../plugins/quizzes/functions/types.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { trackDashboardAction } from "./dashboardAudit.js";
import type {
  QuizInput,
  WebAnswerBar,
  WebAttemptAnswer,
  WebLeaderboardEntry,
  WebLiveGame,
  WebPerson,
  WebQuestionAnalytics,
  WebQuiz,
  WebQuizAnalytics,
  WebQuizAttemptDetail,
  WebQuizAttemptRow,
  WebQuizDetail,
  WebQuizInsights,
  WebQuizRow,
  WebQuizStats,
} from "./webQuizzesTypes.js";

const log = getLogger("bridge");

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const bad = (error: string, status = 400): Reply => ({ status, body: { error } });

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// -- People ------------------------------------------------------------------------------------------

async function person(guild: Guild, userId: string): Promise<WebPerson> {
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
  return {
    id: userId,
    name: member?.displayName ?? user?.globalName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function people(guild: Guild, ids: (string | null | undefined)[]): Promise<Map<string, WebPerson>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id && /^\d{15,22}$/.test(id))))].slice(0, 200);
  const resolved = await Promise.all(unique.map((id) => person(guild, id)));
  return new Map(resolved.map((p) => [p.id, p]));
}

const unknown = (id: string): WebPerson => ({ id, name: id, username: null, avatar: null });

// -- Shapes --------------------------------------------------------------------------------------------

function toRow(q: Quiz, questionCount: number, agg: store.QuizAttemptAgg | undefined, liveGameId: number | null): WebQuizRow {
  const graded = q.kind === "graded";
  return {
    id: q.id,
    kind: q.kind,
    status: q.status,
    title: q.title,
    description: q.description,
    coverImageUrl: q.coverImageUrl,
    color: q.color,
    category: q.category,
    tags: q.tags,
    questionCount,
    attempts: agg?.attempts ?? 0,
    attempts30d: agg?.attempts30d ?? 0,
    players: agg?.players ?? 0,
    avgPercent: graded ? (agg?.avgPercent ?? null) : null,
    passRate: graded && q.settings.passPercent > 0 ? (agg?.passRate ?? null) : null,
    liveGameId,
    panelChannelId: q.panelChannelId,
    panelMessageUrl: panelUrl(q),
    opensAt: iso(q.opensAt),
    closesAt: iso(q.closesAt),
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    publishedAt: iso(q.publishedAt),
    lastError: q.lastError,
  };
}

function since30(): Date {
  return new Date(Date.now() - 30 * 86400_000);
}

function fullQuiz(q: Quiz): WebQuiz {
  const questions = store.listQuestions(q.id);
  const agg = store.attemptAggregates(q.guildId, since30()).get(q.id);
  const live = store.runningGames(q.guildId).find((g) => g.quizId === q.id);
  return { ...toRow(q, questions.length, agg, live?.id ?? null), settings: q.settings, outcomes: q.outcomes, questions, createdBy: q.createdBy };
}

function asClean(q: Quiz): CleanQuiz {
  return {
    kind: q.kind,
    title: q.title,
    description: q.description,
    coverImageUrl: q.coverImageUrl,
    color: q.color,
    category: q.category,
    tags: q.tags,
    settings: q.settings,
    outcomes: q.outcomes,
    questions: store.listQuestions(q.id),
    opensAt: q.opensAt,
    closesAt: q.closesAt,
  };
}

async function liveShape(guild: Guild, game: store.LiveGame, quizTitles: Map<number, string>, playerCount: number): Promise<WebLiveGame> {
  const players = store.livePlayers(game.id).sort((a, b) => b.score - a.score || b.correctCount - a.correctCount).slice(0, 3);
  const map = await people(guild, [game.hostId, ...players.map((p) => p.userId)]);
  return {
    id: game.id,
    quizId: game.quizId,
    quizTitle: quizTitles.get(game.quizId) ?? "Deleted quiz",
    channelId: game.channelId,
    status: game.status,
    host: map.get(game.hostId) ?? unknown(game.hostId),
    players: playerCount,
    currentIndex: game.currentIndex,
    questionCount: game.questionOrder.length,
    startedAt: game.startedAt.toISOString(),
    endedAt: iso(game.endedAt),
    endReason: game.endReason,
    messageUrl: game.messageId ? `https://discord.com/channels/${game.guildId}/${game.channelId}/${game.messageId}` : null,
    top: players.map((p) => ({ person: map.get(p.userId) ?? unknown(p.userId), score: p.score })),
  };
}

async function liveList(guild: Guild, games: store.LiveGame[]): Promise<WebLiveGame[]> {
  const titles = new Map(store.listQuizzes(guild.id).map((q) => [q.id, q.title]));
  const counts = store.playerCounts(games.map((g) => g.id));
  return Promise.all(games.map((g) => liveShape(guild, g, titles, counts.get(g.id) ?? 0)));
}

async function attemptRows(guild: Guild, attempts: QuizAttempt[]): Promise<WebQuizAttemptRow[]> {
  const quizzes = new Map(store.listQuizzes(guild.id).map((q) => [q.id, q]));
  const map = await people(guild, attempts.map((a) => a.userId));
  return attempts.map((a) => {
    const quiz = quizzes.get(a.quizId);
    return {
      id: a.id,
      quizId: a.quizId,
      quizTitle: quiz?.title ?? "Deleted quiz",
      userId: a.userId,
      person: map.get(a.userId) ?? unknown(a.userId),
      status: a.status,
      score: a.score,
      maxScore: a.maxScore,
      percent: a.percent,
      passed: a.passed,
      outcomeId: a.outcomeId,
      outcomeTitle: quiz?.outcomes.find((o) => o.id === a.outcomeId)?.title ?? null,
      correctCount: a.correctCount,
      questionCount: a.questionOrder.length,
      durationMs: a.durationMs,
      bestStreak: a.bestStreak,
      startedAt: a.startedAt.toISOString(),
      finishedAt: iso(a.finishedAt),
    };
  });
}

// -- Validation of guild targets --------------------------------------------------------------------

async function targetsProblem(guild: Guild, clean: CleanQuiz): Promise<string | null> {
  const roleIds = [...clean.settings.requiredRoleIds, ...clean.settings.blockedRoleIds, clean.settings.passRoleId, ...clean.outcomes.map((o) => o.roleId)].filter(Boolean);
  if (roleIds.some((id) => !guild.roles.cache.has(id))) return "One of the roles isn't in this server.";
  const ch = clean.settings.resultsChannelId;
  if (ch && ch !== "none" && !(await isGuildChannel(guild.client, guild.id, ch))) return "The results channel isn't in this server.";
  return null;
}

/** Roles the bot hands out for a quiz: the pass role and personality outcome roles. */
const rewardRoleIds = (clean: CleanQuiz | null): string[] =>
  clean ? [clean.settings.passRoleId, ...clean.outcomes.map((o) => o.roleId)].filter((id): id is string => Boolean(id)) : [];

/**
 * Newly added reward roles must be roles the editor could give themselves (Manage Roles, below
 * their highest role, no permissions they lack): quizzes can be managed with a Dreamliner flag
 * alone, and the bot gives these roles to everyone who passes. Unchanged roles aren't rechecked.
 */
async function rewardRolesRefusal(guild: Guild, userId: string, next: CleanQuiz, previous: CleanQuiz | null): Promise<Reply | null> {
  const before = new Set(rewardRoleIds(previous));
  const added = rewardRoleIds(next).filter((id) => !before.has(id));
  if (!added.length) return null;
  const actor = await resolveActor(guild, userId);
  if (!actor) return bad(ACTOR_UNRESOLVED_MESSAGE, 403);
  const problems = grantableRoleProblems(guild, actor, added);
  return problems.length ? { status: 403, body: { error: grantableRolesMessage(problems), code: "role_hierarchy", problems } } : null;
}

// -- Reads -------------------------------------------------------------------------------------------

async function listAll(guild: Guild): Promise<Reply> {
  const quizzes = store.listQuizzes(guild.id);
  const counts = store.questionCounts(quizzes.map((q) => q.id));
  const aggs = store.attemptAggregates(guild.id, since30());
  const running = store.runningGames(guild.id);
  const liveBy = new Map(running.map((g) => [g.quizId, g.id]));
  const totals = store.guildAttemptTotals(guild.id, since30());
  const byStatus = Object.fromEntries(QUIZ_STATUSES.map((s) => [s, 0])) as Record<QuizStatus, number>;
  for (const q of quizzes) byStatus[q.status] += 1;
  const stats: WebQuizStats = {
    total: quizzes.length,
    byStatus,
    attempts30d: totals.attempts30d ?? 0,
    players30d: totals.players30d ?? 0,
    avgPercent: totals.avg30d === null || totals.avg30d === undefined ? null : Math.round(totals.avg30d * 10) / 10,
    liveGames: running.length,
  };
  return ok({
    quizzes: quizzes.map((q) => toRow(q, counts.get(q.id) ?? 0, aggs.get(q.id), liveBy.get(q.id) ?? null)),
    stats,
    live: await liveList(guild, running),
  });
}

async function detail(guild: Guild, quiz: Quiz): Promise<Reply> {
  const full = fullQuiz(quiz);
  const events = store.listEvents(guild.id, quiz.id, 60);
  const map = await people(guild, [quiz.createdBy, ...events.map((e) => e.actorId)]);
  const running = store.runningGames(guild.id).find((g) => g.quizId === quiz.id);
  const completed = store.completedAttemptsForQuiz(guild.id, quiz.id);
  const agg = store.attemptAggregates(guild.id, since30()).get(quiz.id);
  const durations = completed.map((a) => a.durationMs).filter((d): d is number => d !== null);
  const result: WebQuizDetail = {
    quiz: full,
    events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actorId ? (map.get(e.actorId) ?? unknown(e.actorId)) : null, detail: e.detail, createdAt: e.createdAt.toISOString() })),
    live: running ? (await liveList(guild, [running]))[0]! : null,
    createdBy: map.get(quiz.createdBy) ?? null,
    summary: {
      attempts: completed.length,
      inProgress: agg?.inProgress ?? 0,
      players: agg?.players ?? 0,
      avgPercent: quiz.kind === "graded" ? (agg?.avgPercent ?? null) : null,
      passRate: quiz.kind === "graded" && quiz.settings.passPercent > 0 ? (agg?.passRate ?? null) : null,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      bestPercent: quiz.kind === "graded" && completed.length ? Math.max(...completed.map((a) => a.percent)) : null,
    },
  };
  return ok(result);
}

function analytics(guild: Guild, quiz: Quiz): Reply {
  const questions = store.listQuestions(quiz.id);
  const completed = store.completedAttemptsForQuiz(guild.id, quiz.id);
  const answers = store.answersForQuiz(guild.id, quiz.id);
  const agg = store.attemptAggregates(guild.id, since30()).get(quiz.id);
  const graded = quiz.kind === "graded";

  const percents = completed.map((a) => a.percent).sort((a, b) => a - b);
  const buckets = Array.from({ length: 10 }, () => 0);
  if (graded) for (const p of percents) buckets[Math.min(9, Math.floor(p / 10))]! += 1;
  const median = percents.length ? (percents.length % 2 ? percents[(percents.length - 1) / 2]! : (percents[percents.length / 2 - 1]! + percents[percents.length / 2]!) / 2) : null;
  const durations = completed.map((a) => a.durationMs).filter((d): d is number => d !== null);

  const daily = new Map(store.dailyAttempts(guild.id, since30(), quiz.id).map((d) => [d.date, d.attempts]));
  const days: { date: string; attempts: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    days.push({ date, attempts: daily.get(date) ?? 0 });
  }

  const outcomeCounts = new Map<string, number>();
  for (const a of completed) if (a.outcomeId) outcomeCounts.set(a.outcomeId, (outcomeCounts.get(a.outcomeId) ?? 0) + 1);

  const askedCount = new Map<number, number>();
  for (const a of completed) for (const id of a.questionOrder) askedCount.set(id, (askedCount.get(id) ?? 0) + 1);

  const byQuestion = new Map<number, typeof answers>();
  for (const a of answers) byQuestion.set(a.questionId, [...(byQuestion.get(a.questionId) ?? []), a]);

  const perQuestion: WebQuestionAnalytics[] = questions.map((q) => {
    const list = byQuestion.get(q.id) ?? [];
    const answered = list.filter((a) => !a.timedOut);
    const right = answered.filter((a) => a.correct && !a.late).length;
    const times = answered.map((a) => a.timeMs).filter((t) => t > 0);
    let distribution: WebAnswerBar[];
    if (q.type === "single" || q.type === "multi" || q.type === "truefalse") {
      const counts = new Map<string, number>();
      for (const a of answered) if (a.answer.kind === "options") for (const id of a.answer.optionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      distribution = q.options.map((o) => ({ key: o.id, label: o.text, count: counts.get(o.id) ?? 0, correct: graded && o.correct }));
    } else {
      const counts = new Map<string, { label: string; count: number; correct: boolean }>();
      for (const a of answered) {
        const label = answerText(q, a.answer).slice(0, 60);
        const key = label.toLowerCase();
        const cur = counts.get(key) ?? { label, count: 0, correct: Boolean(a.correct) };
        cur.count += 1;
        counts.set(key, cur);
      }
      distribution = [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([key, v]) => ({ key, label: v.label, count: v.count, correct: v.correct }));
    }
    return {
      questionId: q.id,
      position: q.position,
      type: q.type,
      prompt: q.prompt,
      asked: askedCount.get(q.id) ?? list.length,
      answered: answered.length,
      correct: right,
      percentCorrect: graded && answered.length ? Math.round((right / answered.length) * 1000) / 10 : null,
      avgTimeMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      timedOut: list.filter((a) => a.timedOut).length,
      distribution,
    };
  });

  const result: WebQuizAnalytics = {
    attempts: completed.length,
    inProgress: agg?.inProgress ?? 0,
    players: agg?.players ?? 0,
    avgPercent: graded ? (agg?.avgPercent ?? null) : null,
    medianPercent: graded && median !== null ? Math.round(median * 10) / 10 : null,
    passRate: graded && quiz.settings.passPercent > 0 ? (agg?.passRate ?? null) : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    scoreBuckets: buckets,
    daily: days,
    outcomes: quiz.outcomes.map((o) => ({ outcomeId: o.id, title: o.title, count: outcomeCounts.get(o.id) ?? 0 })),
    questions: perQuestion,
  };
  return ok(result);
}

async function leaderboardOf(guild: Guild, quiz: Quiz, limit: number): Promise<Reply> {
  const rows = store.leaderboard(guild.id, quiz.id, limit);
  const map = await people(guild, rows.map((r) => r.userId));
  const entries: WebLeaderboardEntry[] = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    person: map.get(r.userId) ?? unknown(r.userId),
    score: r.score,
    maxScore: r.maxScore,
    percent: r.percent,
    durationMs: r.durationMs,
    attemptId: r.attemptId,
    finishedAt: iso(r.finishedAt),
    attempts: r.attempts,
  }));
  return ok({ entries });
}

async function attemptsOf(guild: Guild, quiz: Quiz, query: URLSearchParams): Promise<Reply> {
  const statusRaw = query.get("status") ?? "";
  const status = (["in_progress", "completed", "expired"] as AttemptStatus[]).includes(statusRaw as AttemptStatus) ? (statusRaw as AttemptStatus) : undefined;
  const q = (query.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 25));
  const offset = Math.max(0, Number(query.get("offset")) || 0);
  let userIds: string[] | undefined;
  if (q) {
    if (/^\d{15,22}$/.test(q)) userIds = [q];
    else {
      // Search by name among members who took this quiz.
      const all = store.listAttempts(guild.id, { quizId: quiz.id, limit: 500 }).attempts;
      const map = await people(guild, all.map((a) => a.userId));
      userIds = [...map.values()].filter((p) => p.name.toLowerCase().includes(q) || (p.username ?? "").toLowerCase().includes(q)).map((p) => p.id);
    }
  }
  const { attempts, total } = store.listAttempts(guild.id, { quizId: quiz.id, status, userIds, limit, offset });
  return ok({ attempts: await attemptRows(guild, attempts), total });
}

async function attemptDetail(guild: Guild, attemptId: number): Promise<Reply> {
  const attempt = store.getAttempt(guild.id, attemptId);
  if (!attempt) return bad("Attempt not found", 404);
  const quiz = store.getQuiz(guild.id, attempt.quizId);
  const questions = new Map(store.getQuestionsByIds(attempt.questionOrder).map((q) => [q.id, q]));
  const answers = new Map(store.listAnswers(attempt.id).map((a) => [a.questionId, a]));
  const outcomeTitle = (ids: string[]) => ids.map((id) => quiz?.outcomes.find((o) => o.id === id)?.title ?? id).join(", ");
  const rows: WebAttemptAnswer[] = attempt.questionOrder.map((qid, i) => {
    const q = questions.get(qid);
    const a = answers.get(qid);
    if (!q) {
      return { position: i, questionId: qid, prompt: "Removed question", type: "single", answerText: a ? "Answered" : "No answer", correctText: "", correct: a?.correct ?? null, credit: a?.credit ?? 0, points: a?.points ?? 0, maxPoints: 0, timeMs: a?.timeMs ?? 0, late: a?.late ?? false, timedOut: a?.timedOut ?? false };
    }
    const chosenOutcomes =
      quiz?.kind === "personality" && a?.answer.kind === "options"
        ? outcomeTitle([...new Set(a.answer.optionIds.flatMap((id) => Object.keys(q.options.find((o) => o.id === id)?.outcomes ?? {})))])
        : "";
    return {
      position: i,
      questionId: qid,
      prompt: q.prompt,
      type: q.type,
      answerText: a ? (a.timedOut ? "Out of time" : answerText(q, a.answer)) : attempt.status === "in_progress" ? "Not answered yet" : "No answer",
      correctText: quiz?.kind === "personality" ? chosenOutcomes : correctAnswerText(q),
      correct: a?.correct ?? null,
      credit: a?.credit ?? 0,
      points: a?.points ?? 0,
      maxPoints: quiz?.kind === "personality" ? 0 : q.points,
      timeMs: a?.timeMs ?? 0,
      late: a?.late ?? false,
      timedOut: a?.timedOut ?? false,
    };
  });
  const result: WebQuizAttemptDetail = { attempt: (await attemptRows(guild, [attempt]))[0]!, answers: rows };
  return ok(result);
}

async function insights(guild: Guild): Promise<Reply> {
  const quizzes = store.listQuizzes(guild.id);
  const titles = new Map(quizzes.map((q) => [q.id, q.title]));
  const totals = store.guildAttemptTotals(guild.id, since30());
  const aggs = store.attemptAggregates(guild.id, since30());
  const running = store.runningGames(guild.id);
  const daily = new Map(store.dailyAttempts(guild.id, since30()).map((d) => [d.date, d]));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    days.push({ date, attempts: daily.get(date)?.attempts ?? 0, players: daily.get(date)?.players ?? 0 });
  }
  const board = store.serverLeaderboard(guild.id, 10);
  const map = await people(guild, board.map((b) => b.user_id));
  const hardestRaw = store.hardestQuestions(guild.id, 8);
  const qById = new Map(store.getQuestionsByIds(hardestRaw.map((h) => h.question_id)).map((q) => [q.id, q]));
  const recent = store.listAttempts(guild.id, { status: "finished", limit: 15 }).attempts;
  const result: WebQuizInsights = {
    totals: {
      quizzes: quizzes.length,
      published: quizzes.filter((q) => q.status === "published").length,
      attempts: totals.attempts ?? 0,
      attempts30d: totals.attempts30d ?? 0,
      players: totals.players ?? 0,
      avgPercent: totals.avg30d === null || totals.avg30d === undefined ? null : Math.round(totals.avg30d * 10) / 10,
      // Games played (running or finished), not counting ones cancelled before they started.
      liveGames: store.recentGames(guild.id, 10_000).filter((g) => g.status !== "cancelled" || g.currentIndex >= 0).length,
    },
    daily: days,
    leaderboard: board.map((b, i) => ({ rank: i + 1, person: map.get(b.user_id) ?? unknown(b.user_id), quizzes: b.quizzes, passed: b.passed, totalScore: b.total_score, avgPercent: b.avg_percent })),
    topQuizzes: quizzes
      .map((q) => ({ id: q.id, title: q.title, attempts30d: aggs.get(q.id)?.attempts30d ?? 0, avgPercent: q.kind === "graded" ? (aggs.get(q.id)?.avgPercent ?? null) : null }))
      .filter((q) => q.attempts30d > 0)
      .sort((a, b) => b.attempts30d - a.attempts30d)
      .slice(0, 8),
    hardest: hardestRaw
      .filter((h) => qById.has(h.question_id))
      .map((h) => ({ quizId: h.quiz_id, quizTitle: titles.get(h.quiz_id) ?? "", questionId: h.question_id, prompt: qById.get(h.question_id)!.prompt, percentCorrect: Math.round((h.correct / Math.max(1, h.answered)) * 1000) / 10, answered: h.answered })),
    recent: await attemptRows(guild, recent),
    live: await liveList(guild, [...running, ...store.recentGames(guild.id, 10).filter((g) => !store.RUNNING.includes(g.status))].slice(0, 12)),
  };
  return ok(result);
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportCsv(guild: Guild, quiz: Quiz): Promise<Reply> {
  const questions = store.listQuestions(quiz.id);
  const { attempts } = store.listAttempts(guild.id, { quizId: quiz.id, status: "finished", limit: 500 });
  const map = await people(guild, attempts.map((a) => a.userId));
  const header = ["attempt_id", "user_id", "name", "status", "started_at", "finished_at", "duration_seconds"];
  if (quiz.kind === "graded") header.push("score", "max_score", "percent", "passed", "correct");
  else header.push("result");
  questions.forEach((q, i) => header.push(`q${i + 1}: ${q.prompt.slice(0, 60)}`));
  const lines = [header.map(csvCell).join(",")];
  for (const a of attempts) {
    const answers = new Map(store.listAnswers(a.id).map((x) => [x.questionId, x]));
    const row: unknown[] = [a.id, a.userId, map.get(a.userId)?.name ?? a.userId, a.status, a.startedAt.toISOString(), iso(a.finishedAt) ?? "", a.durationMs !== null ? Math.round(a.durationMs / 1000) : ""];
    if (quiz.kind === "graded") row.push(a.score, a.maxScore, a.percent, a.passed === null ? "" : a.passed ? "yes" : "no", a.correctCount);
    else row.push(quiz.outcomes.find((o) => o.id === a.outcomeId)?.title ?? "");
    for (const q of questions) {
      const ans = answers.get(q.id);
      if (!a.questionOrder.includes(q.id)) row.push("");
      else if (!ans) row.push("(no answer)");
      else row.push(`${ans.timedOut ? "(out of time)" : answerText(q, ans.answer)}${quiz.kind === "graded" ? (ans.correct && !ans.late ? " [right]" : ans.credit > 0 ? " [partial]" : " [wrong]") : ""}`);
    }
    lines.push(row.map(csvCell).join(","));
  }
  const slug = quiz.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "quiz";
  return ok({ filename: `${slug}-results.csv`, csv: lines.join("\r\n") });
}

// -- Writes ------------------------------------------------------------------------------------------

async function create(guild: Guild, userId: string, body: Record<string, unknown>): Promise<Reply & { quiz?: Quiz }> {
  if (store.countQuizzes(guild.id) >= QUIZ_LIMITS.perGuild) return bad(`A server can have up to ${QUIZ_LIMITS.perGuild} quizzes. Delete some old ones first.`);
  const status: QuizStatus = body.status === "published" ? "published" : "draft";
  const config = await getQuizzesConfig(guild.id);
  const defaults = {
    shuffleQuestions: config.default_shuffle_questions,
    shuffleAnswers: config.default_shuffle_answers,
    questionTimeLimitSec: config.default_question_seconds,
    revealMode: config.default_reveal_mode,
    maxAttempts: config.default_max_attempts,
    cooldownMinutes: config.default_cooldown_minutes,
  };
  const withDefaults = { ...body, settings: { ...defaults, ...((body.settings as Record<string, unknown>) ?? {}) } };
  const clean = cleanQuizInput(withDefaults, null, { strict: status === "published" });
  if (!clean.ok) return bad(clean.error);
  const problem = await targetsProblem(guild, clean.quiz);
  if (problem) return bad(problem);
  const refusal = await rewardRolesRefusal(guild, userId, clean.quiz, null);
  if (refusal) return refusal;
  const quiz = store.createQuiz(guild.id, clean.quiz, userId, status);
  store.addEvent(guild.id, quiz.id, "created", userId, status === "published" ? "Published straight away" : null);
  return { ...ok({ quiz: fullQuiz(quiz) }), quiz };
}

async function update(guild: Guild, userId: string, quiz: Quiz, body: Record<string, unknown>): Promise<Reply> {
  const clean = cleanQuizInput(body, asClean(quiz), { strict: quiz.status === "published" });
  if (!clean.ok) return bad(clean.error);
  const problem = await targetsProblem(guild, clean.quiz);
  if (problem) return bad(problem);
  const refusal = await rewardRolesRefusal(guild, userId, clean.quiz, asClean(quiz));
  if (refusal) return refusal;
  const updated = store.updateQuizFields(guild.id, quiz.id, clean.quiz, body.questions !== undefined);
  if (!updated) return bad("Quiz not found", 404);
  store.addEvent(guild.id, quiz.id, "edited", userId, body.questions !== undefined ? `${clean.quiz.questions.length} questions` : null);
  await refreshPanel(guild, updated).catch(() => null);
  return ok({ quiz: fullQuiz(updated) });
}

async function setStatus(guild: Guild, userId: string, quiz: Quiz, next: QuizStatus): Promise<Reply> {
  if (!QUIZ_STATUSES.includes(next)) return bad("Unknown status.");
  if (next === quiz.status) return ok({ quiz: fullQuiz(quiz) });
  if (next === "published") {
    const problem = publishProblem(asClean(quiz));
    if (problem) return bad(problem);
    if (quiz.closesAt && quiz.closesAt.getTime() <= Date.now()) return bad("The close date has passed. Change or clear it before publishing again.");
  }
  const updated = store.setQuizStatus(guild.id, quiz.id, next);
  if (!updated) return bad("Quiz not found", 404);
  const kind = next === "published" ? (quiz.status === "draft" ? "published" : "reopened") : next === "draft" ? "edited" : next;
  store.addEvent(guild.id, quiz.id, kind, userId, next === "draft" ? "Moved back to draft" : null);
  if (next !== "published") {
    // Unfinished attempts on a closed quiz are scored as they stand.
    const { closeAttempt } = await import("../plugins/quizzes/functions/run.js");
    const questions = store.listQuestions(quiz.id);
    for (const a of store.listAttempts(guild.id, { quizId: quiz.id, status: "in_progress", limit: 500 }).attempts) closeAttempt(guild, updated, questions, a, "expired");
  }
  await refreshPanel(guild, updated).catch(() => null);
  return ok({ quiz: fullQuiz(updated) });
}

function duplicate(guild: Guild, userId: string, quiz: Quiz): Reply {
  if (store.countQuizzes(guild.id) >= QUIZ_LIMITS.perGuild) return bad(`A server can have up to ${QUIZ_LIMITS.perGuild} quizzes.`);
  const clean = asClean(quiz);
  const copy = store.createQuiz(guild.id, { ...clean, title: `${quiz.title} (copy)`.slice(0, QUIZ_LIMITS.title), questions: clean.questions.map((q) => ({ ...q, id: 0 })) }, userId, "draft");
  store.addEvent(guild.id, copy.id, "duplicated", userId, `From "${quiz.title}"`);
  return ok({ quiz: fullQuiz(copy) });
}

// -- Routing -----------------------------------------------------------------------------------------

export type QuizzesRequest = {
  client: Client;
  guild: Guild;
  userId: string;
  method: string;
  /** Path after /quizzes ("" for the root). */
  subPath: string;
  query: URLSearchParams;
  readJson: () => Promise<Record<string, unknown> | null>;
  managesServer: boolean;
};

/** Manage Server, or the plugin's can_manage flag. */
export async function canManageQuizzes(guild: Guild, userId: string, managesServer: boolean): Promise<boolean> {
  if (managesServer) return true;
  try {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    return await hasPermission(guild.id, "quizzes", "can_manage", member, guildConfig);
  } catch {
    return false;
  }
}

function track(client: Client, guildId: string, userId: string, title: string, summary: string, targetId: string, payload: Record<string, unknown>): void {
  void trackDashboardAction(client, guildId, userId, { eventType: "dashboard_quiz", title, summary, targetId, payload });
}

export async function handleQuizzesRequest(r: QuizzesRequest): Promise<Reply> {
  if (!(await canManageQuizzes(r.guild, r.userId, r.managesServer))) return bad("You need Manage Server or the Quizzes manage permission.", 403);
  const parts = r.subPath.split("/").filter(Boolean);
  const { guild, userId, method, client } = r;
  const m = method.toUpperCase();

  try {
    if (!parts.length) {
      if (m === "GET") return await listAll(guild);
      if (m === "POST") {
        const body = await r.readJson();
        if (!body) return bad("Invalid JSON body");
        const result = await create(guild, userId, body);
        if (result.quiz) track(client, guild.id, userId, "Quiz created", `Quiz \`${result.quiz.title}\` was created from the dashboard.`, String(result.quiz.id), { action: "create", quizId: result.quiz.id });
        return { status: result.status, body: result.body };
      }
      return bad("Method not allowed", 405);
    }

    const [first, second, third] = parts;

    if (first === "insights" && parts.length === 1) return m === "GET" ? await insights(guild) : bad("Method not allowed", 405);

    if (first === "live") {
      if (parts.length === 1 && m === "GET") {
        const games = [...store.runningGames(guild.id), ...store.recentGames(guild.id, 20).filter((g) => !store.RUNNING.includes(g.status))];
        return ok({ games: await liveList(guild, games) });
      }
      if (parts.length === 3 && third === "stop" && m === "POST") {
        const game = store.getLiveGameForGuild(guild.id, Number(second));
        if (!game) return bad("Live game not found", 404);
        const ended = await stopLiveGame(game, userId);
        track(client, guild.id, userId, "Live quiz stopped", `Live game \`#${game.id}\` was stopped from the dashboard.`, String(game.quizId), { action: "live_stop", gameId: game.id });
        const fresh = store.getLiveGameForGuild(guild.id, game.id) ?? ended ?? game;
        return ok({ game: (await liveList(guild, [fresh]))[0] });
      }
      return bad("Not found", 404);
    }

    if (first === "import" && parts.length === 1) {
      if (m !== "POST") return bad("Method not allowed", 405);
      const body = await r.readJson();
      if (!body) return bad("Invalid JSON body");
      const text = typeof body.text === "string" ? body.text.slice(0, 200_000) : "";
      if (!text.trim()) return bad("Paste some questions to import.");
      const kind = body.kind === "personality" ? "personality" : "graded";
      const existing = Array.isArray(body.outcomes) ? (await import("../plugins/quizzes/functions/validate.js")).normalizeOutcomes(body.outcomes) : [];
      const result = body.format === "csv" ? parseQuestionCsv(text, kind, existing) : parseQuestionText(text, kind, existing);
      return ok(result);
    }

    if (first === "generate" && parts.length === 1) {
      if (m !== "POST") return bad("Method not allowed", 405);
      const body = await r.readJson();
      if (!body) return bad("Invalid JSON body");
      const parsed = parseGenerateRequest(body);
      if (!parsed.ok) {
        const status = await getAiGateStatus(guild.id);
        return { status: 400, body: { error: parsed.error, freeUsesRemaining: status.freeUsesRemaining } };
      }
      const gate = await consumeAiGate(guild.id);
      if (!gate.ok) return { status: gate.status, body: { error: gate.error, freeUsesRemaining: gate.freeUsesRemaining } };
      try {
        const draft = await generateQuizDraft(parsed.value);
        if (!draft.questions.length) throw new Error("Autopilot didn't write any usable questions. Try a clearer topic.");
        track(client, guild.id, userId, "Quiz questions generated", `Autopilot drafted ${draft.questions.length} quiz questions from the dashboard.`, "", { action: "generate", count: draft.questions.length });
        return ok({ ...draft, oneActive: gate.oneActive, freeUsesRemaining: gate.freeUsesRemaining });
      } catch (error) {
        if (!gate.oneActive) await refundFreeAiUse(guild.id).catch(() => null);
        const status = await getAiGateStatus(guild.id);
        const message = error instanceof Error && error.message.startsWith("Autopilot") ? error.message : "Autopilot couldn't write questions right now. Please try again.";
        log.warn("Quiz generate failed:", error);
        return { status: 502, body: { error: message, freeUsesRemaining: status.freeUsesRemaining } };
      }
    }

    if (first === "attempts" && parts.length === 2) {
      const attemptId = Number(second);
      if (m === "GET") return await attemptDetail(guild, attemptId);
      if (m === "DELETE") {
        const deleted = store.deleteAttempt(guild.id, attemptId);
        if (!deleted) return bad("Attempt not found", 404);
        store.addEvent(guild.id, deleted.quizId, "attempt_deleted", userId, `${(await person(guild, deleted.userId)).name}'s attempt #${deleted.id}`);
        track(client, guild.id, userId, "Quiz attempt deleted", `Attempt \`#${deleted.id}\` by <@${deleted.userId}> was deleted from the dashboard.`, String(deleted.quizId), { action: "attempt_delete", attemptId });
        return ok({ ok: true });
      }
      return bad("Method not allowed", 405);
    }

    // Everything else is /quizzes/:id[/action]
    const quizIdNum = Number(first);
    if (!Number.isInteger(quizIdNum) || quizIdNum <= 0) return bad("Not found", 404);
    const quiz = store.getQuiz(guild.id, quizIdNum);
    if (!quiz) return bad("Quiz not found", 404);

    if (parts.length === 1) {
      if (m === "GET") return await detail(guild, quiz);
      if (m === "PATCH") {
        const body = await r.readJson();
        if (!body) return bad("Invalid JSON body");
        const result = await update(guild, userId, quiz, body);
        if (result.status === 200) track(client, guild.id, userId, "Quiz edited", `Quiz \`${quiz.title}\` was edited from the dashboard.`, String(quiz.id), { action: "edit", quizId: quiz.id });
        return result;
      }
      if (m === "DELETE") {
        for (const g of store.runningGames(guild.id).filter((x) => x.quizId === quiz.id)) await stopLiveGame(g, userId).catch(() => null);
        // Its panel goes too, so nobody presses Start on a quiz that's gone.
        if (quiz.panelChannelId && quiz.panelMessageId) {
          const channel = await fetchGuildTextChannel(guild.client, guild.id, quiz.panelChannelId);
          await channel?.messages.delete(quiz.panelMessageId).catch(() => null);
        }
        store.deleteQuiz(guild.id, quiz.id);
        track(client, guild.id, userId, "Quiz deleted", `Quiz \`${quiz.title}\` was deleted from the dashboard.`, String(quiz.id), { action: "delete", quizId: quiz.id });
        return ok({ ok: true });
      }
      return bad("Method not allowed", 405);
    }

    const action = second;
    if (m === "GET") {
      if (action === "analytics") return analytics(guild, quiz);
      if (action === "leaderboard") return await leaderboardOf(guild, quiz, Math.min(100, Math.max(1, Number(r.query.get("limit")) || 25)));
      if (action === "attempts") return await attemptsOf(guild, quiz, r.query);
      if (action === "export") return await exportCsv(guild, quiz);
      return bad("Not found", 404);
    }
    if (m !== "POST") return bad("Method not allowed", 405);
    const body = (await r.readJson()) ?? {};

    if (action === "duplicate") {
      const result = duplicate(guild, userId, quiz);
      track(client, guild.id, userId, "Quiz duplicated", `Quiz \`${quiz.title}\` was duplicated from the dashboard.`, String(quiz.id), { action: "duplicate", quizId: quiz.id });
      return result;
    }
    if (action === "status") {
      const next = body.status as QuizStatus;
      const result = await setStatus(guild, userId, quiz, next);
      if (result.status === 200) track(client, guild.id, userId, `Quiz ${next}`, `Quiz \`${quiz.title}\` is now ${next} (dashboard).`, String(quiz.id), { action: "status", status: next, quizId: quiz.id });
      return result;
    }
    if (action === "post") {
      const channelId = typeof body.channelId === "string" ? body.channelId : "";
      const result = await postPanel(guild, quiz, channelId, userId);
      if ("error" in result) return bad(result.error);
      track(client, guild.id, userId, "Quiz panel posted", `The panel for \`${quiz.title}\` was posted in <#${channelId}> from the dashboard.`, String(quiz.id), { action: "post", quizId: quiz.id, channelId });
      return ok({ quiz: fullQuiz(result.quiz), messageUrl: result.url });
    }
    if (action === "live") {
      const channelId = typeof body.channelId === "string" ? body.channelId : "";
      const result = await startLiveGame({
        guild,
        quiz,
        channelId,
        hostId: userId,
        questionCount: typeof body.questionCount === "number" ? body.questionCount : null,
        questionSeconds: typeof body.questionSeconds === "number" ? body.questionSeconds : null,
      });
      if ("error" in result) return bad(result.error);
      track(client, guild.id, userId, "Live quiz started", `A live game of \`${quiz.title}\` was started in <#${channelId}> from the dashboard.`, String(quiz.id), { action: "live_start", quizId: quiz.id, gameId: result.game.id });
      return ok({ game: (await liveList(guild, [result.game]))[0] });
    }
    if (action === "reset") {
      const target = typeof body.userId === "string" && /^\d{15,22}$/.test(body.userId) ? body.userId : undefined;
      const deleted = store.resetAttempts(guild.id, quiz.id, target);
      store.addEvent(guild.id, quiz.id, "reset", userId, target ? `${(await person(guild, target)).name}, ${deleted} attempts` : `Every attempt (${deleted})`);
      track(client, guild.id, userId, "Quiz attempts reset", `${deleted} attempts on \`${quiz.title}\` were cleared${target ? ` for <@${target}>` : ""} from the dashboard.`, String(quiz.id), { action: "reset", quizId: quiz.id, targetUserId: target ?? null, deleted });
      await refreshPanel(guild, quiz).catch(() => null);
      return ok({ deleted });
    }
    return bad("Not found", 404);
  } catch (error) {
    log.error("Quizzes bridge request failed:", error);
    return bad("Something went wrong with that quiz request.", 500);
  }
}

export { isLivePlayable };
export type { QuizInput, QuizQuestion };
