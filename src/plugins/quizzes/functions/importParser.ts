/**
 * Bulk question import from pasted text or CSV. Pure, unit-tested in quizzes.test.ts.
 *
 * Text format (blank line between questions):
 *   Q: What is the capital of France?     (the "Q:" is optional on the first line)
 *   * Paris                               (* = right answer, - = wrong answer; 2+ * = multiple select)
 *   - Berlin
 *   E: Paris has been the capital since 987.   (explanation, optional)
 *   P: 2        (points)   T: 30   (seconds)   IMG: https://...   (image)
 *   TF: true                (true/false question)
 *   A: red | blue | yellow  (typed answer, every accepted answer)
 *   N: 8 ~ 0.5              (number answer, optional tolerance)
 * Personality answers point at results by name, with optional points:
 *   - Hiking => Explorer, Artist:2
 *
 * CSV columns: question, type, options, correct, explanation, points, time_limit, image. Options
 * are separated by "|"; correct is the answer text(s) or 1-based number(s), separated by "|". The
 * header row is optional.
 */
import { normalizeQuestion } from "./validate.js";
import { QUIZ_LIMITS, type QuestionType, type QuizKind, type QuizOutcome, type QuizQuestion } from "./types.js";

export type ImportedQuestion = Omit<QuizQuestion, "id" | "position">;
export type ImportResult = { questions: ImportedQuestion[]; outcomes: QuizOutcome[]; errors: { line: number; message: string }[] };

type Draft = {
  line: number;
  prompt: string[];
  options: { text: string; correct: boolean; outcomes: Record<string, number> }[];
  tf: boolean | null;
  accepted: string[] | null;
  number: { value: number; tolerance: number } | null;
  explanation: string;
  points: number | null;
  time: number | null;
  image: string;
  /** A line in this question already reported its own problem. */
  lineError: boolean;
};

class OutcomeBook {
  outcomes: QuizOutcome[];
  constructor(existing: QuizOutcome[]) {
    this.outcomes = existing.map((o) => ({ ...o }));
  }
  idFor(title: string): string | null {
    const clean = title.trim().slice(0, QUIZ_LIMITS.outcomeTitle);
    if (!clean) return null;
    const found = this.outcomes.find((o) => o.title.toLowerCase() === clean.toLowerCase() || o.id.toLowerCase() === clean.toLowerCase());
    if (found) return found.id;
    if (this.outcomes.length >= QUIZ_LIMITS.outcomes) return null;
    let id = `r${this.outcomes.length + 1}`;
    while (this.outcomes.some((o) => o.id === id)) id = `${id}x`;
    this.outcomes.push({ id, title: clean, description: "", imageUrl: "", roleId: "", color: null });
    return id;
  }
  describe(title: string, description: string): void {
    const id = this.idFor(title);
    const o = this.outcomes.find((x) => x.id === id);
    if (o && description) o.description = description.slice(0, QUIZ_LIMITS.outcomeDescription);
  }
}

/** "Explorer, Artist:2" -> { r1: 1, r2: 2 } */
function parseOutcomeRefs(raw: string, book: OutcomeBook): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const m = /^(.*?)(?::\s*(\d+))?$/.exec(part.trim());
    if (!m || !m[1]!.trim()) continue;
    const id = book.idFor(m[1]!);
    if (!id) continue;
    out[id] = Math.min(QUIZ_LIMITS.outcomeWeight, Math.max(1, Number(m[2] ?? 1)));
  }
  return out;
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(v)) return true;
  if (["false", "f", "no", "n", "0"].includes(v)) return false;
  return null;
}

function finishDraft(d: Draft, kind: QuizKind, outcomeIds: Set<string>): { question: ImportedQuestion | null; error: string | null } {
  const prompt = d.prompt.join(" ").trim();
  if (!prompt) return { question: null, error: "Missing the question text." };
  let type: QuestionType;
  const raw: Record<string, unknown> = {
    prompt,
    explanation: d.explanation,
    imageUrl: d.image,
    points: d.points ?? 1,
    timeLimitSec: d.time ?? 0,
  };
  if (d.tf !== null) {
    type = "truefalse";
    raw.options = [
      { id: "t", text: "True", correct: d.tf },
      { id: "f", text: "False", correct: !d.tf },
    ];
  } else if (d.accepted) {
    type = "text";
    raw.accepted = d.accepted;
    raw.typoTolerance = true;
  } else if (d.number) {
    type = "number";
    raw.numberAnswer = d.number.value;
    raw.numberTolerance = d.number.tolerance;
  } else {
    if (d.options.length < 2) return { question: null, error: "Needs at least 2 answers (lines starting with * or -), or a TF:, A: or N: line." };
    const correct = d.options.filter((o) => o.correct).length;
    type = kind === "graded" && correct > 1 ? "multi" : "single";
    if (kind === "graded" && correct === 0) return { question: null, error: "Mark the right answer with * at the start of its line." };
    raw.options = d.options.map((o, i) => ({ id: `o${i + 1}`, text: o.text, correct: kind === "graded" && o.correct, outcomes: o.outcomes }));
  }
  raw.type = type;
  if (kind === "personality" && type !== "single") return { question: null, error: "Personality quizzes only use answer lists (- answer => Result)." };
  const { id: _id, position: _pos, ...question } = normalizeQuestion(raw, 0, outcomeIds);
  if (kind === "personality" && question.options.some((o) => !Object.keys(o.outcomes).length)) {
    return { question: null, error: "Every answer needs a result, like: - Hiking => Explorer" };
  }
  return { question, error: null };
}

