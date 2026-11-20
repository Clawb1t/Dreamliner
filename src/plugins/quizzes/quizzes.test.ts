import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allowedTypos, editDistance, gradeAnswer, matchNumberAnswer, matchTypedAnswer, multiSelectCredit, normalizeAnswer, parseNumberAnswer } from "./functions/matching.js";
import { attemptTotals, compareAttempts, hasPassed, isLate, LATE_GRACE_MS, livePoints, pointsFor, rankLive, resolveOutcome, streakCallout } from "./functions/scoring.js";
import { optionOrder, pickQuestionOrder } from "./functions/shuffle.js";
import { checkEligibility, quizIsOpen } from "./functions/rules.js";
import { parseCsv, parseQuestionCsv, parseQuestionText } from "./functions/importParser.js";
import { cleanQuizInput, normalizeQuestion, publishProblem } from "./functions/validate.js";
import { parseQuizId, quizId } from "./functions/customIds.js";
import { progressBar, reviewPayload } from "./functions/render.js";
import { DEFAULT_QUIZ_SETTINGS, type Quiz, type QuizAttempt, type QuizOutcome, type QuizQuestion } from "./functions/types.js";

function q(partial: Partial<QuizQuestion> & { id: number }): QuizQuestion {
  return {
    position: partial.id,
    type: "single",
    prompt: `Question ${partial.id}`,
    imageUrl: "",
    explanation: "",
    points: 1,
    timeLimitSec: 0,
    options: [],
    accepted: [],
    numberAnswer: null,
    numberTolerance: 0,
    partialCredit: false,
    typoTolerance: true,
    ...partial,
  };
}

const opt = (id: string, text: string, correct = false, outcomes: Record<string, number> = {}) => ({ id, text, correct, outcomes });

describe("typed answers", () => {
  it("normalises case, accents, punctuation and articles", () => {
    assert.equal(normalizeAnswer("  The Eiffel-Tower! "), "eiffel tower");
    assert.equal(normalizeAnswer("Pokémon"), "pokemon");
    assert.equal(normalizeAnswer("Rock & Roll"), "rock and roll");
    assert.equal(normalizeAnswer("A"), "a");
  });

  it("matches any accepted answer, ignoring spaces", () => {
    assert.ok(matchTypedAnswer("new york", ["New York City", "New York"], false));
    assert.ok(matchTypedAnswer("NEWYORK", ["New York"], false));
    assert.ok(!matchTypedAnswer("York", ["New York"], false));
    assert.ok(!matchTypedAnswer("", ["x"], true));
  });

  it("forgives small typos only when allowed and only on longer words", () => {
    assert.equal(allowedTypos(4), 0);
    assert.equal(allowedTypos(6), 1);
    assert.equal(allowedTypos(12), 2);
    assert.ok(matchTypedAnswer("Missisippi", ["Mississippi"], true));
    assert.ok(!matchTypedAnswer("Missisippi", ["Mississippi"], false));
    assert.ok(matchTypedAnswer("Jupitre", ["Jupiter"], true), "transposition counts as one typo");
    assert.ok(!matchTypedAnswer("cat", ["car"], true), "short words must be exact");
    assert.ok(!matchTypedAnswer("Jptr", ["Jupiter"], true));
  });

  it("never forgives a wrong number inside an answer", () => {
    assert.ok(!matchTypedAnswer("World War 1", ["World War 2"], true));
    assert.ok(!matchTypedAnswer("1941", ["1914"], true));
  });

  it("computes edit distance with an early cap", () => {
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("ab", "ba"), 1);
    assert.ok(editDistance("aaaaaaaa", "bbbbbbbb", 2) > 2);
  });
});

