/**
 * Forms: the pure rules behind every form (no Discord calls, no database), so they can be tested
 * directly. Pages and conditions, answer validation, response limits, RSVP capacity, status
 * labels, results summaries and CSV.
 */
import type { TicketFormQuestion } from "../../../config/schemas/tickets.js";
import {
  SUBMITTED_STATUS,
  type ApplicationOpening,
  type FormCondition,
  type FormQuestion,
  type FormReviewMode,
  type RsvpChoice,
} from "../../../config/schemas/applications.js";
import type { FormAnswer } from "../../../core/formModal.js";

export const MODAL_PAGE_SIZE = 5;

// ── Kinds, review modes and statuses ────────────────────────────────────────────────────────

/** Applications are always tied to a member (roles, DMs), so they can never be anonymous. */
export function isAnonymousForm(form: Pick<ApplicationOpening, "anonymous" | "kind">): boolean {
  return form.anonymous && form.kind !== "application";
}

/** Applications keep a review flow: approve/deny (default) or custom statuses, never "none". */
export function reviewModeOf(form: Pick<ApplicationOpening, "kind" | "review_mode">): FormReviewMode {
  if (form.kind === "application" && form.review_mode === "none") return "approve_deny";
  return form.review_mode;
}

export function initialStatus(form: Pick<ApplicationOpening, "kind" | "review_mode">): string {
  return reviewModeOf(form) === "none" ? SUBMITTED_STATUS : "pending";
}

export type StatusTone = "neutral" | "note" | "ok" | "caution" | "danger";

const BUILT_IN_STATUS: Record<string, { label: string; tone: StatusTone; open: boolean }> = {
  pending: { label: "Pending", tone: "note", open: true },
  accepted: { label: "Accepted", tone: "ok", open: false },
  denied: { label: "Denied", tone: "danger", open: false },
  submitted: { label: "Submitted", tone: "neutral", open: true },
};

export function statusMeta(
  form: Pick<ApplicationOpening, "statuses" | "kind" | "review_mode"> | undefined,
  status: string,
): { label: string; tone: StatusTone; open: boolean } {
  const custom = form?.statuses.find((s) => s.id === status);
  if (custom) return { label: custom.label, tone: custom.tone, open: !custom.closes };
  if (status === "pending" && form && reviewModeOf(form) === "custom") return { label: "New", tone: "note", open: true };
  return BUILT_IN_STATUS[status] ?? { label: status, tone: "neutral", open: false };
}

/** Whether staff can still act on a response, and whether its author may still edit it. */
export function isOpenStatus(form: Pick<ApplicationOpening, "statuses" | "kind" | "review_mode"> | undefined, status: string): boolean {
  return statusMeta(form, status).open;
}

// ── Conditions and pages ─────────────────────────────────────────────────────────────────────

export function findAnswer(answers: readonly FormAnswer[], questionId: string): FormAnswer | undefined {
  return answers.find((a) => a.questionId === questionId);
}

function answerValues(answer: FormAnswer | undefined): string[] {
  if (!answer) return [];
  if (answer.values?.length) return answer.values;
  const text = answer.answer.trim();
  return text ? [text] : [];
}

/** Whether a question's `show_if` holds for the answers given so far. */
export function conditionMet(condition: FormCondition | undefined, answers: readonly FormAnswer[]): boolean {
  if (!condition) return true;
  const answer = findAnswer(answers, condition.question_id);
  const values = answerValues(answer).map((v) => v.toLowerCase());
  const text = (answer?.answer ?? "").trim().toLowerCase();
  const wanted = condition.value.trim().toLowerCase();
  switch (condition.op) {
    case "answered":
      return values.length > 0;
    case "not_answered":
      return values.length === 0;
    case "equals":
      return values.includes(wanted) || text === wanted;
    case "not_equals":
      return !values.includes(wanted) && text !== wanted;
    case "contains":
      return wanted.length > 0 && (text.includes(wanted) || values.some((v) => v.includes(wanted)));
  }
}

export type PagePlan = {
  /** Indexes into `questions` shown on this page (at most five). */
  indices: number[];
  /** Where the next page starts. */
  next: number;
};