export function parseQuestionText(text: string, kind: QuizKind, existingOutcomes: QuizOutcome[] = []): ImportResult {
  const book = new OutcomeBook(existingOutcomes);
  const errors: ImportResult["errors"] = [];
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const fresh = (line: number): Draft => ({ line, prompt: [], options: [], tf: null, accepted: null, number: null, explanation: "", points: null, time: null, image: "", lineError: false });

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) {
      if (current) drafts.push(current);
      current = null;
      return;
    }
    if (line.startsWith("#") || line.startsWith("//")) return;
    // Results can be declared anywhere: "RESULT: Explorer | Loves the outdoors".
    const result = /^(?:RESULT|R)\s*:\s*(.+)$/i.exec(line);
    if (result) {
      const [title, ...rest] = result[1]!.split("|");
      book.describe(title ?? "", rest.join("|").trim());
      return;
    }
    const q = /^Q\s*:\s*(.+)$/i.exec(line);
    const prev = current as Draft | null;
    if (!prev || (q && prev.prompt.length && (prev.options.length || prev.tf !== null || prev.accepted || prev.number))) {
      if (prev) drafts.push(prev);
      current = fresh(lineNo);
    }
    const d = current as unknown as Draft;
    const tag = /^(E|P|T|IMG|TF|A|N)\s*:\s*(.*)$/i.exec(line);
    if (q) {
      d.prompt.push(q[1]!);
    } else if (tag) {
      const key = tag[1]!.toUpperCase();
      const value = tag[2]!.trim();
      if (key === "E") d.explanation = value;
      else if (key === "P") {
        const n = Number(value);
        if (Number.isFinite(n)) d.points = n;
        else {
          errors.push({ line: lineNo, message: "P: needs a number of points." });
          d.lineError = true;
        }
      } else if (key === "T") {
        const n = Number(value.replace(/s$/i, ""));
        if (Number.isFinite(n)) d.time = n;
        else {
          errors.push({ line: lineNo, message: "T: needs a number of seconds." });
          d.lineError = true;
        }
      } else if (key === "IMG") d.image = value;
      else if (key === "TF") {
        const b = parseBool(value);
        if (b === null) {
          errors.push({ line: lineNo, message: "TF: should be true or false." });
          d.lineError = true;
        }
        else d.tf = b;
      } else if (key === "A") d.accepted = value.split("|").map((s) => s.trim()).filter(Boolean);
      else if (key === "N") {
        const [v, tol] = value.split("~").map((s) => s.trim());
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push({ line: lineNo, message: "N: needs a number, like N: 8 or N: 3.14 ~ 0.01" });
          d.lineError = true;
        }
        else d.number = { value: n, tolerance: Math.max(0, Number(tol ?? 0) || 0) };
      }
    } else if (/^[*\-+]\s*/.test(line) && (d.prompt.length > 0)) {
      const correct = line.startsWith("*") || line.startsWith("+");
      let body = line.replace(/^[*\-+]\s*/, "");
      let outcomes: Record<string, number> = {};
      const arrow = body.indexOf("=>");
      if (arrow >= 0) {
        if (kind === "personality") outcomes = parseOutcomeRefs(body.slice(arrow + 2), book);
        body = body.slice(0, arrow).trim();
      }
      if (body) d.options.push({ text: body, correct, outcomes });
    } else {
      d.prompt.push(d.prompt.length ? line : line.replace(/^(?:Q\s*[:.]|\d+[.)])\s*/i, ""));
    }
  });
  const last = current as Draft | null;
  if (last) drafts.push(last);

  const questions: ImportedQuestion[] = [];
  for (const d of drafts) {
    if (questions.length >= QUIZ_LIMITS.questions) {
      errors.push({ line: d.line, message: `Only the first ${QUIZ_LIMITS.questions} questions were imported.` });
      break;
    }
    const outcomeIds = new Set(book.outcomes.map((o) => o.id));
    const { question, error } = finishDraft(d, kind, outcomeIds);
    if (question) questions.push(question);
    else if (!d.lineError) errors.push({ line: d.line, message: error ?? "Couldn't read this question." });
  }
  errors.sort((a, b) => a.line - b.line);
  return { questions, outcomes: kind === "personality" ? book.outcomes : [], errors };
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push({ cells: row, line: rowLine });
      row = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push({ cells: row, line: rowLine });
  return rows;
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  single: "single",
  choice: "single",
  mc: "single",
  multi: "multi",
  multiple: "multi",
  "multi-select": "multi",
  truefalse: "truefalse",
  true_false: "truefalse",
  "true/false": "truefalse",
  tf: "truefalse",
  text: "text",
  typed: "text",
  type: "text",
  number: "number",
  numeric: "number",
};

