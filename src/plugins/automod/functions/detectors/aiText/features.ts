/**
 * Stylometric features for Dreamliner's AI-written text detector.
 *
 * Every feature is a cheap, explainable style signal (no network, no model download). The weights
 * that combine them live in `model.ts`, fitted offline by `src/scripts/train-ai-text.ts`, so if you
 * add, remove or reorder a feature here you must retrain and regenerate `model.ts`.
 *
 * Curly quotes are normalized away rather than used as a signal: iOS keyboards type them by
 * default, so they say more about a member's phone than about who wrote the text.
 */

export const FEATURE_NAMES = [
  "assistant_phrases",
  "chatty_ai_phrases",
  "llm_vocab",
  "transition_starts",
  "sentence_len_cv",
  "mean_sentence_len",
  "capital_starts",
  "terminal_ends",
  "casual_words",
  "lowercase_i",
  "emoticons",
  "repeated_punct",
  "em_dashes",
  "markdown_structure",
  "bold_spans",
  "oxford_lists",
  "type_token_ratio",
  "avg_word_len",
  "contractions",
  "first_person",
  "second_person",
  "hedges",
  "exclaim_opener",
  "sloppy_spacing",
  "paragraph_evenness",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * Direction the trainer is allowed to give a feature's weight (1 = can only point toward
 * "AI-written", -1 = only toward "human"). The training corpus is older Reddit text, which is less
 * casual than Discord, so without these the model could learn e.g. that emoji look AI-written.
 */
export const FEATURE_SIGNS: Partial<Record<FeatureName, 1 | -1>> = {
  assistant_phrases: 1,
  chatty_ai_phrases: 1,
  llm_vocab: 1,
  transition_starts: 1,
  markdown_structure: 1,
  bold_spans: 1,
  exclaim_opener: 1,
  em_dashes: 1,
  casual_words: -1,
  lowercase_i: -1,
  emoticons: -1,
  repeated_punct: -1,
  sloppy_spacing: -1,
};
export type FeatureVector = Record<FeatureName, number>;

export type PreparedText = {
  /** Text the features read: code, links, quotes and Discord tokens removed. */
  text: string;
  words: string[];
  sentences: string[];
  lines: string[];
};

// Phrases that almost only appear when a chat assistant is talking to its user.
const ASSISTANT_PHRASES = [
  "as an ai",
  "as a language model",
  "i hope this helps",
  "hope this helps",
  "let me know if you",
  "let me know if there",
  "feel free to",
  "great question",
  "i'd be happy to",
  "i would be happy to",
  "happy to help",
  "here's a breakdown",
  "here is a breakdown",
  "here are some",
  "here's how",
  "here is how",
  "in summary",
  "in conclusion",
  "to summarize",
  "overall,",
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "it is worth noting",
  "keep in mind that",
  "don't hesitate to",
  "i understand that",
  "you might consider",
  "you may want to",
  "ultimately, the",
  "whether you're",
  "whether you are",
  "if you have any other questions",
  "i apologize for",
  "i can't assist",
  "i cannot assist",
];

// What chat models write when asked to "sound casual": friendly, upbeat stock phrases that real
// members rarely string together.
const CHATTY_AI_PHRASES = [
  "hey everyone!", "hey everyone,", "hey all!", "just wanted to share", "just wanted to say",
  "just wanted to hop", "stay tuned", "dive in", "dive into", "diving into", "huge shoutout",
  "big shoutout", "shoutout to", "i'd love to hear", "would love to hear", "let me know what you think",
  "what do you all think", "drop your", "hear me out", "super excited", "so excited to",
  "incredibly rewarding", "both challenging and", "totally get", "don't get me wrong",
  "at the end of the day", "the key is", "game-changer", "game changer", "hands down",
  "can't go wrong", "worth checking out", "a must-", "happy gaming", "happy coding",
  "mark your calendars", "don't miss out", "see you there", "you've got this", "our little community",
  "brings back memories", "those were the days", "countless hours", "wish me luck", "my two cents",
  "in the mix", "fellow ", "a great way to", "such a great way", "whether you're a", "if you're into",
  "if you're looking for", "absolutely love", "can't recommend", "highly recommend", "a blast",
  "let's make", "let's keep", "let's get", "cheers!", "happy to share", "on this journey",
];

