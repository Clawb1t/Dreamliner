import { test } from "node:test";
import assert from "node:assert/strict";
import { zApplicationsConfig, zFormQuestion, type ApplicationOpening, type FormQuestion } from "../../../config/schemas/applications.js";
import { zTicketFormQuestion } from "../../../config/schemas/tickets.js";
import type { FormAnswer } from "../../../core/formModal.js";
import {
  APPLICATION_PREFIX,
  formAttendeesId,
  formRetryId,
  formRsvpId,
  formStatusSelectId,
  parseApplicationCustomId,
} from "../constants.js";
import {
  canEditLatest,
  conditionMet,
  estimatePageCount,
  finalizeAnswer,
  hasMorePages,
  initialStatus,
  isAnonymousForm,
  limitBlocker,
  parseDate,
  parseTime,
  placeRsvp,
  planPage,
  promotionCount,
  reminderDue,
  reviewModeOf,
  safeRegex,
  statusMeta,
  summarizeQuestion,
  toCsv,
  toModalQuestion,
  validateAnswer,
} from "./formLogic.js";
import { anonymousKey, responderKey } from "./anonymous.js";

const FORM_ID = "0b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

function qid(i: number): string {
  return `1b6f7a1e-2c3d-4e5f-8a9b-${String(i).padStart(12, "0")}`;
}

function question(i: number, extra: Record<string, unknown> = {}): FormQuestion {
  return zFormQuestion.parse({ id: qid(i), label: `Question ${i}`, ...extra });
}

function form(extra: Record<string, unknown> = {}): ApplicationOpening {
  return zApplicationsConfig.parse({ openings: [{ id: FORM_ID, name: "Test", ...extra }] }).openings[0]!;
}

function answer(i: number, text: string, values?: string[]): FormAnswer {
  return { questionId: qid(i), label: `Question ${i}`, answer: text, ...(values ? { values } : {}) };
}

// ── Compatibility ───────────────────────────────────────────────────────────────────────────

test("openings saved before Forms parse as applications with their old behaviour", () => {
  const old = {
    id: FORM_ID,
    name: "Moderator",
    questions: [{ id: qid(1), label: "Why?", style: "paragraph" }],
    accept_roles: ["123456789012345678"],
    cooldown_days: 3,
  };
  const parsed = zApplicationsConfig.parse({ review_channel_id: "1", openings: [old], can_review: false }).openings[0]!;
  assert.equal(parsed.kind, "application");
  assert.equal(parsed.review_mode, "approve_deny");
  assert.equal(parsed.post_submissions, true);
  assert.equal(parsed.anonymous, false);
  assert.equal(parsed.max_per_user, 0);
  assert.equal(parsed.allow_edit, false);
  assert.equal(parsed.questions[0]!.type, "text");
  assert.equal(parsed.questions[0]!.validation, "none");
  assert.equal(initialStatus(parsed), "pending");
});

test("every ticket question shape is a valid form question", () => {
  const ticketQuestion = zTicketFormQuestion.parse({
    id: qid(1),
    label: "Pick one",
    type: "string_select",
    options: [{ label: "A", value: "a" }],
  });
  assert.equal(zFormQuestion.safeParse(ticketQuestion).success, true);
});

test("old custom IDs still parse, and the new ones round-trip", () => {
  assert.deepEqual(parseApplicationCustomId(`${APPLICATION_PREFIX}apply:${FORM_ID}`), { kind: "apply", openingId: FORM_ID });
  assert.deepEqual(parseApplicationCustomId(`${APPLICATION_PREFIX}accept:12`), { kind: "accept", applicationId: 12 });
  assert.deepEqual(parseApplicationCustomId(formRsvpId(FORM_ID, "maybe")), { kind: "rsvp", openingId: FORM_ID, choice: "maybe" });
  assert.deepEqual(parseApplicationCustomId(formRetryId(FORM_ID, 2)), { kind: "retry", openingId: FORM_ID, page: 2 });
  assert.deepEqual(parseApplicationCustomId(formAttendeesId(FORM_ID)), { kind: "who", openingId: FORM_ID });
  assert.deepEqual(parseApplicationCustomId(formStatusSelectId(7)), { kind: "status", applicationId: 7 });
  assert.equal(parseApplicationCustomId(`${APPLICATION_PREFIX}rsvp:${FORM_ID}:yes`), null);
  for (const id of [formRsvpId(FORM_ID, "not_going"), formRetryId(FORM_ID, 3), formAttendeesId(FORM_ID)]) assert.ok(id.length <= 100);
});