describe("number answers", () => {
  it("parses common formats", () => {
    assert.equal(parseNumberAnswer("1,234.5"), 1234.5);
    assert.equal(parseNumberAnswer("3,14"), 3.14);
    assert.equal(parseNumberAnswer(" -8 "), -8);
    assert.equal(parseNumberAnswer("1e3"), 1000);
    assert.equal(parseNumberAnswer("50%"), 50);
    assert.equal(parseNumberAnswer("eight"), null);
    assert.equal(parseNumberAnswer(""), null);
  });

  it("checks the tolerance", () => {
    assert.ok(matchNumberAnswer(8, 8, 0));
    assert.ok(matchNumberAnswer(0.1 + 0.2, 0.3, 0));
    assert.ok(matchNumberAnswer(9, 8, 1));
    assert.ok(!matchNumberAnswer(9.01, 8, 1));
    assert.ok(!matchNumberAnswer(8, null, 5));
  });
});

describe("multiple select", () => {
  it("is all or nothing without partial credit", () => {
    assert.equal(multiSelectCredit(["a", "b"], ["a", "b"], false), 1);
    assert.equal(multiSelectCredit(["a"], ["a", "b"], false), 0);
    assert.equal(multiSelectCredit(["a", "b", "c"], ["a", "b"], false), 0);
  });

  it("gives right minus wrong picks with partial credit, floored at zero", () => {
    assert.equal(multiSelectCredit(["a"], ["a", "b"], true), 0.5);
    assert.equal(multiSelectCredit(["a", "c"], ["a", "b"], true), 0);
    assert.equal(multiSelectCredit(["c", "d"], ["a", "b"], true), 0);
    assert.equal(multiSelectCredit(["a", "b", "c"], ["a", "b", "d"], true), 1 / 3);
  });

  it("grades through gradeAnswer", () => {
    const question = q({ id: 1, type: "multi", partialCredit: true, points: 4, options: [opt("a", "A", true), opt("b", "B", true), opt("c", "C")] });
    const g = gradeAnswer(question, { kind: "options", optionIds: ["a"] });
    assert.equal(g.correct, false);
    assert.equal(g.credit, 0.5);
    assert.equal(pointsFor(question, g.credit, false), 2);
    assert.equal(pointsFor(question, g.credit, true), 0, "late answers score nothing");
  });
});

describe("gradeAnswer", () => {
  it("handles every type", () => {
    const single = q({ id: 1, options: [opt("a", "Paris", true), opt("b", "Rome")] });
    assert.ok(gradeAnswer(single, { kind: "options", optionIds: ["a"] }).correct);
    assert.ok(!gradeAnswer(single, { kind: "options", optionIds: ["a", "b"] }).correct);
    const text = q({ id: 2, type: "text", accepted: ["Mercury"] });
    assert.ok(gradeAnswer(text, { kind: "text", text: "mercury!" }).correct);
    const num = q({ id: 3, type: "number", numberAnswer: 100, numberTolerance: 5 });
    assert.ok(gradeAnswer(num, { kind: "number", value: 97 }).correct);
    assert.ok(gradeAnswer(num, { kind: "text", text: "104" }).correct);
    assert.ok(!gradeAnswer(num, { kind: "none" }).correct);
  });
});

describe("scoring", () => {
  const asked = [q({ id: 1, points: 2 }), q({ id: 2 }), q({ id: 3 }), q({ id: 4 })];

  it("totals score, percent, right answers and best streak", () => {
    const totals = attemptTotals(asked, [
      { questionId: 1, credit: 1, points: 2, correct: true, late: false, timedOut: false },
      { questionId: 2, credit: 1, points: 1, correct: true, late: false, timedOut: false },
      { questionId: 3, credit: 0, points: 0, correct: false, late: false, timedOut: false },
      { questionId: 4, credit: 1, points: 0, correct: true, late: true, timedOut: false },
    ]);
    assert.deepEqual(totals, { score: 3, maxScore: 5, percent: 60, correctCount: 2, bestStreak: 2 });
  });

  it("counts unanswered questions as wrong", () => {
    const totals = attemptTotals(asked, []);
    assert.equal(totals.score, 0);
    assert.equal(totals.maxScore, 5);
    assert.equal(totals.percent, 0);
  });

  it("checks the pass mark", () => {
    assert.equal(hasPassed(70, 70), true);
    assert.equal(hasPassed(69.99, 70), false);
    assert.equal(hasPassed(10, 0), null);
  });

  it("ranks attempts by score, then speed", () => {
    const list = [
      { score: 5, durationMs: 9000, finishedAt: 1 },
      { score: 7, durationMs: 20000, finishedAt: 2 },
      { score: 7, durationMs: 15000, finishedAt: 3 },
    ].sort(compareAttempts);
    assert.deepEqual(list.map((a) => a.durationMs), [15000, 20000, 9000]);
  });

  it("calls out streaks", () => {
    assert.equal(streakCallout(2), null);
    assert.equal(streakCallout(3), "3 in a row!");
    assert.ok(streakCallout(15)?.includes("15"));
  });
});

