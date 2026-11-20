/**
 * The Quizzes bridge contract (src/bridge/webQuizzes.ts). Every route is
 * `/bridge/guilds/:guildId/quizzes/...?userId=<discord id>` and answers JSON. The website mirrors
 * these types in its own lib (no shared code between the repos). Dates are ISO strings.
 *
 * Routes:
 *   GET    quizzes                       -> { quizzes: WebQuizRow[], stats: WebQuizStats, live: WebLiveGame[] }
 *   POST   quizzes                       body QuizInput -> { quiz: WebQuiz }
 *   GET    quizzes/insights              -> WebQuizInsights
 *   GET    quizzes/live                  -> { games: WebLiveGame[] }          (running + last 20)
 *   POST   quizzes/live/:gameId/stop     -> { game: WebLiveGame }
 *   POST   quizzes/import                body { format: "text" | "csv", text, kind } -> WebImportResult
 *   POST   quizzes/generate              body WebGenerateInput -> WebGenerateResult (Autopilot, gated)
 *   GET    quizzes/attempts/:attemptId   -> WebQuizAttemptDetail
 *   DELETE quizzes/attempts/:attemptId   -> { ok: true }
 *   GET    quizzes/:id                   -> WebQuizDetail
 *   PATCH  quizzes/:id                   body Partial<QuizInput> (questions replace the whole list when sent) -> { quiz: WebQuiz }
 *   DELETE quizzes/:id                   -> { ok: true }
 *   POST   quizzes/:id/duplicate         -> { quiz: WebQuiz }
 *   POST   quizzes/:id/status            body { status: QuizStatus } -> { quiz: WebQuiz }
 *   POST   quizzes/:id/post              body { channelId } -> { quiz: WebQuiz, messageUrl: string }
 *   POST   quizzes/:id/live              body { channelId, questionCount?, questionSeconds? } -> { game: WebLiveGame }
 *   GET    quizzes/:id/analytics         -> WebQuizAnalytics
 *   GET    quizzes/:id/leaderboard       ?limit=25 -> { entries: WebLeaderboardEntry[] }
 *   GET    quizzes/:id/attempts          ?offset&limit&q&status -> { attempts: WebQuizAttemptRow[], total: number }
 *   POST   quizzes/:id/reset             body { userId?: string } -> { deleted: number }  (no userId = every attempt)
 *   GET    quizzes/:id/export            -> { filename: string, csv: string }
 *
 * Auth: Manage Server or the plugin's `can_manage` flag. Errors are `{ error }` with 4xx/5xx.
 */
import type {
  AttemptStatus,
  LiveStatus,
  QuestionType,
  QuizKind,
  QuizOutcome,
  QuizQuestion,
  QuizSettings,
  QuizStatus,
} from "../plugins/quizzes/functions/types.js";

export type WebPerson = { id: string; name: string; username: string | null; avatar: string | null };

/** One row on the Quizzes list. */
export type WebQuizRow = {
  id: number;
  kind: QuizKind;
  status: QuizStatus;
  title: string;
  description: string;
  coverImageUrl: string;
  color: number | null;
  category: string;
  tags: string[];
  questionCount: number;
  /** Completed attempts, all time and the last 30 days. */
  attempts: number;
  attempts30d: number;
  players: number;
  /** Graded only; null with no completed attempts. */
  avgPercent: number | null;
  passRate: number | null;
  /** A running live game of this quiz, if any. */
  liveGameId: number | null;
  panelChannelId: string | null;
  panelMessageUrl: string | null;
  opensAt: string | null;
  closesAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  lastError: string | null;
};

export type WebQuizStats = {
  total: number;
  byStatus: Record<QuizStatus, number>;
  attempts30d: number;
  players30d: number;
  /** Average percent over graded attempts in the last 30 days. */
  avgPercent: number | null;
  liveGames: number;
};

/** The whole quiz, for the detail page and the builder. */
export type WebQuiz = WebQuizRow & {
  settings: QuizSettings;
  outcomes: QuizOutcome[];
  questions: QuizQuestion[];
  createdBy: string;
};

export type WebQuizEvent = { id: number; kind: string; actor: WebPerson | null; detail: string | null; createdAt: string };

export type WebQuizDetail = {
  quiz: WebQuiz;
  events: WebQuizEvent[];
  live: WebLiveGame | null;
  createdBy: WebPerson | null;
  /** Quick numbers for the overview (same as WebQuizAnalytics headline figures). */
  summary: {
    attempts: number;
    inProgress: number;
    players: number;
    avgPercent: number | null;
    passRate: number | null;
    avgDurationMs: number | null;
    bestPercent: number | null;
  };
};