// ── Kinds and statuses ──────────────────────────────────────────────────────────────────────

test("applications can never be anonymous or skip review", () => {
  assert.equal(isAnonymousForm(form({ kind: "application", anonymous: true })), false);
  assert.equal(isAnonymousForm(form({ kind: "questionnaire", anonymous: true })), true);
  assert.equal(reviewModeOf(form({ kind: "application", review_mode: "none" })), "approve_deny");
  assert.equal(reviewModeOf(form({ kind: "poll", review_mode: "none" })), "none");
  assert.equal(initialStatus(form({ kind: "poll", review_mode: "none" })), "submitted");
});

test("custom statuses label responses, and reserved ids are refused", () => {
  const f = form({ review_mode: "custom", statuses: [{ id: "shortlist", label: "Shortlisted", tone: "caution" }, { id: "hired", label: "Hired", tone: "ok", closes: true }] });
  assert.deepEqual(statusMeta(f, "shortlist"), { label: "Shortlisted", tone: "caution", open: true });
  assert.equal(statusMeta(f, "hired").open, false);
  assert.equal(statusMeta(f, "pending").label, "New");
  const bad = zApplicationsConfig.safeParse({ openings: [{ id: FORM_ID, statuses: [{ id: "pending", label: "Nope" }] }] });
  assert.equal(bad.success, false);
});

// ── Pages and conditions ────────────────────────────────────────────────────────────────────

test("long forms split into pages of five", () => {
  const questions = Array.from({ length: 12 }, (_, i) => question(i));
  const first = planPage(questions, 0, []);
  assert.deepEqual(first.indices, [0, 1, 2, 3, 4]);
  const second = planPage(questions, first.next, []);
  assert.deepEqual(second.indices, [5, 6, 7, 8, 9]);
  const third = planPage(questions, second.next, []);
  assert.deepEqual(third.indices, [10, 11]);
  assert.equal(hasMorePages(questions, third.next, []), false);
  assert.equal(estimatePageCount(questions, []), 3);
});

test("a page break starts a new page", () => {
  const questions = [question(0), question(1), question(2, { page_break: true }), question(3)];
  assert.deepEqual(planPage(questions, 0, []).indices, [0, 1]);
  assert.deepEqual(planPage(questions, 2, []).indices, [2, 3]);
});

test("a question that depends on one on the same page moves to the next page", () => {
  const questions = [
    question(0, { type: "yes_no" }),
    question(1, { show_if: { question_id: qid(0), op: "equals", value: "yes" } }),
    question(2),
  ];
  const first = planPage(questions, 0, []);
  assert.deepEqual(first.indices, [0]);
  // Answered yes: the dependent question is asked.
  assert.deepEqual(planPage(questions, first.next, [answer(0, "Yes", ["yes"])]).indices, [1, 2]);
  // Answered no: it's skipped.
  assert.deepEqual(planPage(questions, first.next, [answer(0, "No", ["no"])]).indices, [2]);
  // Before anything is answered the estimate assumes the longer path.
  assert.equal(estimatePageCount(questions, []), 2);
});

test("conditions compare raw values and readable answers", () => {
  const a = [answer(0, "Europe, Asia", ["eu", "as"])];
  assert.equal(conditionMet({ question_id: qid(0), op: "equals", value: "eu" }, a), true);
  assert.equal(conditionMet({ question_id: qid(0), op: "not_equals", value: "na" }, a), true);
  assert.equal(conditionMet({ question_id: qid(0), op: "contains", value: "asia" }, a), true);
  assert.equal(conditionMet({ question_id: qid(9), op: "answered", value: "" }, a), false);
  assert.equal(conditionMet({ question_id: qid(9), op: "not_answered", value: "" }, a), true);
  assert.equal(conditionMet(undefined, a), true);
});

test("skipped trailing questions end the form", () => {
  const questions = [question(0, { type: "yes_no" }), question(1, { show_if: { question_id: qid(0), op: "equals", value: "yes" } })];
  const first = planPage(questions, 0, []);
  assert.equal(hasMorePages(questions, first.next, [answer(0, "No", ["no"])]), false);
});

// ── Question types and validation ───────────────────────────────────────────────────────────

test("form-only types render as the modal components Discord has", () => {
  assert.equal(toModalQuestion(question(0, { type: "yes_no" })).type, "radio_group");
  assert.equal(toModalQuestion(question(0, { type: "rating" })).options?.length, 5);
  assert.equal(toModalQuestion(question(0, { type: "rating", scale: 10 })).type, "string_select");
  const number = toModalQuestion(question(0, { type: "number", min_value: 1, max_value: 10 }));
  assert.equal(number.type, "text");
  assert.match(number.placeholder, /1 to 10/);
  assert.equal(toModalQuestion(question(0, { type: "date" })).type, "text");
});