export function parseQuestionCsv(text: string, kind: QuizKind, existingOutcomes: QuizOutcome[] = []): ImportResult {
  const book = new OutcomeBook(existingOutcomes);
  const errors: ImportResult["errors"] = [];
  const questions: ImportedQuestion[] = [];
  let rows = parseCsv(text);
  let cols = { question: 0, type: 1, options: 2, correct: 3, explanation: 4, points: 5, time: 6, image: 7 };
  if (rows.length && /question|prompt/i.test(rows[0]!.cells[0] ?? "")) {
    const head = rows[0]!.cells.map((c) => c.trim().toLowerCase());
    const find = (names: string[], fallback: number) => {
      const i = head.findIndex((h) => names.includes(h));
      return i >= 0 ? i : fallback;
    };
    cols = {
      question: find(["question", "prompt"], 0),
      type: find(["type"], -1),
      options: find(["options", "answers", "choices"], -1),
      correct: find(["correct", "answer", "right"], -1),
      explanation: find(["explanation", "explain"], -1),
      points: find(["points"], -1),
      time: find(["time_limit", "time", "seconds"], -1),
      image: find(["image", "image_url"], -1),
    };
    rows = rows.slice(1);
  }
  const get = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");

  for (const { cells, line } of rows) {
    if (questions.length >= QUIZ_LIMITS.questions) {
      errors.push({ line, message: `Only the first ${QUIZ_LIMITS.questions} questions were imported.` });
      break;
    }
    const prompt = get(cells, cols.question);
    if (!prompt) {
      errors.push({ line, message: "Missing the question text." });
      continue;
    }
    const optionTexts = get(cells, cols.options).split("|").map((s) => s.trim()).filter(Boolean);
    const correctRaw = get(cells, cols.correct);
    const correctParts = correctRaw.split("|").map((s) => s.trim()).filter(Boolean);
    let type: QuestionType | undefined = TYPE_ALIASES[get(cells, cols.type).toLowerCase().replace(/\s+/g, "")];
    if (!type) {
      if (optionTexts.length === 2 && optionTexts.every((o) => /^(true|false)$/i.test(o))) type = "truefalse";
      else if (!optionTexts.length && correctParts.length === 1 && Number.isFinite(Number(correctParts[0]!.split("~")[0]))) type = "number";
      else if (!optionTexts.length && /^(true|false)$/i.test(correctRaw)) type = "truefalse";
      else if (!optionTexts.length) type = "text";
      else type = correctParts.length > 1 ? "multi" : "single";
    }
    if (kind === "personality") type = "single";
    const raw: Record<string, unknown> = {
      type,
      prompt,
      explanation: get(cells, cols.explanation),
      points: get(cells, cols.points) ? Number(get(cells, cols.points)) : 1,
      timeLimitSec: get(cells, cols.time) ? Number(get(cells, cols.time)) : 0,
      imageUrl: get(cells, cols.image),
    };
    const isCorrect = (text: string, i: number) =>
      correctParts.some((c) => c.toLowerCase() === text.toLowerCase() || (/^\d+$/.test(c) && Number(c) === i + 1));
    if (type === "truefalse") {
      const truth = parseBool(correctParts[0] ?? "");
      if (truth === null) {
        errors.push({ line, message: "True/false questions need true or false in the correct column." });
        continue;
      }
      raw.options = [
        { id: "t", text: "True", correct: truth },
        { id: "f", text: "False", correct: !truth },
      ];
    } else if (type === "text") {
      raw.accepted = correctParts;
      raw.typoTolerance = true;
    } else if (type === "number") {
      const [v, tol] = (correctParts[0] ?? "").split("~").map((s) => s.trim());
      raw.numberAnswer = Number(v);
      raw.numberTolerance = Number(tol ?? 0) || 0;
      if (!Number.isFinite(Number(v)) || v === "") {
        errors.push({ line, message: "Number questions need a number in the correct column." });
        continue;
      }
    } else {
      raw.options = optionTexts.map((t, i) => {
        let text = t;
        let outcomes: Record<string, number> = {};
        const arrow = t.indexOf("=>");
        if (arrow >= 0) {
          text = t.slice(0, arrow).trim();
          if (kind === "personality") outcomes = parseOutcomeRefs(t.slice(arrow + 2), book);
        }
        return { id: `o${i + 1}`, text, correct: kind === "graded" && isCorrect(text, i), outcomes };
      });
    }
    const outcomeIds = new Set(book.outcomes.map((o) => o.id));
    const { id: _id, position: _pos, ...question } = normalizeQuestion(raw, 0, outcomeIds);
    if (type === "single" && kind === "graded" && !question.options.some((o) => o.correct)) {
      errors.push({ line, message: "Put the right answer (its text or number) in the correct column." });
      continue;
    }
    if (question.type !== "text" && question.type !== "number" && question.options.length < 2) {
      errors.push({ line, message: "Needs at least 2 options, separated by |." });
      continue;
    }
    questions.push(question);
  }
  return { questions, outcomes: kind === "personality" ? book.outcomes : [], errors };
}