/** Website create/update body. Questions without an id (or id 0) are new. */
export type QuizInput = {
  kind: QuizKind;
  title: string;
  description?: string;
  coverImageUrl?: string;
  color?: number | null;
  category?: string;
  tags?: string[];
  settings?: Partial<QuizSettings>;
  outcomes?: QuizOutcome[];
  questions?: (Omit<QuizQuestion, "id" | "position"> & { id?: number })[];
  opensAt?: string | null;
  closesAt?: string | null;
  /** Create only: "draft" (default) or "published". */
  status?: QuizStatus;
};

export type WebAnswerBar = { key: string; label: string; count: number; correct: boolean };

export type WebQuestionAnalytics = {
  questionId: number;
  position: number;
  type: QuestionType;
  prompt: string;
  /** Times it was asked and answered (timeouts included in asked). */
  asked: number;
  answered: number;
  correct: number;
  /** Graded only; null when nobody answered yet. */
  percentCorrect: number | null;
  avgTimeMs: number | null;
  timedOut: number;
  /** Choice questions: one bar per option. Text/number: the most common answers. */
  distribution: WebAnswerBar[];
};

export type WebQuizAnalytics = {
  attempts: number;
  inProgress: number;
  players: number;
  avgPercent: number | null;
  medianPercent: number | null;
  passRate: number | null;
  avgDurationMs: number | null;
  /** Ten buckets: 0-9%, 10-19% ... 90-100%. */
  scoreBuckets: number[];
  /** Last 30 days, oldest first, UTC dates (YYYY-MM-DD). */
  daily: { date: string; attempts: number }[];
  /** Personality: how often each result came up. */
  outcomes: { outcomeId: string; title: string; count: number }[];
  questions: WebQuestionAnalytics[];
};

export type WebLeaderboardEntry = {
  rank: number;
  userId: string;
  person: WebPerson;
  score: number;
  maxScore: number;
  percent: number;
  durationMs: number | null;
  attemptId: number;
  finishedAt: string | null;
  attempts: number;
};

export type WebQuizAttemptRow = {
  id: number;
  quizId: number;
  quizTitle: string;
  userId: string;
  person: WebPerson;
  status: AttemptStatus;
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean | null;
  outcomeId: string | null;
  outcomeTitle: string | null;
  correctCount: number;
  questionCount: number;
  durationMs: number | null;
  bestStreak: number;
  startedAt: string;
  finishedAt: string | null;
};

export type WebAttemptAnswer = {
  position: number;
  questionId: number;
  prompt: string;
  type: QuestionType;
  /** What they answered, as text ("Paris", "A, C", "42", or "No answer"). */
  answerText: string;
  /** The right answer as text (graded), or the outcome(s) it pointed to (personality). */
  correctText: string;
  correct: boolean | null;
  credit: number;
  points: number;
  maxPoints: number;
  timeMs: number;
  late: boolean;
  timedOut: boolean;
};

export type WebQuizAttemptDetail = { attempt: WebQuizAttemptRow; answers: WebAttemptAnswer[] };

export type WebLiveGame = {
  id: number;
  quizId: number;
  quizTitle: string;
  channelId: string;
  status: LiveStatus;
  host: WebPerson | null;
  players: number;
  currentIndex: number;
  questionCount: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  messageUrl: string | null;
  top: { person: WebPerson; score: number }[];
};

export type WebQuizInsights = {
  /** liveGames: games played so far (running or ended), not just running ones. */
  totals: { quizzes: number; published: number; attempts: number; attempts30d: number; players: number; avgPercent: number | null; liveGames: number };
  daily: { date: string; attempts: number; players: number }[];
  /** Server leaderboard: sum of each member's best score per graded quiz. */
  leaderboard: { rank: number; person: WebPerson; quizzes: number; passed: number; totalScore: number; avgPercent: number | null }[];
  topQuizzes: { id: number; title: string; attempts30d: number; avgPercent: number | null }[];
  hardest: { quizId: number; quizTitle: string; questionId: number; prompt: string; percentCorrect: number; answered: number }[];
  recent: WebQuizAttemptRow[];
  live: WebLiveGame[];
};

export type WebImportResult = {
  questions: (Omit<QuizQuestion, "id" | "position"> & { id?: number })[];
  outcomes: QuizOutcome[];
  errors: { line: number; message: string }[];
};

export type WebGenerateInput = {
  kind: QuizKind;
  topic: string;
  count: number;
  difficulty: "easy" | "medium" | "hard";
  /** Graded: which question types it may use (default single + truefalse). */
  types?: QuestionType[];
  /** Personality: existing outcomes to write answers for (it writes its own when empty). */
  outcomes?: QuizOutcome[];
};

export type WebGenerateResult = {
  questions: (Omit<QuizQuestion, "id" | "position"> & { id?: number })[];
  outcomes: QuizOutcome[];
  oneActive: boolean;
  freeUsesRemaining: number;
};
