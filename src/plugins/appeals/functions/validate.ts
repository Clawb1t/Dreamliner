import type { AppealForm } from "../../../config/schemas/appeals.js";
import type { TicketFormQuestion } from "../../../config/schemas/tickets.js";
import type { FormAnswer } from "../../../core/formModal.js";

/**
 * Checks a web-submitted appeal form against the server's questions: required answers, length
 * limits, and that choices are real options. The website validates as you type too, but this is
 * the check that counts.
 */

/** What the website sends per question: text, one choice, several choices, or a ticked box. */
export type RawAnswer = string | string[] | boolean | null | undefined;

export type ValidationResult =
  | { ok: true; answers: FormAnswer[] }
  | { ok: false; errors: Record<string, string> };

function optionLabel(question: TicketFormQuestion, value: string): string | null {
  const option = question.options?.find((item) => item.value === value);
  return option ? option.label : null;
}

function checkQuestion(question: TicketFormQuestion, raw: RawAnswer): { answer: string } | { error: string } | null {
  switch (question.type) {
    case "text_display":
      return null;
    case "text": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) return question.required ? { error: "This question needs an answer." } : { answer: "" };
      if (question.min_length > 0 && text.length < question.min_length) {
        return { error: `Please write at least ${question.min_length} characters (${text.length} so far).` };
      }
      if (text.length > question.max_length) return { error: `Please keep it under ${question.max_length} characters.` };
      return { answer: text };
    }
    case "string_select":
    case "radio_group": {
      const value = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
      if (!value) return question.required ? { error: "Pick an option." } : { answer: "" };
      const label = optionLabel(question, value);
      return label === null ? { error: "That isn't one of the options." } : { answer: label };
    }
    case "checkbox_group": {
      const values = Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === "string"))] : [];
      const min = question.min_values ?? (question.required ? 1 : 0);
      const max = question.max_values ?? question.options?.length ?? 25;
      if (values.length === 0 && !question.required) return { answer: "" };
      if (values.length < min) return { error: min === 1 ? "Pick at least one option." : `Pick at least ${min} options.` };
      if (values.length > max) return { error: `Pick at most ${max}.` };
      const labels = values.map((value) => optionLabel(question, value));
      if (labels.some((label) => label === null)) return { error: "One of those isn't an option." };
      return { answer: labels.join(", ") };
    }
    case "checkbox": {
      const ticked = raw === true || raw === "true";
      if (question.required && !ticked) return { error: "Please tick this box to continue." };
      return { answer: ticked ? "Yes" : "No" };
    }
    default:
      // Discord-only question types can't be answered on the web; appeal forms don't allow them.
      return null;
  }
}

export function validateAppealAnswers(form: AppealForm, raw: Record<string, RawAnswer>): ValidationResult {
  const errors: Record<string, string> = {};
  const answers: FormAnswer[] = [];
  for (const question of form.questions) {
    const result = checkQuestion(question, raw[question.id]);
    if (!result) continue;
    if ("error" in result) errors[question.id] = result.error;
    else answers.push({ questionId: question.id, label: question.label, answer: result.answer });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers };
}
