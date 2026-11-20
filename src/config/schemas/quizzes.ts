import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/**
 * Server-wide Quizzes settings: the defaults a new quiz starts from and how live trivia runs.
 * Quizzes themselves (questions, attempts, live games) are DB rows, built on the dashboard.
 */
export const zQuizzesConfig = z.strictObject({
  results_channel_id: channelId("Default channel where finished quiz results are posted. A quiz can pick its own or turn it off. Empty posts nowhere."),
  default_question_seconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(0)
    .describe("Default time limit per question for new quizzes, in seconds. 0 means no limit."),
  default_shuffle_questions: z.boolean().default(true).describe("New quizzes ask their questions in a random order for each attempt."),
  default_shuffle_answers: z.boolean().default(true).describe("New quizzes shuffle the answer options for each attempt."),
  default_reveal_mode: z
    .enum(["each", "end", "never"])
    .default("each")
    .describe("When members see the right answers in new quizzes: after each question, at the end, or never."),
  default_max_attempts: z.number().int().min(0).max(100).default(0).describe("Default attempts per member for new quizzes. 0 means unlimited."),
  default_cooldown_minutes: z.number().int().min(0).max(43200).default(0).describe("Default wait between attempts for new quizzes, in minutes."),
  leaderboards_public: z
    .boolean()
    .default(true)
    .describe("Members can see quiz leaderboards with /quiz leaderboard and the panel button. Off limits them to staff who can view results."),
  live_question_seconds: z.number().int().min(5).max(120).default(20).describe("Live trivia: seconds to answer each question."),
  live_lobby_seconds: z.number().int().min(0).max(300).default(30).describe("Live trivia: countdown before the first question, so people can get ready."),
  live_reveal_seconds: z.number().int().min(3).max(30).default(6).describe("Live trivia: seconds the answer and scores show before the next question."),
  live_max_questions: z.number().int().min(1).max(50).default(10).describe("Live trivia: default number of questions per game."),
  live_speed_bonus: z.boolean().default(true).describe("Live trivia: faster right answers score more points."),
  can_take: boolPerm("take quizzes, see their own results and view leaderboards"),
  can_host_live: boolPerm("start and stop live trivia games"),
  can_view_results: boolPerm("see other members' quiz attempts"),
  can_manage: boolPerm("post quiz panels, reset or delete attempts and manage quizzes on the dashboard"),
});

export type QuizzesConfig = z.infer<typeof zQuizzesConfig>;

export const zQuizzesPluginSection = zPluginSection(zQuizzesConfig.shape, false);

export type QuizzesPluginSection = z.infer<typeof zQuizzesPluginSection>;
