import type { AutomodRuleConfig } from "../../../../../config/schemas/automod.js";
import { numSetting, type Detector } from "../types.js";
import { scoreAiText } from "./score.js";

export { scoreAiText, AI_TEXT_MIN_WORDS, type AiTextScore, type AiTextSignal } from "./score.js";

export const AI_TEXT_DEFAULT_MIN_SCORE = 85;
export const AI_TEXT_DEFAULT_MIN_WORDS = 40;

/** Confidence (0 to 100) a message needs before the rule fires, after the sensitivity preset. */
export function aiTextThreshold(rule: AutomodRuleConfig): number {
  const base = numSetting(rule, "min_score", AI_TEXT_DEFAULT_MIN_SCORE);
  const shift = rule.sensitivity === "lenient" ? 7 : rule.sensitivity === "strict" ? -10 : 0;
  return Math.min(99, Math.max(50, Math.round(base + shift)));
}

export const detectAiText: Detector = (ctx, rule) => {
  if (ctx.kind !== "message") return null;
  const minWords = Math.max(25, numSetting(rule, "min_words", AI_TEXT_DEFAULT_MIN_WORDS));
  // Cheap pre-check before any feature work: most chat messages are far too short to judge.
  if (ctx.content.length < minWords * 3) return null;

  const result = scoreAiText(ctx.content);
  if (result.score === null || result.words < minWords) return null;
  if (result.score < aiTextThreshold(rule)) return null;

  const why = result.signals.slice(0, 3).map((s) => s.label.toLowerCase());
  return {
    ruleId: "ai_text",
    reason: "Likely AI-written text",
    detail: `${result.score}% likely${why.length ? `: ${why.join(", ")}` : ""}`,
  };
};