describe("time limits", () => {
  it("allows answers inside the limit plus grace, rejects later ones", () => {
    const start = 1_000_000;
    assert.equal(isLate({ now: start + 10_000, questionStartedAt: start, limitSec: 10, deadlineAt: null }), false);
    assert.equal(isLate({ now: start + 10_000 + LATE_GRACE_MS, questionStartedAt: start, limitSec: 10, deadlineAt: null }), false);
    assert.equal(isLate({ now: start + 10_001 + LATE_GRACE_MS, questionStartedAt: start, limitSec: 10, deadlineAt: null }), true);
    assert.equal(isLate({ now: start + 999_999, questionStartedAt: start, limitSec: 0, deadlineAt: null }), false, "no limit");
  });

  it("enforces the whole-quiz deadline", () => {
    assert.equal(isLate({ now: 5000 + LATE_GRACE_MS + 1, questionStartedAt: 4900, limitSec: 0, deadlineAt: 5000 }), true);
    assert.equal(isLate({ now: 5000, questionStartedAt: 4900, limitSec: 0, deadlineAt: 5000 }), false);
  });
});

describe("personality outcomes", () => {
  const outcomes: QuizOutcome[] = [
    { id: "cat", title: "Cat", description: "", imageUrl: "", roleId: "", color: null },
    { id: "dog", title: "Dog", description: "", imageUrl: "", roleId: "", color: null },
    { id: "owl", title: "Owl", description: "", imageUrl: "", roleId: "", color: null },
  ];
  const questions = [
    q({ id: 1, options: [opt("a", "Nap", false, { cat: 2 }), opt("b", "Run", false, { dog: 2 }), opt("c", "Read", false, { owl: 2 })] }),
    q({ id: 2, options: [opt("a", "Night", false, { owl: 1, cat: 1 }), opt("b", "Day", false, { dog: 1 })] }),
    q({ id: 3, options: [opt("a", "Alone", false, { cat: 1 }), opt("b", "Pack", false, { dog: 1 })] }),
  ];

  it("picks the outcome with the most points", () => {
    const result = resolveOutcome(outcomes, questions, [
      { questionId: 1, answer: { kind: "options", optionIds: ["b"] } },
      { questionId: 2, answer: { kind: "options", optionIds: ["b"] } },
      { questionId: 3, answer: { kind: "options", optionIds: ["a"] } },
    ]);
    assert.equal(result?.id, "dog");
  });

  it("breaks ties by the most recent answer that pointed at a tied outcome", () => {
    // cat 2, owl 2 after Q1 (Read -> owl 2) + Q2 (Night -> owl 1, cat 1) + Q3 (Alone -> cat 1): owl 3, cat 2.
    // Use a real tie: Q1 Nap (cat 2), Q2 Day (dog 1), Q3 Pack (dog 1) -> cat 2, dog 2; last tied answer is dog.
    const result = resolveOutcome(outcomes, questions, [
      { questionId: 1, answer: { kind: "options", optionIds: ["a"] } },
      { questionId: 2, answer: { kind: "options", optionIds: ["b"] } },
      { questionId: 3, answer: { kind: "options", optionIds: ["b"] } },
    ]);
    assert.equal(result?.id, "dog");
  });

  it("falls back to the first listed outcome when nothing decides it", () => {
    assert.equal(resolveOutcome(outcomes, questions, [])?.id, "cat");
    assert.equal(resolveOutcome([], questions, []), null);
  });
});