/**
 * The next page of a form, starting at `cursor`. Discord shows at most five components per modal
 * and can't change a modal once it's open, so a question that depends on an answer on the same
 * page moves to the next page instead; questions whose condition doesn't hold are skipped. A
 * `page_break` question always starts a new page.
 */
export function planPage(
  questions: readonly FormQuestion[],
  cursor: number,
  answers: readonly FormAnswer[],
  /** Treat conditions on questions nobody has answered yet as met (for estimating page counts). */
  assumeUnanswered = false,
): PagePlan {
  const indices: number[] = [];
  let i = cursor;
  while (i < questions.length && indices.length < MODAL_PAGE_SIZE) {
    const question = questions[i]!;
    if (indices.length > 0 && question.page_break) break;
    const dependsOn = question.show_if?.question_id;
    if (dependsOn && indices.some((index) => questions[index]!.id === dependsOn)) break;
    const unknown = assumeUnanswered && dependsOn !== undefined && !findAnswer(answers, dependsOn);
    if (!unknown && !conditionMet(question.show_if, answers)) {
      i++;
      continue;
    }
    indices.push(i);
    i++;
  }
  return { indices, next: i };
}

/** Every remaining page from `cursor`, treating conditions on unanswered questions as met. */
export function estimatePageCount(questions: readonly FormQuestion[], answers: readonly FormAnswer[], pagesDone = 0, cursor = 0): number {
  // Conditions that depend on a question not answered yet are assumed to hold (the longest likely path).
  let pages = pagesDone;
  let at = cursor;
  for (let guard = 0; guard < 50 && at < questions.length; guard++) {
    const plan = planPage(questions, at, answers, true);
    if (plan.indices.length === 0) break;
    pages++;
    at = plan.next;
  }
  return Math.max(1, pages);
}

/** Whether a form has anything left to ask after `cursor`. */
export function hasMorePages(questions: readonly FormQuestion[], cursor: number, answers: readonly FormAnswer[]): boolean {
  return planPage(questions, cursor, answers).indices.length > 0;
}

// ── Rendering and reading form-only types ───────────────────────────────────────────────────

const TYPE_HINTS: Partial<Record<FormQuestion["type"], string>> = {
  date: "YYYY-MM-DD, e.g. 2026-12-24",
  time: "HH:MM, 24-hour, e.g. 18:30",
  datetime: "YYYY-MM-DD HH:MM, e.g. 2026-12-24 18:30",
};

function numberHint(q: FormQuestion): string {
  if (q.min_value !== undefined && q.max_value !== undefined) return `A number from ${q.min_value} to ${q.max_value}`;
  if (q.min_value !== undefined) return `A number, ${q.min_value} or more`;
  if (q.max_value !== undefined) return `A number, up to ${q.max_value}`;
  return "A number";
}

/** Options Discord can show: blank ones left out, a missing value taken from the label. */
export function usableOptions(q: Pick<FormQuestion, "options">): { label: string; value: string; description?: string }[] {
  const seen = new Set<string>();
  const out: { label: string; value: string; description?: string }[] = [];
  for (const option of q.options ?? []) {
    const label = option.label.trim();
    if (!label) continue;
    const value = (option.value.trim() || label).slice(0, 100);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ label: label.slice(0, 100), value, ...(option.description?.trim() ? { description: option.description.trim() } : {}) });
  }
  return out;
}

