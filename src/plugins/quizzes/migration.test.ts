/**
 * 0151_quizzes.sql on a fresh database (every migration in order), then the store: question ids
 * survive edits, one open attempt per member, answers are idempotent, finishing happens once,
 * leaderboards rank best score then fastest, resets and deletes clean up, one live game per
 * channel and one live answer per player per question.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-quizzes-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();
const store = await import("./functions/store.js");
const { closeAttempt } = await import("./functions/run.js");
const { cleanQuizInput } = await import("./functions/validate.js");
const { getDb } = await import("../../db/client.js");

const GUILD = "123456789012345678";
const OTHER_GUILD = "223456789012345678";
const U1 = "300000000000000001";
const U2 = "300000000000000002";
const U3 = "300000000000000003";

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

function makeQuiz() {
  const clean = cleanQuizInput(
    {
      title: "Capitals",
      settings: { shuffleQuestions: false, passPercent: 50 },
      questions: [
        { type: "single", prompt: "France?", points: 2, options: [{ id: "a", text: "Paris", correct: true }, { id: "b", text: "Rome" }] },
        { type: "truefalse", prompt: "Tokyo is in Japan", options: [{ text: "True", correct: true }, { text: "False" }] },
        { type: "text", prompt: "Capital of Italy?", accepted: ["Rome"] },
      ],
    },
    null,
    { strict: true },
  );
  assert.ok(clean.ok);
  return { quiz: store.createQuiz(GUILD, clean.quiz, U1, "published"), clean: clean.quiz };
}

describe("0151 quizzes migration and store", () => {
  it("creates the tables and keeps question ids across edits", () => {
    const { quiz, clean } = makeQuiz();
    const before = store.listQuestions(quiz.id);
    assert.equal(before.length, 3);
    assert.equal(store.getQuiz(OTHER_GUILD, quiz.id), null, "scoped by guild");
    // Reorder, edit one, drop one, add one.
    const edited = [{ ...before[1]!, prompt: "Tokyo is the capital of Japan" }, before[0]!, { ...before[0]!, id: 0, prompt: "Germany?" }];
    store.updateQuizFields(GUILD, quiz.id, { ...clean, questions: edited }, true);
    const after = store.listQuestions(quiz.id);
    assert.deepEqual(after.map((q) => q.prompt), ["Tokyo is the capital of Japan", "France?", "Germany?"]);
    assert.equal(after[0]!.id, before[1]!.id);
    assert.equal(after[1]!.id, before[0]!.id);
    assert.ok(!after.some((q) => q.id === before[2]!.id), "removed question is gone");
    assert.ok(store.deleteQuiz(GUILD, quiz.id));
  });

  it("keeps one open attempt per member and records each answer once", () => {
    const { quiz } = makeQuiz();
    const questions = store.listQuestions(quiz.id);
    const order = questions.map((q) => q.id);
    const a = store.createAttempt({ guildId: GUILD, quizId: quiz.id, userId: U1, seed: "s", questionOrder: order, maxScore: 4, deadlineAt: null });
    const again = store.createAttempt({ guildId: GUILD, quizId: quiz.id, userId: U1, seed: "s2", questionOrder: order, maxScore: 4, deadlineAt: null });
    assert.equal(again.id, a.id, "second Start resumes the first attempt");

    const answer = { attempt: a, index: 0, questionId: order[0]!, answer: { kind: "options" as const, optionIds: ["a"] }, correct: true, credit: 1, points: 2, timeMs: 900, late: false, timedOut: false, awaitNext: false };
    assert.equal(store.recordAnswer(answer), true);
    assert.equal(store.recordAnswer(answer), false, "double press changes nothing");
    let fresh = store.getAttempt(GUILD, a.id)!;
    assert.equal(fresh.currentIndex, 1);
    assert.equal(fresh.score, 2);
    assert.equal(fresh.streak, 1);
    store.recordAnswer({ ...answer, attempt: fresh, index: 1, questionId: order[1]!, answer: { kind: "options", optionIds: ["t"] }, points: 1 });
    fresh = store.getAttempt(GUILD, a.id)!;
    store.recordAnswer({ ...answer, attempt: fresh, index: 2, questionId: order[2]!, answer: { kind: "text", text: "Paris" }, correct: false, credit: 0, points: 0 });
    fresh = store.getAttempt(GUILD, a.id)!;
    assert.equal(fresh.bestStreak, 2);
    assert.equal(fresh.streak, 0);

    const closed = closeAttempt({ id: GUILD }, quiz, questions, fresh);
    assert.ok(closed);
    assert.equal(closed!.status, "completed");
    assert.equal(closed!.score, 3);
    assert.equal(closed!.maxScore, 4);
    assert.equal(closed!.percent, 75);
    assert.equal(closed!.passed, true);
    assert.equal(closeAttempt({ id: GUILD }, quiz, questions, fresh), null, "finishing twice does nothing");
    assert.equal(store.memberAttemptStats(quiz.id, U1).finished, 1);
    store.deleteQuiz(GUILD, quiz.id);
  });

  it("ranks the leaderboard by best score, then fastest", () => {
    const { quiz } = makeQuiz();
    const order = store.listQuestions(quiz.id).map((q) => q.id);
    const finish = (userId: string, score: number, durationMs: number) => {
      const a = store.createAttempt({ guildId: GUILD, quizId: quiz.id, userId, seed: "x", questionOrder: order, maxScore: 4, deadlineAt: null });
      store.finishAttempt(a.id, "completed", { score, maxScore: 4, percent: score * 25, passed: score >= 2, outcomeId: null, correctCount: score, bestStreak: 0, durationMs });
    };
    finish(U1, 3, 30_000);
    finish(U1, 4, 50_000);
    finish(U2, 4, 20_000);
    finish(U3, 2, 5_000);
    const board = store.leaderboard(GUILD, quiz.id, 10);
    assert.deepEqual(board.map((r) => [r.userId, r.score]), [[U2, 4], [U1, 4], [U3, 2]]);
    assert.equal(board[1]!.attempts, 2);
    assert.deepEqual(store.rankOf(GUILD, quiz.id, 4, 50_000, U1), { rank: 2, total: 3 });
    assert.equal(store.leaderboard(OTHER_GUILD, quiz.id, 10).length, 0, "scoped by guild");
    const server = store.serverLeaderboard(GUILD, 10);
    assert.equal(server[0]!.user_id, U1);

    assert.equal(store.resetAttempts(GUILD, quiz.id, U1), 2);
    assert.equal(store.leaderboard(GUILD, quiz.id, 10).length, 2);
    assert.equal(store.resetAttempts(GUILD, quiz.id), 2);
    store.deleteQuiz(GUILD, quiz.id);
  });

  it("allows one live game per channel and one answer per player per question", () => {
    const { quiz } = makeQuiz();
    const base = {
      guildId: GUILD,
      quizId: quiz.id,
      channelId: "400000000000000001",
      hostId: U1,
      questionOrder: [1],
      optionOrders: {},
      phaseEndsAt: null,
      questionSeconds: 20,
      revealSeconds: 5,
      speedBonus: true,
      startedAt: new Date(),
    };
    const game = store.createLiveGame(base);
    assert.ok(game);
    assert.equal(store.createLiveGame(base), null, "second game in the same channel is refused");
    const input = { gameId: game!.id, questionIndex: 0, userId: U2, optionId: "a", correct: true, timeMs: 1200, score: (streak: number) => 1000 + streak * 100 };
    assert.deepEqual(store.recordLiveAnswer(input), { points: 1000, streak: 1 });
    assert.equal(store.recordLiveAnswer(input), null);
    assert.deepEqual(store.recordLiveAnswer({ ...input, questionIndex: 1 }), { points: 1100, streak: 2 });
    store.breakStreaksForMissing(game!.id, 2);
    assert.equal(store.livePlayers(game!.id)[0]!.streak, 0);
    assert.equal(store.livePlayers(game!.id)[0]!.score, 2100);
    const ended = store.transitionGame(game!.id, store.RUNNING, { status: "cancelled", endedAt: new Date() });
    assert.equal(ended?.status, "cancelled");
    assert.equal(store.transitionGame(game!.id, store.RUNNING, { status: "finished" }), null, "a stopped game can't be moved again");
    assert.ok(store.createLiveGame(base), "a new game can start once the old one ended");
    store.deleteQuiz(GUILD, quiz.id);
    assert.equal(store.runningGames(GUILD).length, 0, "deleting the quiz removes its games");
  });
});