describe("live points", () => {
  it("scales with speed and adds streak bonuses", () => {
    assert.equal(livePoints({ correct: false, timeMs: 0, limitMs: 20000, speedBonus: true, streakBefore: 4 }), 0);
    assert.equal(livePoints({ correct: true, timeMs: 0, limitMs: 20000, speedBonus: true, streakBefore: 0 }), 1000);
    assert.equal(livePoints({ correct: true, timeMs: 20000, limitMs: 20000, speedBonus: true, streakBefore: 0 }), 500);
    assert.equal(livePoints({ correct: true, timeMs: 10000, limitMs: 20000, speedBonus: true, streakBefore: 0 }), 750);
    assert.equal(livePoints({ correct: true, timeMs: 19000, limitMs: 20000, speedBonus: false, streakBefore: 2 }), 1200);
    assert.equal(livePoints({ correct: true, timeMs: 0, limitMs: 20000, speedBonus: true, streakBefore: 99 }), 1500, "streak bonus caps at 500");
  });

  it("orders players by score, right answers, then who joined first", () => {
    const ranked = rankLive([
      { userId: "a", score: 1000, correctCount: 1, joinedAt: 3 },
      { userId: "b", score: 1500, correctCount: 2, joinedAt: 2 },
      { userId: "c", score: 1000, correctCount: 2, joinedAt: 5 },
      { userId: "d", score: 1000, correctCount: 1, joinedAt: 1 },
    ]);
    assert.deepEqual(ranked.map((p) => p.userId), ["b", "c", "d", "a"]);
  });
});

describe("shuffling and pools", () => {
  const questions = Array.from({ length: 10 }, (_, i) => q({ id: i + 1, options: [opt("a", "A", true), opt("b", "B"), opt("c", "C"), opt("d", "D")] }));

  it("is deterministic per seed and differs across seeds", () => {
    const settings = { ...DEFAULT_QUIZ_SETTINGS, shuffleQuestions: true, poolSize: 0 };
    assert.deepEqual(pickQuestionOrder(questions, settings, "seed-1"), pickQuestionOrder(questions, settings, "seed-1"));
    const orders = new Set(["s1", "s2", "s3", "s4", "s5"].map((s) => pickQuestionOrder(questions, settings, s).join(",")));
    assert.ok(orders.size > 1);
    assert.deepEqual([...pickQuestionOrder(questions, settings, "seed-1")].sort((a, b) => a - b), questions.map((x) => x.id));
  });

  it("keeps quiz order without shuffling", () => {
    assert.deepEqual(pickQuestionOrder(questions, { ...DEFAULT_QUIZ_SETTINGS, shuffleQuestions: false }, "x"), questions.map((x) => x.id));
  });

  it("picks a random N from the pool, in quiz order when not shuffled", () => {
    const order = pickQuestionOrder(questions, { ...DEFAULT_QUIZ_SETTINGS, shuffleQuestions: false, poolSize: 4 }, "pool-seed");
    assert.equal(order.length, 4);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.equal(new Set(order).size, 4);
    assert.deepEqual(pickQuestionOrder(questions, { ...DEFAULT_QUIZ_SETTINGS, shuffleQuestions: false, poolSize: 4 }, "pool-seed"), order);
  });

  it("shuffles options per attempt but never true/false", () => {
    const a = optionOrder(questions[0]!, true, "s1").map((o) => o.id);
    assert.deepEqual(a, optionOrder(questions[0]!, true, "s1").map((o) => o.id));
    assert.deepEqual([...a].sort(), ["a", "b", "c", "d"]);
    const tf = q({ id: 99, type: "truefalse", options: [opt("t", "True", true), opt("f", "False")] });
    assert.deepEqual(optionOrder(tf, true, "s1").map((o) => o.id), ["t", "f"]);
    assert.deepEqual(optionOrder(questions[0]!, false, "s1").map((o) => o.id), ["a", "b", "c", "d"]);
  });
});