/** A form question as the modal component Discord actually renders. */
export function toModalQuestion(q: FormQuestion): TicketFormQuestion {
  const base: TicketFormQuestion = {
    id: q.id,
    label: q.label,
    type: "text",
    style: q.style,
    required: q.required,
    placeholder: q.placeholder,
    min_length: q.min_length,
    max_length: q.max_length,
    ...(q.content !== undefined ? { content: q.content } : {}),
    ...(q.options ? { options: usableOptions(q) } : {}),
    ...(q.min_values !== undefined ? { min_values: q.min_values } : {}),
    ...(q.max_values !== undefined ? { max_values: q.max_values } : {}),
  };
  switch (q.type) {
    case "number":
      return { ...base, style: "short", min_length: 0, max_length: 30, placeholder: q.placeholder || numberHint(q) };
    case "date":
    case "time":
    case "datetime":
      return { ...base, style: "short", min_length: 0, max_length: 30, placeholder: q.placeholder || TYPE_HINTS[q.type]! };
    case "yes_no":
      return {
        ...base,
        type: "radio_group",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      };
    case "rating": {
      const options = Array.from({ length: q.scale }, (_, i) => ({ label: String(i + 1), value: String(i + 1) }));
      // Ten choices read better as a menu than as a long column of radio buttons.
      return q.scale === 10
        ? { ...base, type: "string_select", options, min_values: q.required ? 1 : 0, max_values: 1 }
        : { ...base, type: "radio_group", options };
    }
    default:
      return { ...base, type: q.type };
  }
}

/** Answers for derived types read back as the question's own kind of value. */
export function finalizeAnswer(q: FormQuestion, raw: FormAnswer): FormAnswer {
  const text = raw.answer.trim();
  switch (q.type) {
    case "number": {
      const n = parseNumber(text);
      return n === null ? raw : { ...raw, answer: text, values: [String(n)] };
    }
    case "date": {
      const iso = parseDate(text);
      return iso ? { ...raw, values: [iso] } : raw;
    }
    case "time": {
      const t = parseTime(text);
      return t ? { ...raw, values: [t] } : raw;
    }
    case "datetime": {
      const dt = parseDateTime(text);
      return dt ? { ...raw, values: [dt] } : raw;
    }
    case "rating":
      return text ? { ...raw, answer: `${text} / ${q.scale}` } : raw;
    default:
      return raw;
  }
}

