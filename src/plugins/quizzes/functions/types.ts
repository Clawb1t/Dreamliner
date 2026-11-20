/**
 * Quiz domain types, shared by the plugin, the bridge (src/bridge/webQuizzes.ts) and the tests.
 * Questions are rows (quiz_questions) so per-question analytics stay queryable; options, accepted
 * answers and outcome weights are JSON on the question row.
 */

export type QuizKind = "graded" | "personality";
export type QuizStatus = "draft" | "published" | "closed" | "archived";
export type QuestionType = "single" | "multi" | "truefalse" | "text" | "number";
/** When a member sees the right answer: after each question, on the results screen, or never. */
export type RevealMode = "each" | "end" | "never";
export type AttemptStatus = "in_progress" | "completed" | "expired";
export type LiveStatus = "lobby" | "question" | "reveal" | "finished" | "cancelled";

export const QUIZ_KINDS: readonly QuizKind[] = ["graded", "personality"];
export const QUIZ_STATUSES: readonly QuizStatus[] = ["draft", "published", "closed", "archived"];
export const QUESTION_TYPES: readonly QuestionType[] = ["single", "multi", "truefalse", "text", "number"];
export const REVEAL_MODES: readonly RevealMode[] = ["each", "end", "never"];

/** Hard limits, mirrored on the website builder. */
export const QUIZ_LIMITS = {
  title: 120,
  description: 1500,
  category: 40,
  tags: 8,
  tag: 24,
  questions: 100,
  prompt: 500,
  explanation: 600,
  option: 120,
  /** Discord: 25 buttons per message, 25 select options; 10 keeps the screen readable. */
  options: 10,
  accepted: 15,
  acceptedLength: 100,
  points: 100,
  questionSeconds: 600,
  quizSeconds: 3 * 3600,
  attempts: 100,
  cooldownMinutes: 60 * 24 * 30,
  outcomes: 12,
  outcomeTitle: 80,
  outcomeDescription: 1000,
  outcomeWeight: 10,
  url: 500,
  /** Quizzes per server. */
  perGuild: 200,
} as const;

export type QuizOption = {
  /** Stable id ("o1", "o2"...) so answers and analytics survive reordering and edits. */
  id: string;
  text: string;
  /** Graded quizzes: this option is (one of) the right answer(s). */
  correct: boolean;
  /** Personality quizzes: outcome id -> points this answer gives that outcome. */
  outcomes: Record<string, number>;
};

export type QuizQuestion = {
  /** 0 for a question that hasn't been saved yet. */
  id: number;
  position: number;
  type: QuestionType;
  prompt: string;
  imageUrl: string;
  explanation: string;
  /** Graded quizzes: points for a fully right answer. */
  points: number;
  /** 0 = use the quiz's default per-question time limit. */
  timeLimitSec: number;
  /** single, multi and truefalse. truefalse always has exactly two: True, False. */
  options: QuizOption[];
  /** text: every accepted answer (matched ignoring case, accents and punctuation). */
  accepted: string[];
  /** number: the right number and how far off still counts. */
  numberAnswer: number | null;
  numberTolerance: number;
  /** multi: score the share of right picks minus wrong picks instead of all or nothing. */
  partialCredit: boolean;
  /** text: allow one small typo on answers of 5+ characters (two on 9+). */
  typoTolerance: boolean;
};

export type QuizOutcome = {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  /** Role given to members who get this result (optional). */
  roleId: string;
  color: number | null;
};

export type QuizSettings = {
  shuffleQuestions: boolean;
  shuffleAnswers: boolean;
  /** Ask a random N of the questions each attempt. 0 = all of them. */
  poolSize: number;
  /** Default per-question time limit. 0 = no limit. */
  questionTimeLimitSec: number;
  /** Whole-quiz time limit. 0 = no limit. */
  quizTimeLimitSec: number;
  /** 0 = unlimited. */
  maxAttempts: number;
  cooldownMinutes: number;
  /** Members need one of these roles to take it (empty = everyone who can take quizzes). */
  requiredRoleIds: string[];
  blockedRoleIds: string[];
  revealMode: RevealMode;
  /** The "Review answers" view after finishing. */
  allowReview: boolean;
  /** Graded: percent needed to pass. 0 = no pass mark. */
  passPercent: number;
  /** Graded: role given on a pass. */
  passRoleId: string;
  /** Post each finished result here. Empty = the server default (Settings), "none" = never. */
  resultsChannelId: string;
  dmResult: boolean;
  showLeaderboard: boolean;
};

export type Quiz = {
  id: number;
  guildId: string;
  kind: QuizKind;
  status: QuizStatus;
  title: string;
  description: string;
  coverImageUrl: string;
  color: number | null;
  category: string;
  tags: string[];
  settings: QuizSettings;
  outcomes: QuizOutcome[];
  opensAt: Date | null;
  closesAt: Date | null;
  panelChannelId: string | null;
  panelMessageId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
};

/** What a member answered. Option ids for choice questions, raw text or number otherwise. */
export type AnswerValue =
  | { kind: "options"; optionIds: string[] }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "none" };

export type AttemptAnswer = {
  attemptId: number;
  questionId: number;
  position: number;
  answer: AnswerValue;
  /** null for personality questions. */
  correct: boolean | null;
  /** 0..1 share of the question's points earned. */
  credit: number;
  points: number;
  timeMs: number;
  /** Answered after the time limit (counts as wrong). */
  late: boolean;
  /** Never answered: the time ran out. */
  timedOut: boolean;
  answeredAt: Date;
};

export type QuizAttempt = {
  id: number;
  guildId: string;
  quizId: number;
  userId: string;
  status: AttemptStatus;
  seed: string;
  /** Question ids asked, in the order this attempt sees them. */
  questionOrder: number[];
  currentIndex: number;
  /** When the current question was first shown (its timer starts here). Null until shown. */
  questionStartedAt: Date | null;
  /** Feedback screen waiting for "Next" (reveal "each"). */
  awaitingNext: boolean;
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean | null;
  outcomeId: string | null;
  correctCount: number;
  streak: number;
  bestStreak: number;
  startedAt: Date;
  deadlineAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  rewardRoleId: string | null;
};

export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
  shuffleQuestions: true,
  shuffleAnswers: true,
  poolSize: 0,
  questionTimeLimitSec: 0,
  quizTimeLimitSec: 0,
  maxAttempts: 0,
  cooldownMinutes: 0,
  requiredRoleIds: [],
  blockedRoleIds: [],
  revealMode: "each",
  allowReview: true,
  passPercent: 0,
  passRoleId: "",
  resultsChannelId: "",
  dmResult: false,
  showLeaderboard: true,
};