describe("attempt rules", () => {
  const base: Quiz = {
    id: 1,
    guildId: "1",
    kind: "graded",
    status: "published",
    title: "Quiz",
    description: "",
    coverImageUrl: "",
    color: null,
    category: "",
    tags: [],
    settings: { ...DEFAULT_QUIZ_SETTINGS },
    outcomes: [],
    opensAt: null,
    closesAt: null,
    panelChannelId: null,
    panelMessageId: null,
    createdBy: "1",
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: new Date(),
    lastError: null,
  };
  const now = 10_000_000;
  const input = (quiz: Partial<Quiz>, extra: Partial<Parameters<typeof checkEligibility>[0]> = {}) =>
    checkEligibility({ quiz: { ...base, ...quiz }, now, memberRoleIds: [], finishedAttempts: 0, lastFinishedAt: null, hasOpenAttempt: false, ...extra });

  it("needs a published quiz inside its window", () => {
    assert.equal(input({ status: "draft" }).ok, false);
    assert.equal(input({ status: "closed" }).ok, false);
    assert.equal(input({ opensAt: new Date(now + 1000) }).ok, false);
    assert.equal(input({ closesAt: new Date(now - 1) }).ok, false);
    assert.equal(input({}).ok, true);
    assert.equal(quizIsOpen({ ...base, closesAt: new Date(now + 5) }, now), true);
  });

  it("checks required and blocked roles", () => {
    const settings = { ...DEFAULT_QUIZ_SETTINGS, requiredRoleIds: ["r1", "r2"], blockedRoleIds: ["bad"] };
    assert.equal(input({ settings }, { memberRoleIds: [] }).ok, false);
    assert.equal(input({ settings }, { memberRoleIds: ["r2"] }).ok, true);
    assert.equal(input({ settings }, { memberRoleIds: ["r2", "bad"] }).ok, false);
  });

  it("limits attempts and enforces the cooldown", () => {
    const settings = { ...DEFAULT_QUIZ_SETTINGS, maxAttempts: 2, cooldownMinutes: 10 };
    const first = input({ settings });
    assert.ok(first.ok && first.attemptsLeft === 2);
    assert.equal(input({ settings }, { finishedAttempts: 2, lastFinishedAt: now - 3600_000 }).ok, false);
    const cooling = input({ settings }, { finishedAttempts: 1, lastFinishedAt: now - 60_000 });
    assert.ok(!cooling.ok && cooling.retryAt === now - 60_000 + 600_000);
    const ready = input({ settings }, { finishedAttempts: 1, lastFinishedAt: now - 600_001 });
    assert.ok(ready.ok && ready.attemptsLeft === 1);
  });

  it("always lets an unfinished attempt resume while the quiz is open", () => {
    const settings = { ...DEFAULT_QUIZ_SETTINGS, maxAttempts: 1, cooldownMinutes: 60 };
    assert.equal(input({ settings }, { finishedAttempts: 1, lastFinishedAt: now, hasOpenAttempt: true }).ok, true);
    assert.equal(input({ settings, status: "closed" }, { hasOpenAttempt: true }).ok, false);
  });
});