// Words large language models reach for far more often than people typing in chat.
const LLM_VOCAB = new Set([
  "delve", "delves", "delving", "tapestry", "testament", "multifaceted", "seamless", "seamlessly",
  "leverage", "leveraging", "furthermore", "moreover", "additionally", "realm", "landscape",
  "foster", "fostering", "fosters", "underscore", "underscores", "pivotal", "crucial", "robust",
  "embark", "intricate", "intricacies", "nuanced", "nuance", "holistic", "comprehensive",
  "paramount", "vibrant", "bustling", "meticulous", "meticulously", "navigate", "navigating",
  "elevate", "enhance", "enhancing", "empower", "empowering", "streamline", "optimize",
  "facilitate", "utilize", "utilizing", "endeavor", "endeavors", "invaluable", "noteworthy",
  "notably", "showcase", "showcasing", "resonate", "resonates", "commendable", "insightful",
  "unwavering", "profound", "myriad", "plethora", "encompass", "encompasses", "cornerstone",
  "ever-evolving", "ever-changing", "dynamic", "synergy", "paradigm", "captivating",
  "intriguing", "remarkable", "essential", "ensure", "ensuring", "significant", "significantly",
  "various", "overall", "ultimately", "consequently", "thereby", "henceforth", "firstly",
  "secondly", "lastly", "journey", "unlock", "unleash", "harness", "boundless", "realm",
]);

const TRANSITIONS = new Set([
  "however", "additionally", "furthermore", "moreover", "overall", "ultimately", "consequently",
  "therefore", "thus", "firstly", "secondly", "thirdly", "finally", "lastly", "similarly",
  "conversely", "meanwhile", "nevertheless", "nonetheless", "importantly", "notably", "in",
  "for", "by", "while",
]);
// "in" / "for" / "by" / "while" only count as the first word of a multi-word transition.
const TRANSITION_PHRASES = [
  "in addition", "in summary", "in conclusion", "in short", "in other words", "in contrast",
  "for example", "for instance", "by contrast", "while it",
];

const CASUAL_WORDS = new Set([
  "lol", "lmao", "lmfao", "rofl", "idk", "idc", "tbh", "ngl", "imo", "imho", "btw", "rn", "fr",
  "u", "ur", "r", "ya", "yeah", "yea", "yep", "yup", "nah", "nope", "gonna", "wanna", "gotta",
  "kinda", "sorta", "dunno", "bro", "bruh", "dude", "omg", "wtf", "smh", "pls", "plz", "thx",
  "ty", "np", "k", "ok", "okay", "haha", "hahaha", "hehe", "lmk", "tho", "cuz", "coz", "cause",
  "prolly", "def", "ima", "imma", "y'all", "yall", "ain't", "sus", "lowkey", "highkey", "istg",
  "fyi", "afaik", "iirc", "welp", "meh", "ugh", "hmm", "damn", "shit", "fuck", "fucking", "crap",
]);

const HEDGES = [
  "may", "might", "can be", "could be", "often", "typically", "generally", "potentially",
  "various", "several", "some", "depending on",
];

const CONTRACTION_RE = /\b\w+'(?:s|t|re|ve|ll|d|m)\b/gi;
const EMOTICON_RE = /(?:[:;=xX8]-?[)(DPpO3\/\\|]|<3|\^_\^|\bxd\b|\p{Extended_Pictographic})/giu;

/** Strips everything the detector should not judge, and normalizes quotes/dashes spelling. */
export function prepareText(raw: string): PreparedText {
  let text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<a?:\w+:\d+>/g, " :emoji: ")
    .replace(/<[@#&!]*\d+>/g, " ")
    .replace(/^>.*$/gm, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\r/g, "");
  text = text.replace(/[ \t]+\n/g, "\n").trim();

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const sentences = splitSentences(text);
  return { text, words, sentences, lines };
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n+/)) {
    const cleaned = block.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/, "").trim();
    if (!cleaned) continue;
    for (const part of cleaned.split(/(?<=[.!?])\s+(?=\S)/)) {
      const s = part.trim();
      if (s.length > 1) out.push(s);
    }
  }
  return out;
}

function per100(count: number, words: number): number {
  return words > 0 ? (count / words) * 100 : 0;
}

function countPhrases(haystack: string, phrases: readonly string[]): number {
  let total = 0;
  for (const phrase of phrases) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(phrase, from);
      if (at === -1) break;
      total++;
      from = at + phrase.length;
    }
  }
  return total;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0.5;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / m;
}

