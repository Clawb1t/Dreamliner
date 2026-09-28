import { extractFeatures, FEATURE_NAMES, prepareText, type FeatureName, type FeatureVector } from "./features.js";
import { AI_TEXT_MODEL } from "./model.js";

/** Below this many words there isn't enough text to judge style, so nothing is scored. */
export const AI_TEXT_MIN_WORDS = 25;

/** Plain-language reason for each feature, shown when it pushed the score toward "AI-written". */
const SIGNAL_LABELS: Record<FeatureName, { high: string; low?: string }> = {
  assistant_phrases: { high: "Chat assistant phrasing (like \"I hope this helps\")" },
  chatty_ai_phrases: { high: "Stock chatbot phrases (like \"stay tuned\" or \"the key is\")" },
  llm_vocab: { high: "Vocabulary AI models overuse (like \"delve\" or \"crucial\")" },
  transition_starts: { high: "Sentences opening with formal transitions" },
  sentence_len_cv: { high: "Very varied sentence lengths", low: "Unusually even sentence lengths" },
  mean_sentence_len: { high: "Long, complete sentences", low: "Short sentences" },
  capital_starts: { high: "Every sentence neatly capitalized" },
  terminal_ends: { high: "Every sentence neatly punctuated" },
  casual_words: { high: "Casual chat words", low: "No casual chat language at all" },
  lowercase_i: { high: "Lowercase \"i\"", low: "No lowercase shortcuts" },
  emoticons: { high: "Emoji or emoticons", low: "No emoji or emoticons" },
  repeated_punct: { high: "Repeated punctuation", low: "No repeated punctuation" },
  em_dashes: { high: "Em dashes" },
  markdown_structure: { high: "Headings or list formatting" },
  bold_spans: { high: "Bolded key phrases" },
  oxford_lists: { high: "Lists of three (\"a, b, and c\")" },
  type_token_ratio: { high: "Wide, rarely repeated vocabulary", low: "Repetitive wording" },
  avg_word_len: { high: "Long, formal words", low: "Short, everyday words" },
  contractions: { high: "Lots of contractions", low: "Few contractions" },
  first_person: { high: "Lots of \"I\" and \"my\"", low: "Little personal voice" },
  second_person: { high: "Addresses the reader as \"you\"", low: "Rarely addresses the reader" },
  hedges: { high: "Hedged, balanced wording (\"may\", \"typically\")", low: "Direct wording" },
  exclaim_opener: { high: "Opens with a stock reply (like \"Certainly!\" or \"Great question!\")" },
  sloppy_spacing: { high: "Typing slips and uneven spacing", low: "No typing slips at all" },
  paragraph_evenness: { high: "Evenly sized paragraphs" },
};

export type AiTextSignal = { feature: FeatureName; label: string; weight: number };

export type AiTextScore = {
  /** 0 to 100: how likely the text is AI-written, or null when it was too short to judge. */
  score: number | null;
  words: number;
  /** The strongest reasons pushing toward "AI-written", strongest first (empty below 50%). */
  signals: AiTextSignal[];
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function standardize(features: FeatureVector): number[] {
  return FEATURE_NAMES.map((name, i) => {
    const std = AI_TEXT_MODEL.stds[i] || 1;
    return (features[name] - (AI_TEXT_MODEL.means[i] ?? 0)) / std;
  });
}

export function scoreAiText(raw: string): AiTextScore {
  const prepared = prepareText(raw);
  const words = prepared.words.length;
  if (words < AI_TEXT_MIN_WORDS) return { score: null, words, signals: [] };

  const features = extractFeatures(prepared);
  const z = standardize(features);
  let logit = AI_TEXT_MODEL.bias;
  const contributions: AiTextSignal[] = [];
  FEATURE_NAMES.forEach((name, i) => {
    const contribution = (AI_TEXT_MODEL.weights[i] ?? 0) * (z[i] ?? 0);
    logit += contribution;
    if (contribution > 0.15) {
      const labels = SIGNAL_LABELS[name];
      const label = (z[i] ?? 0) >= 0 ? labels.high : (labels.low ?? labels.high);
      contributions.push({ feature: name, label, weight: contribution });
    }
  });

  // Short messages carry less evidence, so pull their score toward the middle.
  const reliability = Math.min(1, 0.45 + words / 120);
  const score = Math.round(sigmoid(logit * reliability) * 100);
  contributions.sort((a, b) => b.weight - a.weight);
  // Reasons only make sense once the text actually leans AI-written.
  return { score, words, signals: score >= 50 ? contributions.slice(0, 4) : [] };
}