describe("import parser", () => {
  it("reads the text format with every question type", () => {
    const text = [
      "Q: What is the capital of France?",
      "* Paris",
      "- Berlin",
      "- Madrid",
      "E: Paris has been the capital for centuries.",
      "P: 2",
      "T: 30",
      "",
      "Which are planets?",
      "* Mars",
      "* Venus",
      "- The Moon",
      "",
      "Q: The sun is a star.",
      "TF: true",
      "",
      "Q: Name a primary colour.",
      "A: red | blue | yellow",
      "",
      "Q: How many legs does a spider have?",
      "N: 8",
      "",
      "Q: Pi to two decimals?",
      "N: 3.14 ~ 0.01",
    ].join("\n");
    const result = parseQuestionText(text, "graded");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.questions.map((x) => x.type), ["single", "multi", "truefalse", "text", "number", "number"]);
    const first = result.questions[0]!;
    assert.equal(first.prompt, "What is the capital of France?");
    assert.equal(first.points, 2);
    assert.equal(first.timeLimitSec, 30);
    assert.equal(first.explanation, "Paris has been the capital for centuries.");
    assert.deepEqual(first.options.filter((o) => o.correct).map((o) => o.text), ["Paris"]);
    assert.equal(result.questions[2]!.options.find((o) => o.text === "True")!.correct, true);
    assert.deepEqual(result.questions[3]!.accepted, ["red", "blue", "yellow"]);
    assert.equal(result.questions[5]!.numberTolerance, 0.01);
  });

  it("reports problems with line numbers and keeps the good questions", () => {
    const result = parseQuestionText("Q: No right answer here\n- A\n- B\n\nQ: Fine\n* Yes\n- No\n\nQ: Bad tf\nTF: maybe", "graded");
    assert.equal(result.questions.length, 1);
    assert.deepEqual(result.errors.map((e) => e.line), [1, 10]);
  });

  it("builds personality results from answer arrows", () => {
    const text = "RESULT: Explorer | Loves the outdoors\n\nQ: Weekend plans?\n- Hiking => Explorer\n- Painting => Artist:2\n- Both => Explorer, Artist";
    const result = parseQuestionText(text, "personality");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.outcomes.map((o) => o.title), ["Explorer", "Artist"]);
    assert.equal(result.outcomes[0]!.description, "Loves the outdoors");
    const options = result.questions[0]!.options;
    assert.deepEqual(options[1]!.outcomes, { [result.outcomes[1]!.id]: 2 });
    assert.equal(Object.keys(options[2]!.outcomes).length, 2);
  });

  it("parses CSV with quotes, a header and every type", () => {
    assert.deepEqual(parseCsv('a,"b, c","d ""e"""\n1,2,3').map((r) => r.cells), [["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
    const csv = [
      "question,type,options,correct,explanation,points,time_limit,image",
      'Capital of Japan?,single,Tokyo|Kyoto|Osaka,Tokyo,"Tokyo, since 1868",1,20,',
      "Prime numbers?,multi,2|4|5|9,1|3,,2,,",
      "Water is wet?,truefalse,,true,,,,",
      "Largest planet?,text,,Jupiter,,,,",
      "Days in a leap year?,number,,366,,,,",
      "Guess type,,A|B,B,,,,",
    ].join("\n");
    const result = parseQuestionCsv(csv, "graded");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.questions.map((x) => x.type), ["single", "multi", "truefalse", "text", "number", "single"]);
    assert.equal(result.questions[0]!.explanation, "Tokyo, since 1868");
    assert.deepEqual(result.questions[1]!.options.filter((o) => o.correct).map((o) => o.text), ["2", "5"]);
    assert.equal(result.questions[4]!.numberAnswer, 366);
  });

  it("flags CSV rows without a right answer", () => {
    const result = parseQuestionCsv("Which?,single,A|B,C", "graded");
    assert.equal(result.questions.length, 0);
    assert.equal(result.errors[0]!.line, 1);
  });
});