test("answers are validated by type and preset", () => {
  assert.equal(validateAnswer(question(0, { type: "number", min_value: 1, max_value: 5 }), answer(0, "3")), null);
  assert.match(validateAnswer(question(0, { type: "number", min_value: 1, max_value: 5 }), answer(0, "9")) ?? "", /5 or less/);
  assert.match(validateAnswer(question(0, { type: "number" }), answer(0, "lots")) ?? "", /number/);
  assert.equal(validateAnswer(question(0, { type: "date" }), answer(0, "24/12/2026")), null);
  assert.match(validateAnswer(question(0, { type: "date" }), answer(0, "31/02/2026")) ?? "", /date/);
  assert.equal(validateAnswer(question(0, { validation: "email" }), answer(0, "pilot@example.com")), null);
  assert.ok(validateAnswer(question(0, { validation: "email" }), answer(0, "pilot")));
  assert.equal(validateAnswer(question(0, { validation: "url" }), answer(0, "https://dreamliner.site")), null);
  assert.equal(validateAnswer(question(0, { validation: "regex", pattern: "^[A-Z]{3}$" }), answer(0, "LHR")), null);
  assert.match(
    validateAnswer(question(0, { validation: "regex", pattern: "^[A-Z]{3}$", pattern_message: "Use a three-letter airport code." }), answer(0, "London")) ?? "",
    /airport code/,
  );
  assert.equal(validateAnswer(question(0, { required: false }), undefined), null);
  assert.ok(validateAnswer(question(0, { required: true }), undefined));
});

test("dates and times normalise, impossible ones don't", () => {
  assert.equal(parseDate("2026-12-24"), "2026-12-24");
  assert.equal(parseDate("1/2/2026"), "2026-02-01");
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseTime("6:30pm"), "18:30");
  assert.equal(parseTime("18:05"), "18:05");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("7"), null);
  const dated = finalizeAnswer(question(0, { type: "datetime" }), answer(0, "24/12/2026 6pm"));
  assert.deepEqual(dated.values, ["2026-12-24 18:00"]);
});

test("unsafe or broken patterns are ignored instead of hanging", () => {
  assert.equal(safeRegex("(a+)+$"), null);
  assert.equal(safeRegex("[unclosed"), null);
  assert.ok(safeRegex("^\\d{4}$"));
});

// ── Limits ──────────────────────────────────────────────────────────────────────────────────

const none = { total: 0, mine: 0, latest: null };
const NOW = Date.UTC(2026, 10, 27, 12);

test("open and close times, and a cap on responses", () => {
  assert.equal(limitBlocker(form({ opens_at: "2026-12-01T00:00:00Z" }), none, NOW)?.kind, "not_open");
  assert.equal(limitBlocker(form({ closes_at: "2026-11-01T00:00:00Z" }), none, NOW)?.kind, "closed");
  assert.equal(limitBlocker(form({ max_responses: 10 }), { ...none, total: 10 }, NOW)?.kind, "full");
  assert.equal(limitBlocker(form({ max_responses: 10 }), { ...none, total: 9 }, NOW), null);
});

test("one response each, cooldowns, and the application rules", () => {
  const latest = (status: string, minutesAgo = 5, decided = false) => ({
    id: 1,
    status,
    createdAt: new Date(NOW - minutesAgo * 60_000),
    decidedAt: decided ? new Date(NOW - minutesAgo * 60_000) : null,
  });
  const poll = form({ kind: "poll", review_mode: "none", max_per_user: 1 });
  assert.equal(limitBlocker(poll, { total: 3, mine: 1, latest: latest("submitted") }, NOW)?.kind, "limit");
  const feedback = form({ kind: "feedback", review_mode: "none", submit_cooldown_minutes: 60 });
  assert.equal(limitBlocker(feedback, { total: 3, mine: 1, latest: latest("submitted", 30) }, NOW)?.kind, "cooldown");
  assert.equal(limitBlocker(feedback, { total: 3, mine: 1, latest: latest("submitted", 90) }, NOW), null);
  const app = form();
  assert.equal(limitBlocker(app, { total: 1, mine: 1, latest: latest("pending") }, NOW)?.kind, "pending");
  assert.equal(limitBlocker(app, { total: 1, mine: 1, latest: latest("denied", 60, true) }, NOW)?.kind, "denied_cooldown");
  assert.equal(limitBlocker(app, { total: 1, mine: 1, latest: latest("accepted", 60, true) }, NOW, { hasAcceptRoles: true })?.kind, "already_accepted");
});