export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "2026-12-24" or "24/12/2026" (day first, as written in the UK) to "2026-12-24". */
export function parseDate(text: string): string | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text.trim());
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "18:30", "6:30pm" or "6pm" to "18:30". */
export function parseTime(text: string): string | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!match) return null;
  let h = Number(match[1]);
  const min = match[2] ? Number(match[2]) : 0;
  const suffix = match[3]?.toLowerCase();
  if (!match[2] && !suffix) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (suffix === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseDateTime(text: string): string | null {
  const match = /^(\S+)[\sT]+(.+)$/.exec(text.trim());
  if (!match) return null;
  const date = parseDate(match[1]!);
  const time = parseTime(match[2]!);
  return date && time ? `${date} ${time}` : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const PHONE = /^\+?[\d\s().-]{6,20}$/;

/** Why an answer isn't acceptable, or null when it is. Discord already enforced required/length. */
export function validateAnswer(q: FormQuestion, answer: FormAnswer | undefined): string | null {
  const text = answer?.answer.trim() ?? "";
  if (!text) return q.required && q.type !== "text_display" && q.type !== "checkbox" ? `**${q.label}** needs an answer.` : null;
  switch (q.type) {
    case "number": {
      const n = parseNumber(text);
      if (n === null) return `**${q.label}** needs a number.`;
      if (q.min_value !== undefined && n < q.min_value) return `**${q.label}** must be ${q.min_value} or more.`;
      if (q.max_value !== undefined && n > q.max_value) return `**${q.label}** must be ${q.max_value} or less.`;
      return null;
    }
    case "date":
      return parseDate(text) ? null : `**${q.label}** needs a date like 2026-12-24.`;
    case "time":
      return parseTime(text) ? null : `**${q.label}** needs a time like 18:30.`;
    case "datetime":
      return parseDateTime(text) ? null : `**${q.label}** needs a date and time like 2026-12-24 18:30.`;
    case "text":
      break;
    default:
      return null;
  }
  switch (q.validation) {
    case "email":
      return EMAIL.test(text) ? null : `**${q.label}** needs an email address.`;
    case "url":
      return URL_RE.test(text) ? null : `**${q.label}** needs a link starting with https://.`;
    case "phone":
      return PHONE.test(text) ? null : `**${q.label}** needs a phone number.`;
    case "integer":
      return /^-?\d+$/.test(text.replace(/[\s,]/g, "")) ? null : `**${q.label}** needs a whole number.`;
    case "regex": {
      const re = safeRegex(q.pattern);
      if (!re) return null;
      return re.test(text) ? null : q.pattern_message.trim() ? `**${q.label}**: ${q.pattern_message.trim()}` : `**${q.label}** isn't in the expected format.`;
    }
    default:
      return null;
  }
}

/** A server's own pattern, compiled defensively (bad or catastrophic patterns are simply ignored). */
export function safeRegex(pattern: string): RegExp | null {
  const source = pattern.trim();
  if (!source || source.length > 200) return null;
  // Nested quantifiers like (a+)+ are the usual cause of catastrophic backtracking.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) return null;
  try {
    return new RegExp(source, "u");
  } catch {
    return null;
  }
}

// ── Open times and response limits ──────────────────────────────────────────────────────────

function time(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type ResponseHistory = {
  /** Responses to this form, everyone. */
  total: number;
  /** This member's responses to this form. */
  mine: number;
  /** This member's newest response. */
  latest: { id: number; status: string; createdAt: Date; decidedAt: Date | null } | null;
};

export type Blocker =
  | { kind: "not_open"; at: number }
  | { kind: "closed" }
  | { kind: "full" }
  | { kind: "pending" }
  | { kind: "limit"; max: number }
  | { kind: "cooldown"; at: number }
  | { kind: "denied_cooldown"; at: number }
  | { kind: "already_accepted" };

/**
 * Time windows and per-member limits, shared by every kind of form. Role, account age and
 * Passport requirements are checked by the caller (they need the live member).
 */
export function limitBlocker(
  form: ApplicationOpening,
  history: ResponseHistory,
  now: number,
  options: { hasAcceptRoles?: boolean } = {},
): Blocker | null {
  const opensAt = time(form.opens_at);
  if (opensAt !== null && now < opensAt) return { kind: "not_open", at: opensAt };
  const closesAt = time(form.closes_at);
  if (closesAt !== null && now >= closesAt) return { kind: "closed" };
  if (form.max_responses > 0 && history.total >= form.max_responses) return { kind: "full" };

  const latest = history.latest;
  const mode = reviewModeOf(form);
  if (latest && mode !== "none" && latest.status === "pending") return { kind: "pending" };
  if (form.max_per_user > 0 && history.mine >= form.max_per_user) return { kind: "limit", max: form.max_per_user };
  if (latest && form.submit_cooldown_minutes > 0) {
    const readyAt = latest.createdAt.getTime() + form.submit_cooldown_minutes * 60_000;
    if (now < readyAt) return { kind: "cooldown", at: readyAt };
  }
  if (latest?.status === "accepted" && options.hasAcceptRoles) return { kind: "already_accepted" };
  if (latest?.status === "denied" && latest.decidedAt && form.cooldown_days > 0) {
    const readyAt = latest.decidedAt.getTime() + form.cooldown_days * 86_400_000;
    if (now < readyAt) return { kind: "denied_cooldown", at: readyAt };
  }
  return null;
}

/** Whether pressing the form's button should reopen this member's last response for editing. */
export function canEditLatest(form: ApplicationOpening, latest: ResponseHistory["latest"]): boolean {
  if (!form.allow_edit || !latest) return false;
  if (form.kind === "rsvp") return true;
  return isOpenStatus(form, latest.status);
}

// ── RSVP ─────────────────────────────────────────────────────────────────────────────────────

export type RsvpState = { rsvp: RsvpChoice; waitlisted: boolean };

/**
 * Where a member lands when they pick an RSVP answer: going, waitlisted, or turned away when
 * the event is full and has no waitlist. `goingCount` counts everyone confirmed going, the
 * member included if they already are.
 */
export function placeRsvp(
  form: Pick<ApplicationOpening, "event">,
  goingCount: number,
  current: RsvpState | null,
  choice: RsvpChoice,
): RsvpState | { error: "full" | "maybe_off" } {
  if (choice === "maybe" && !form.event.allow_maybe) return { error: "maybe_off" };
  if (choice !== "going") return { rsvp: choice, waitlisted: false };
  if (current?.rsvp === "going") return current;
  const capacity = form.event.capacity;
  if (capacity <= 0 || goingCount < capacity) return { rsvp: "going", waitlisted: false };
  if (form.event.waitlist) return { rsvp: "going", waitlisted: true };
  return { error: "full" };
}

/** How many waitlisted members move up when there are free spots. */
export function promotionCount(capacity: number, goingCount: number, waitlisted: number): number {
  if (capacity <= 0) return waitlisted;
  return Math.max(0, Math.min(waitlisted, capacity - goingCount));
}

/** Whether a reminder for this event should be sent now. */
export function reminderDue(form: Pick<ApplicationOpening, "kind" | "event" | "enabled">, now: number): boolean {
  if (form.kind !== "rsvp" || !form.enabled || form.event.reminder_minutes <= 0) return false;
  const start = time(form.event.starts_at);
  if (start === null) return false;
  return now >= start - form.event.reminder_minutes * 60_000 && now < start;
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────

export type ChoiceCount = { value: string; label: string; count: number };

export type QuestionSummary = {
  questionId: string;
  label: string;
  type: FormQuestion["type"];
  answered: number;
  skipped: number;
  /** Choice questions, yes/no and ratings: how often each option was picked. */
  choices?: ChoiceCount[];
  /** Ratings and numbers. */
  average?: number | null;
  min?: number | null;
  max?: number | null;
  /** Text-like answers, newest first (a sample, not all of them). */
  samples?: string[];
};

const CHOICE_TYPES = new Set(["string_select", "radio_group", "checkbox_group", "yes_no", "rating", "checkbox"]);

/** Results for one question across many responses (each response's answers, newest first). */
export function summarizeQuestion(q: FormQuestion, responses: readonly FormAnswer[][], sampleSize = 20): QuestionSummary {
  const summary: QuestionSummary = { questionId: q.id, label: q.label, type: q.type, answered: 0, skipped: 0 };
  const answers = responses.map((list) => findAnswer(list, q.id));
  const given = answers.filter((a): a is FormAnswer => Boolean(a && a.answer.trim()));
  summary.answered = given.length;
  summary.skipped = responses.length - given.length;

  if (CHOICE_TYPES.has(q.type)) {
    const options =
      q.type === "yes_no" || q.type === "checkbox"
        ? [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]
        : q.type === "rating"
          ? Array.from({ length: q.scale }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
          : usableOptions(q).map((o) => ({ value: o.value, label: o.label }));
    const counts = new Map(options.map((o) => [o.value, 0]));
    const byLabel = new Map(options.map((o) => [o.label.toLowerCase(), o.value]));
    for (const answer of given) {
      // Older answers have no raw values: match their readable labels instead.
      const picked = answer.values?.length
        ? answer.values
        : answer.answer.split(", ").map((label) => byLabel.get(label.trim().toLowerCase()) ?? label.trim());
      for (const value of picked) {
        const key = q.type === "rating" ? value.split(" ")[0]! : value.toLowerCase() === "yes" || value.toLowerCase() === "no" ? value.toLowerCase() : value;
        if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
      }
    }
    summary.choices = options.map((o) => ({ value: o.value, label: o.label, count: counts.get(o.value) ?? 0 }));
    if (q.type === "rating") {
      const total = summary.choices.reduce((sum, c) => sum + c.count, 0);
      const weighted = summary.choices.reduce((sum, c) => sum + Number(c.value) * c.count, 0);
      summary.average = total ? weighted / total : null;
    }
    return summary;
  }

  if (q.type === "number") {
    const numbers = given.map((a) => parseNumber(a.values?.[0] ?? a.answer)).filter((n): n is number => n !== null);
    summary.average = numbers.length ? numbers.reduce((s, n) => s + n, 0) / numbers.length : null;
    summary.min = numbers.length ? Math.min(...numbers) : null;
    summary.max = numbers.length ? Math.max(...numbers) : null;
  }
  if (q.type !== "text_display") summary.samples = given.slice(0, sampleSize).map((a) => a.answer.slice(0, 300));
  return summary;
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  // Cells that start like a formula are prefixed so spreadsheets don't run them.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
