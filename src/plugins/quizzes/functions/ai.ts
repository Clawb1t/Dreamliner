/**
 * Autopilot "Generate questions": topic + count + difficulty -> draft questions (and results for a
 * personality quiz) for staff to review in the builder. Only the topic and settings staff typed
 * are sent; never member data. The caller charges the shared Autopilot gate first.
 */
import { generateStructured } from "../../../core/ai/client.js";
import { normalizeOutcomes, normalizeQuestion } from "./validate.js";
import type { QuestionType, QuizKind, QuizOutcome, QuizQuestion } from "./types.js";

export type GenerateRequest = {
  kind: QuizKind;
  topic: string;
  count: number;
  difficulty: "easy" | "medium" | "hard";
  types: QuestionType[];
  outcomes: QuizOutcome[];
};

export function parseGenerateRequest(body: Record<string, unknown>): { ok: true; value: GenerateRequest } | { ok: false; error: string } {
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 300) : "";
  if (topic.length < 3) return { ok: false, error: "Tell Autopilot what the quiz is about." };
  const kind: QuizKind = body.kind === "personality" ? "personality" : "graded";
  const count = Math.min(20, Math.max(1, Math.round(Number(body.count) || 5)));
  const difficulty = body.difficulty === "easy" || body.difficulty === "hard" ? body.difficulty : "medium";
  const allowed: QuestionType[] = ["single", "multi", "truefalse", "text", "number"];
  const types = Array.isArray(body.types) ? body.types.filter((t): t is QuestionType => allowed.includes(t as QuestionType)) : [];
  const outcomes = normalizeOutcomes(body.outcomes).filter((o) => o.title);
  return { ok: true, value: { kind, topic, count, difficulty, types: types.length ? types : ["single", "truefalse"], outcomes } };
}

const OPTION = {
  type: "object",
  additionalProperties: false,
  required: ["text", "correct", "results"],
  properties: {
    text: { type: "string" },
    correct: { type: "boolean" },
    results: { type: "array", items: { type: "object", additionalProperties: false, required: ["result", "points"], properties: { result: { type: "integer" }, points: { type: "integer" } } } },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results", "questions"],
  properties: {
    results: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "description"], properties: { title: { type: "string" }, description: { type: "string" } } },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "prompt", "options", "accepted", "number", "tolerance", "explanation"],
        properties: {
          type: { type: "string", enum: ["single", "multi", "truefalse", "text", "number"] },
          prompt: { type: "string" },
          options: { type: "array", items: OPTION },
          accepted: { type: "array", items: { type: "string" } },
          number: { type: ["number", "null"] },
          tolerance: { type: ["number", "null"] },
          explanation: { type: "string" },
        },
      },
    },
  },
};

type RawResult = { results: { title: string; description: string }[]; questions: { type: QuestionType; prompt: string; options: { text: string; correct: boolean; results: { result: number; points: number }[] }[]; accepted: string[]; number: number | null; tolerance: number | null; explanation: string }[] };

function systemPrompt(req: GenerateRequest): string {
  if (req.kind === "personality") {
    return [
      "You write fun 'Which one are you?' personality quizzes for Discord communities.",
      "Questions are single choice with 3 to 5 short answers. Every answer gives points (1 to 3) to one or two results, referenced by their 0-based index in the results list.",
      "Spread answers across all results so each result is reachable. Keep it light, friendly and inclusive. Never use em dashes.",
      "Leave accepted empty, number and tolerance null, correct false and explanation empty.",
    ].join(" ");
  }
  return [
    "You write accurate, fun quiz questions for Discord communities.",
    "Only include facts you are confident are correct. Keep questions and answers short (answers under 60 characters).",
    "single: 4 options, exactly one correct. multi: 4 to 6 options, 2 or more correct. truefalse: options True and False, one correct.",
    "text: a one or two word answer, list every reasonable spelling in accepted, options empty. number: give number and tolerance (0 for exact), options empty.",
    "Write a one sentence explanation for each. Leave results empty and every option's results empty. Never use em dashes.",
  ].join(" ");
}

function userPrompt(req: GenerateRequest): string {
  if (req.kind === "personality") {
    const results = req.outcomes.length
      ? `Use exactly these results, in this order, and repeat them in results:\n${req.outcomes.map((o, i) => `${i}. ${o.title}${o.description ? `: ${o.description}` : ""}`).join("\n")}`
      : "Invent 4 results, each with a title and a two sentence description.";
    return `Topic: ${req.topic}\nWrite ${req.count} questions.\n${results}`;
  }
  return `Topic: ${req.topic}\nDifficulty: ${req.difficulty}\nWrite ${req.count} questions using only these types: ${req.types.join(", ")}. Mix them.`;
}

export async function generateQuizDraft(req: GenerateRequest): Promise<{ questions: Omit<QuizQuestion, "id" | "position">[]; outcomes: QuizOutcome[] }> {
  const raw = (await generateStructured({
    messages: [
      { role: "system", content: systemPrompt(req) },
      { role: "user", content: userPrompt(req) },
    ],
    schemaName: "quiz_draft",
    schema: SCHEMA,
    maxTokens: Math.min(6000, 400 + req.count * 260),
  })) as RawResult;

  let outcomes: QuizOutcome[] = req.outcomes;
  if (req.kind === "personality" && !outcomes.length) {
    outcomes = normalizeOutcomes((raw.results ?? []).map((r, i) => ({ id: `r${i + 1}`, title: r.title, description: r.description })));
  }
  const outcomeIds = new Set(outcomes.map((o) => o.id));
  const questions = (raw.questions ?? []).slice(0, req.count).map((q) => {
    const type: QuestionType = req.kind === "personality" ? "single" : q.type;
    const normalized = normalizeQuestion(
      {
        type,
        prompt: q.prompt,
        explanation: req.kind === "graded" ? q.explanation : "",
        points: 1,
        options: (q.options ?? []).map((o, i) => ({
          id: `o${i + 1}`,
          text: o.text,
          correct: req.kind === "graded" && o.correct,
          outcomes: Object.fromEntries((o.results ?? []).filter((r) => outcomes[r.result]).map((r) => [outcomes[r.result]!.id, Math.min(3, Math.max(1, r.points))])),
        })),
        accepted: q.accepted,
        numberAnswer: q.number,
        numberTolerance: q.tolerance ?? 0,
        typoTolerance: true,
      },
      0,
      outcomeIds,
    );
    const { id: _id, position: _p, ...rest } = normalized;
    return rest;
  });
  return { questions: questions.filter((q) => q.prompt), outcomes };
}