test("editing your own response only while it's open", () => {
  const editable = form({ kind: "signup", review_mode: "approve_deny", allow_edit: true });
  const latest = (status: string) => ({ id: 1, status, createdAt: new Date(), decidedAt: null });
  assert.equal(canEditLatest(editable, latest("pending")), true);
  assert.equal(canEditLatest(editable, latest("accepted")), false);
  assert.equal(canEditLatest(form({ allow_edit: false }), latest("pending")), false);
});

// ── RSVP ────────────────────────────────────────────────────────────────────────────────────

test("RSVP capacity fills, then the waitlist takes over", () => {
  const event = form({ kind: "rsvp", event: { capacity: 2, waitlist: true } });
  assert.deepEqual(placeRsvp(event, 1, null, "going"), { rsvp: "going", waitlisted: false });
  assert.deepEqual(placeRsvp(event, 2, null, "going"), { rsvp: "going", waitlisted: true });
  assert.deepEqual(placeRsvp(event, 2, { rsvp: "going", waitlisted: false }, "going"), { rsvp: "going", waitlisted: false });
  assert.deepEqual(placeRsvp(event, 2, null, "maybe"), { rsvp: "maybe", waitlisted: false });
  const noWaitlist = form({ kind: "rsvp", event: { capacity: 2, waitlist: false } });
  assert.deepEqual(placeRsvp(noWaitlist, 2, null, "going"), { error: "full" });
  const noMaybe = form({ kind: "rsvp", event: { allow_maybe: false } });
  assert.deepEqual(placeRsvp(noMaybe, 0, null, "maybe"), { error: "maybe_off" });
  assert.deepEqual(placeRsvp(form({ kind: "rsvp" }), 500, null, "going"), { rsvp: "going", waitlisted: false });
});

test("free spots move people up from the waitlist", () => {
  assert.equal(promotionCount(10, 9, 4), 1);
  assert.equal(promotionCount(10, 10, 4), 0);
  assert.equal(promotionCount(10, 5, 2), 2);
  assert.equal(promotionCount(0, 50, 3), 3);
});

test("reminders are due inside the reminder window only", () => {
  const start = NOW + 30 * 60_000;
  const event = form({ kind: "rsvp", event: { starts_at: new Date(start).toISOString(), reminder_minutes: 60 } });
  assert.equal(reminderDue(event, NOW), true);
  assert.equal(reminderDue(event, start + 1), false);
  assert.equal(reminderDue(form({ kind: "rsvp", event: { starts_at: new Date(start).toISOString() } }), NOW), false);
});

// ── Results and CSV ─────────────────────────────────────────────────────────────────────────

test("choice results count raw values, and older answers by their labels", () => {
  const q = question(0, { type: "radio_group", options: [{ label: "Red", value: "r" }, { label: "Blue", value: "b" }] });
  const summary = summarizeQuestion(q, [[answer(0, "Red", ["r"])], [answer(0, "Blue", ["b"])], [answer(0, "Blue")], []]);
  assert.deepEqual(summary.choices?.map((c) => c.count), [1, 2]);
  assert.equal(summary.answered, 3);
  assert.equal(summary.skipped, 1);
});

test("rating averages and number ranges", () => {
  const rating = summarizeQuestion(question(0, { type: "rating" }), [[answer(0, "4 / 5", ["4"])], [answer(0, "2 / 5", ["2"])]]);
  assert.equal(rating.average, 3);
  const number = summarizeQuestion(question(0, { type: "number" }), [[answer(0, "10")], [answer(0, "20")]]);
  assert.deepEqual([number.min, number.max, number.average], [10, 20, 15]);
});

test("CSV quotes cells and defuses formulas", () => {
  const csv = toCsv([
    ["a", "b,c"],
    ['say "hi"', "=SUM(A1)"],
  ]);
  assert.equal(csv, 'a,"b,c"\r\n"say ""hi""",\'=SUM(A1)\r\n');
});

test("anonymous responses use a stable key that isn't the member id", () => {
  assert.equal(anonymousKey("123"), anonymousKey("123"));
  assert.notEqual(anonymousKey("123"), anonymousKey("124"));
  assert.ok(!anonymousKey("272397639855898624").includes("272397639855898624"));
  assert.equal(responderKey("123", false), "123");
});