describe("validation", () => {
  it("forces true/false to exactly two options and single choice to one right answer", () => {
    const tf = normalizeQuestion({ type: "truefalse", prompt: "x", options: [{ text: "False", correct: true }] }, 0, new Set());
    assert.deepEqual(tf.options.map((o) => [o.text, o.correct]), [["True", false], ["False", true]]);
    const single = normalizeQuestion({ type: "single", prompt: "x", options: [{ text: "a", correct: true }, { text: "b", correct: true }] }, 0, new Set());
    assert.deepEqual(single.options.map((o) => o.correct), [true, false]);
  });

  it("requires a complete quiz to publish", () => {
    assert.match(publishProblem({ kind: "graded", questions: [], outcomes: [], settings: DEFAULT_QUIZ_SETTINGS }) ?? "", /at least one question/);
    const bad = cleanQuizInput({ title: "T", questions: [{ type: "text", prompt: "Q?" }] }, null, { strict: true });
    assert.ok(!bad.ok && /accepted answer/.test(bad.error));
    const good = cleanQuizInput({ title: "T", questions: [{ type: "text", prompt: "Q?", accepted: ["a"] }] }, null, { strict: true });
    assert.ok(good.ok);
  });

  it("rejects a pool bigger than the question list and a close before open", () => {
    const pool = cleanQuizInput({ title: "T", settings: { poolSize: 5 }, questions: [{ type: "truefalse", prompt: "Q" }] }, null, { strict: false });
    assert.ok(!pool.ok);
    const dates = cleanQuizInput({ title: "T", opensAt: "2030-01-02T00:00:00Z", closesAt: "2030-01-01T00:00:00Z" }, null, { strict: false });
    assert.ok(!dates.ok);
  });

  it("needs every personality answer to point at a result", () => {
    const quiz = cleanQuizInput(
      {
        kind: "personality",
        title: "Which?",
        outcomes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
        questions: [{ type: "single", prompt: "Q", options: [{ text: "x", outcomes: { a: 1 } }, { text: "y" }] }],
      },
      null,
      { strict: true },
    );
    assert.ok(!quiz.ok && /result/.test(quiz.error));
  });

  it("drops non-https images and unknown outcome ids", () => {
    const question = normalizeQuestion({ type: "single", prompt: "x", imageUrl: "http://x.test/a.png", options: [{ text: "a", outcomes: { nope: 3, a: 2 } }] }, 0, new Set(["a"]));
    assert.equal(question.imageUrl, "");
    assert.deepEqual(question.options[0]!.outcomes, { a: 2 });
  });
});

describe("custom ids", () => {
  it("round-trips and never carries answer text", () => {
    const id = quizId({ kind: "answer", attemptId: 42, index: 3, option: 1 });
    assert.equal(id, "dl:quiz:a:42:3:1");
    assert.deepEqual(parseQuizId(id), { kind: "answer", attemptId: 42, index: 3, option: 1 });
    assert.deepEqual(parseQuizId(quizId({ kind: "liveAnswer", gameId: 7, index: 0, option: 2 })), { kind: "liveAnswer", gameId: 7, index: 0, option: 2 });
    assert.equal(parseQuizId("dl:quiz:a:1:2"), null);
    assert.equal(parseQuizId("dl:quiz:zz:1"), null);
    assert.equal(parseQuizId("dl:other:a:1:2:3"), null);
  });
});

describe("progress bar", () => {
  it("fills proportionally", () => {
    assert.equal(progressBar(0, 10), "▱▱▱▱▱▱▱▱▱▱");
    assert.equal(progressBar(3, 10), "▰▰▰▱▱▱▱▱▱▱");
    assert.equal(progressBar(100, 100), "▰▰▰▰▰▰▰▰▰▰");
  });
});

describe("review screen components", () => {
  function customIds(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => customIds(n, out));
    else if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.custom_id === "string") out.push(rec.custom_id);
      Object.values(rec).forEach((v) => customIds(v, out));
    }
    return out;
  }
  const quiz = { id: 1, title: "Test", kind: "graded", color: null, settings: { ...DEFAULT_QUIZ_SETTINGS } } as unknown as Quiz;
  const attempt = (count: number) => ({ id: 7, questionOrder: Array.from({ length: count }, (_, i) => i + 1) }) as unknown as QuizAttempt;
  const questions = (count: number) => Array.from({ length: count }, (_, i) => q({ id: i + 1, options: [opt("a", "A", true), opt("b", "B")] }));

  // Discord rejects a message whose components share a custom id (COMPONENT_CUSTOM_ID_DUPLICATED).
  for (const count of [1, 3, 25]) {
    it(`never repeats a custom id (${count} question${count === 1 ? "" : "s"})`, () => {
      for (let page = 0; page < 6; page++) {
        const ids = customIds(reviewPayload({ quiz, attempt: attempt(count), questions: questions(count), answers: [], page, outcomes: [] as QuizOutcome[] }).components);
        assert.equal(new Set(ids).size, ids.length, `duplicate ids on page ${page}: ${ids.join(", ")}`);
      }
    });
  }
});