export function extractFeatures(prepared: PreparedText): FeatureVector {
  const { text, words, sentences, lines } = prepared;
  const lower = text.toLowerCase();
  const lowerWords = words.map((w) => w.toLowerCase());
  const wordCount = Math.max(1, words.length);
  const sentenceCount = Math.max(1, sentences.length);

  const sentenceLengths = sentences.map((s) => (s.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length).filter((n) => n > 0);

  let transitionStarts = 0;
  for (const s of sentences) {
    const lowerS = s.toLowerCase();
    const first = lowerS.match(/^[a-z]+/)?.[0] ?? "";
    if (!TRANSITIONS.has(first)) continue;
    if (["in", "for", "by", "while"].includes(first)) {
      if (TRANSITION_PHRASES.some((p) => lowerS.startsWith(p))) transitionStarts++;
    } else if (/^[a-z]+,/.test(lowerS) || ["however", "additionally", "furthermore", "moreover", "overall", "ultimately"].includes(first)) {
      transitionStarts++;
    }
  }

  const capitalStarts = sentences.filter((s) => /^["'(*_]*[A-Z0-9]/.test(s)).length;
  const terminalEnds = sentences.filter((s) => /[.!?:)"'*_]$/.test(s)).length;

  const markdownLines = lines.filter((l) => /^\s*(?:#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(l)).length;
  const boldSpans = (text.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) ?? []).length;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => (p.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length)
    .filter((n) => n > 0);

  const sample = lowerWords.slice(0, 150);
  const typeTokenRatio = sample.length ? new Set(sample).size / sample.length : 0;

  const firstPerson = lowerWords.filter((w) => w === "i" || w === "me" || w === "my" || w === "mine" || w === "i'm" || w === "i've" || w === "i'd" || w === "i'll").length;
  const secondPerson = lowerWords.filter((w) => w === "you" || w === "your" || w === "yours" || w === "you're" || w === "you've" || w === "you'll").length;

  return {
    assistant_phrases: Math.log1p(countPhrases(lower, ASSISTANT_PHRASES)),
    chatty_ai_phrases: Math.log1p(countPhrases(lower, CHATTY_AI_PHRASES)),
    llm_vocab: Math.log1p(per100(lowerWords.filter((w) => LLM_VOCAB.has(w)).length, wordCount)),
    transition_starts: transitionStarts / sentenceCount,
    sentence_len_cv: Math.min(2, coefficientOfVariation(sentenceLengths)),
    mean_sentence_len: Math.min(60, mean(sentenceLengths)) / 20,
    capital_starts: capitalStarts / sentenceCount,
    terminal_ends: terminalEnds / sentenceCount,
    casual_words: Math.log1p(per100(lowerWords.filter((w) => CASUAL_WORDS.has(w)).length, wordCount)),
    lowercase_i: Math.log1p(per100((text.match(/(?:^|[\s(])i(?=[\s',.!?]|$)/gm) ?? []).length, wordCount)),
    emoticons: Math.log1p(per100((text.match(EMOTICON_RE) ?? []).length + (text.match(/:emoji:/g) ?? []).length, wordCount)),
    repeated_punct: Math.log1p(per100((text.match(/[!?]{2,}|\.{2,}|,{2,}/g) ?? []).length, wordCount)),
    em_dashes: Math.log1p(per100((text.match(/—|\s–\s/g) ?? []).length, wordCount)),
    markdown_structure: lines.length ? markdownLines / lines.length : 0,
    bold_spans: Math.log1p(boldSpans),
    oxford_lists: Math.log1p(per100((text.match(/\w+, \w+(?: \w+)?, (?:and|or) \w+/g) ?? []).length, wordCount) * 10) ,
    type_token_ratio: typeTokenRatio,
    avg_word_len: Math.min(10, mean(words.map((w) => w.length))) / 5,
    contractions: Math.log1p(per100((text.match(CONTRACTION_RE) ?? []).length, wordCount)),
    first_person: Math.log1p(per100(firstPerson, wordCount)),
    second_person: Math.log1p(per100(secondPerson, wordCount)),
    hedges: Math.log1p(per100(countPhrases(` ${lowerWords.join(" ")} `, HEDGES.map((h) => ` ${h} `)), wordCount)),
    exclaim_opener: /^(?:absolutely|certainly|sure|of course|great question|definitely|indeed)[!,.]/i.test(text) ? 1 : 0,
    sloppy_spacing: Math.log1p(
      per100(
        (text.match(/ {2,}\S|[a-z][,.!?][a-z]{2,}|\s[,.!?]|\.\s+[a-z]/g) ?? []).length,
        wordCount,
      ),
    ),
    paragraph_evenness: paragraphs.length >= 3 ? Math.max(0, 1 - coefficientOfVariation(paragraphs)) : 0,
  };
}
