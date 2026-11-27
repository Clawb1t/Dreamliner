import type { Guild } from "discord.js";
import { FORM_KINDS, RSVP_CHOICES, type ApplicationOpening, type FormKind, type RsvpChoice } from "../config/schemas/applications.js";
import { configManager } from "../config/manager.js";
import type { FormAnswer } from "../core/formModal.js";
import { findOpening, loadApplicationsConfig } from "../plugins/applications/functions/config.js";
import { reviewModeOf, statusMeta, summarizeQuestion, toCsv, type StatusTone } from "../plugins/applications/functions/formLogic.js";
import { promoteFromWaitlist } from "../plugins/applications/functions/interactions.js";
import { refreshOpeningPost } from "../plugins/applications/functions/post.js";
import { decide, refreshReviewMessage, setResponseStatus } from "../plugins/applications/functions/review.js";
import {
  addApplicationEvent,
  applicationStats,
  applicationsByUser,
  dailyCounts,
  deleteApplicationEvent,
  getApplication,
  listApplicationEvents,
  listApplications,
  noteCounts,
  responsesForForm,
  rsvpCounts,
  setRsvp,
  waitlist,
  type ApplicationRecord,
  type ApplicationsQuery,
} from "../plugins/applications/functions/store.js";
import { resolvePerson, type WebPerson } from "./webReviews.js";

export { publishOpening } from "../plugins/applications/functions/post.js";

/** Form responses as the dashboard sees them (called applications for the older routes). */
export type WebApplication = {
  id: number;
  openingId: string;
  openingName: string;
  formKind: FormKind;
  status: string;
  statusLabel: string;
  statusTone: StatusTone;
  /** Still open: waiting for review (or an open custom status). */
  open: boolean;
  answers: FormAnswer[];
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string | null;
  anonymous: boolean;
  rsvp: RsvpChoice | null;
  waitlisted: boolean;
  /** Jump link to the posted response in Discord, when there is one. */
  messageUrl: string | null;
  /** Jump link to the response's discussion thread, when it has one. */
  threadUrl: string | null;
  /** Staff notes on it (dashboard only). */
  noteCount: number;
  /** Who sent it. Anonymous responses show a placeholder with id "anonymous". */
  applicant: WebPerson;
  reviewer: WebPerson | null;
};

export type WebApplicationEvent = {
  id: number;
  kind: string;
  content: string | null;
  createdAt: string;
  actor: WebPerson | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
export const MAX_APPLICATION_NOTE = 1000;
export const MAX_APPLICATION_BULK = 50;

const ANONYMOUS_PERSON: WebPerson = { id: "anonymous", name: "Anonymous", username: null, avatar: null };

function dateParam(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z` : value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function parseApplicationsQuery(url: URL): ApplicationsQuery {
  const status = url.searchParams.get("status")?.trim() ?? "";
  const kind = url.searchParams.get("kind")?.trim() ?? "";
  const rsvp = url.searchParams.get("rsvp")?.trim() ?? "";
  return {
    // Built-in or custom status ids (custom ones are lowercase slugs).
    status: /^[a-z0-9_]{1,24}$/.test(status) ? status : null,
    openingId: url.searchParams.get("opening")?.trim() || null,
    userId: url.searchParams.get("user")?.trim() || null,
    q: (url.searchParams.get("q") ?? "").trim().replace(/^#(?=\d+$)/, "").slice(0, 120),
    sort: url.searchParams.get("sort") === "oldest" ? "oldest" : "newest",
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
    kind: (FORM_KINDS as readonly string[]).includes(kind) ? (kind as FormKind) : null,
    rsvp: rsvp === "waitlist" || (RSVP_CHOICES as readonly string[]).includes(rsvp) ? (rsvp as RsvpChoice | "waitlist") : null,
    from: dateParam(url.searchParams.get("from")),
    to: dateParam(url.searchParams.get("to"), true),
  };
}

type People = Map<string, Promise<WebPerson>>;

function personLoader(guild: Guild, people: People) {
  return (id: string) => {
    let cached = people.get(id);
    if (!cached) {
      cached = resolvePerson(guild, id);
      people.set(id, cached);
    }
    return cached;
  };
}

async function toWeb(guild: Guild, app: ApplicationRecord, people: People, form: ApplicationOpening | undefined, notes = 0): Promise<WebApplication> {
  const person = personLoader(guild, people);
  const meta = statusMeta(form, app.status);
  return {
    id: app.id,
    openingId: app.openingId,
    openingName: app.openingName,
    formKind: app.formKind ?? "application",
    status: app.status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    open: meta.open,
    answers: app.answers,
    reason: app.reason,
    createdAt: app.createdAt.toISOString(),
    decidedAt: app.decidedAt?.toISOString() ?? null,
    updatedAt: app.updatedAt?.toISOString() ?? null,
    anonymous: Boolean(app.anonymous),
    rsvp: app.rsvp ?? null,
    waitlisted: Boolean(app.waitlisted),
    messageUrl:
      app.reviewChannelId && app.reviewMessageId
        ? `https://discord.com/channels/${guild.id}/${app.reviewChannelId}/${app.reviewMessageId}`
        : null,
    threadUrl: app.threadId ? `https://discord.com/channels/${guild.id}/${app.threadId}` : null,
    noteCount: notes,
    applicant: app.anonymous ? ANONYMOUS_PERSON : await person(app.userId),
    reviewer: app.reviewerId ? await person(app.reviewerId) : null,
  };
}

/** What the dashboard needs to know about each form to filter and label responses. */
function formSummary(form: ApplicationOpening) {
  return {
    id: form.id,
    name: form.name.trim() || "Untitled form",
    kind: form.kind,
    reviewMode: reviewModeOf(form),
    statuses: form.statuses.map((s) => ({ id: s.id, label: s.label, tone: s.tone, closes: s.closes })),
    anonymous: form.anonymous && form.kind !== "application",
  };
}

async function loadConfig(guild: Guild) {
  return loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
}

export async function listWebApplications(guild: Guild, query: ApplicationsQuery) {
  const { rows, total, counts } = listApplications(guild.id, query);
  const people: People = new Map();
  const config = await loadConfig(guild);
  const notes = noteCounts(guild.id, rows.map((row) => row.id));
  return {
    applications: await Promise.all(rows.map((row) => toWeb(guild, row, people, findOpening(config, row.openingId), notes.get(row.id) ?? 0))),
    total,
    counts,
    offset: query.offset,
    // For the form filter: every configured form, even ones nobody has responded to yet.
    openings: config.openings.map(formSummary),
  };
}

export function getWebApplicationStats(guild: Guild, openingId?: string | null) {
  const stats = applicationStats(guild.id, openingId);
  return { ...stats, oldestPendingAt: stats.oldestPendingAt?.toISOString() ?? null };
}

export async function getWebApplication(guild: Guild, id: number): Promise<WebApplication | null> {
  const app = getApplication(guild.id, id);
  if (!app) return null;
  const config = await loadConfig(guild);
  return toWeb(guild, app, new Map(), findOpening(config, app.openingId), noteCounts(guild.id, [app.id]).get(app.id) ?? 0);
}

/** The response page: the response, its timeline, the member's other responses here. */
export async function getWebApplicationDetail(guild: Guild, id: number) {
  const app = getApplication(guild.id, id);
  if (!app) return null;
  const people: People = new Map();
  const person = personLoader(guild, people);
  const events = listApplicationEvents(guild.id, app.id);
  const config = await loadConfig(guild);
  const opening = findOpening(config, app.openingId);
  return {
    application: await toWeb(guild, app, people, opening, events.filter((e) => e.kind === "note").length),
    events: await Promise.all(
      events.map(
        async (e): Promise<WebApplicationEvent> => ({
          id: e.id,
          kind: e.kind,
          content: e.content,
          createdAt: e.createdAt.toISOString(),
          actor: e.actorId ? await person(e.actorId) : null,
        }),
      ),
    ),
    others: app.anonymous
      ? []
      : applicationsByUser(guild.id, app.userId)
          .filter((other) => other.id !== app.id)
          .map((other) => ({
            id: other.id,
            openingName: other.openingName,
            formKind: other.formKind ?? "application",
            status: other.status,
            statusLabel: statusMeta(findOpening(config, other.openingId), other.status).label,
            statusTone: statusMeta(findOpening(config, other.openingId), other.status).tone,
            createdAt: other.createdAt.toISOString(),
          })),
    /** What reviewing does for this form (it may have been deleted since). */
    opening: opening
      ? {
          exists: true,
          name: opening.name.trim() || app.openingName,
          kind: opening.kind,
          reviewMode: reviewModeOf(opening),
          statuses: opening.statuses.map((s) => ({ id: s.id, label: s.label, tone: s.tone, closes: s.closes })),
          acceptRoles: opening.accept_roles,
          removeRoles: opening.accept_remove_roles,
          denyRoles: opening.deny_roles,
          dmDecision: opening.dm_decision,
          capacity: opening.event.capacity,
        }
      : {
          exists: false,
          name: app.openingName,
          kind: app.formKind ?? "application",
          reviewMode: "approve_deny" as const,
          statuses: [],
          acceptRoles: [],
          removeRoles: [],
          denyRoles: [],
          dmDecision: false,
          capacity: 0,
        },
  };
}

export async function decideWebApplication(
  guild: Guild,
  id: number,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<{ application: WebApplication; notes: string[] } | { error: string }> {
  const config = await loadConfig(guild);
  const result = await decide(guild, config, id, decision, reviewerId, reason);
  if (!result.ok) return { error: result.error };
  return { application: await toWeb(guild, result.application, new Map(), findOpening(config, result.application.openingId)), notes: result.notes };
}

/** Custom review: any of the form's statuses (accepted/denied go through the decision flow). */
export async function setWebApplicationStatus(
  guild: Guild,
  id: number,
  statusRaw: unknown,
  reviewerId: string,
  reason: string | null,
): Promise<{ application: WebApplication; notes: string[] } | { error: string }> {
  const status = typeof statusRaw === "string" ? statusRaw.trim() : "";
  if (!/^[a-z0-9_]{1,24}$/.test(status)) return { error: "Pick a status." };
  const config = await loadConfig(guild);
  const result = await setResponseStatus(guild, config, id, status, reviewerId, reason);
  if (!result.ok) return { error: result.error };
  return { application: await toWeb(guild, result.application, new Map(), findOpening(config, result.application.openingId)), notes: result.notes };
}

/**
 * Staff changing an RSVP: moving someone up from the waitlist (a staff call, so it can go over
 * capacity) or marking them not going (which frees a spot for the waitlist).
 */
export async function setWebRsvp(
  guild: Guild,
  id: number,
  choiceRaw: unknown,
  staffId: string,
): Promise<{ application: WebApplication; promoted: number } | { error: string }> {
  if (choiceRaw !== "going" && choiceRaw !== "maybe" && choiceRaw !== "not_going") return { error: "Pick going, maybe or not going." };
  const app = getApplication(guild.id, id);
  if (!app || !app.rsvp) return { error: "That isn't an RSVP." };
  const config = await loadConfig(guild);
  const opening = findOpening(config, app.openingId);
  const updated = setRsvp(guild.id, id, choiceRaw, false);
  if (!updated) return { error: "That RSVP doesn't exist." };
  addApplicationEvent({
    guildId: guild.id,
    applicationId: id,
    kind: "rsvp",
    actorId: staffId,
    content: `${app.waitlisted ? "waitlist" : app.rsvp} → ${choiceRaw} (changed on the dashboard)`,
  });
  let promoted = 0;
  if (opening) {
    if (app.rsvp === "going" && !app.waitlisted && choiceRaw !== "going") promoted = await promoteFromWaitlist(guild, opening);
    await refreshOpeningPost(guild, opening);
    await refreshReviewMessage(guild, updated, opening, false);
  }
  return { application: await toWeb(guild, updated, new Map(), opening), promoted };
}

/** Accepts or denies several pending responses in turn (roles, DMs and Discord posts as usual). */
export async function bulkDecideWebApplications(
  guild: Guild,
  idsRaw: unknown,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<{ ok: number[]; failed: Array<{ id: number; error: string }>; notes: string[] } | { error: string }> {
  if (!Array.isArray(idsRaw)) return { error: "ids must be a list" };
  const ids = [...new Set(idsRaw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { error: "Pick at least one response." };
  if (ids.length > MAX_APPLICATION_BULK) return { error: `Up to ${MAX_APPLICATION_BULK} at a time.` };
  const config = await loadConfig(guild);
  const ok: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  const notes = new Set<string>();
  for (const id of ids) {
    // getApplication is guild-scoped, so another server's id is just "not found".
    if (!getApplication(guild.id, id)) {
      failed.push({ id, error: "Response not found" });
      continue;
    }
    const result = await decide(guild, config, id, decision, reviewerId, reason);
    if (result.ok) {
      ok.push(id);
      for (const note of result.notes) notes.add(note);
    } else {
      failed.push({ id, error: result.error });
    }
  }
  return { ok, failed, notes: [...notes] };
}

export async function addWebApplicationNote(
  guild: Guild,
  applicationId: number,
  staffId: string,
  contentRaw: unknown,
): Promise<{ event: WebApplicationEvent } | { status: number; error: string }> {
  if (!getApplication(guild.id, applicationId)) return { status: 404, error: "Response not found" };
  const content = typeof contentRaw === "string" ? contentRaw.trim().slice(0, MAX_APPLICATION_NOTE) : "";
  if (!content) return { status: 400, error: "Write a note first." };
  const event = addApplicationEvent({ guildId: guild.id, applicationId, kind: "note", actorId: staffId, content });
  return {
    event: {
      id: event.id,
      kind: event.kind,
      content: event.content,
      createdAt: event.createdAt.toISOString(),
      actor: await resolvePerson(guild, staffId),
    },
  };
}

export function deleteWebApplicationNote(guild: Guild, applicationId: number, noteId: number): boolean {
  return deleteApplicationEvent(guild.id, applicationId, noteId);
}

// ── Results and export ─────────────────────────────────────────────────────────────────────────

const RESULTS_LIMIT = 5000;

/** Per-form results: counts, every question's summary, and the RSVP attendee lists. */
export async function getWebFormResults(guild: Guild, openingId: string) {
  const config = await loadConfig(guild);
  const form = findOpening(config, openingId);
  if (!form) return null;
  const responses = responsesForForm(guild.id, openingId, RESULTS_LIMIT);
  const answers = responses.map((r) => r.answers);
  const byStatus: Record<string, number> = {};
  for (const r of responses) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const now = Date.now();
  const people: People = new Map();
  const person = personLoader(guild, people);

  let rsvp: null | {
    counts: ReturnType<typeof rsvpCounts>;
    capacity: number;
    startsAt: string | null;
    going: Array<{ id: number; person: WebPerson; at: string }>;
    maybe: Array<{ id: number; person: WebPerson; at: string }>;
    waitlist: Array<{ id: number; person: WebPerson; at: string }>;
  } = null;
  if (form.kind === "rsvp" || responses.some((r) => r.rsvp)) {
    const row = async (r: ApplicationRecord) => ({
      id: r.id,
      person: r.anonymous ? ANONYMOUS_PERSON : await person(r.userId),
      at: (r.updatedAt ?? r.createdAt).toISOString(),
    });
    const going = responses.filter((r) => r.rsvp === "going" && !r.waitlisted).reverse().slice(0, 300);
    const maybe = responses.filter((r) => r.rsvp === "maybe").reverse().slice(0, 300);
    rsvp = {
      counts: rsvpCounts(guild.id, openingId),
      capacity: form.event.capacity,
      startsAt: form.event.starts_at ?? null,
      going: await Promise.all(going.map(row)),
      maybe: await Promise.all(maybe.map(row)),
      waitlist: await Promise.all(waitlist(guild.id, openingId, 300).map(row)),
    };
  }

  return {
    form: formSummary(form),
    total: responses.length,
    truncated: responses.length >= RESULTS_LIMIT,
    byStatus,
    daily: dailyCounts(
      responses.map((r) => r.createdAt),
      30,
      now,
    ),
    lastAt: responses[0]?.createdAt.toISOString() ?? null,
    questions: form.questions.filter((q) => q.type !== "text_display").map((q) => summarizeQuestion(q, answers)),
    rsvp,
  };
}

/** Every response to one form as CSV (anonymous ones without who sent them). */
export async function exportWebFormCsv(guild: Guild, openingId: string): Promise<{ filename: string; csv: string; rows: number } | null> {
  const config = await loadConfig(guild);
  const form = findOpening(config, openingId);
  if (!form) return null;
  const responses = responsesForForm(guild.id, openingId, 20_000).reverse();
  const questions = form.questions.filter((q) => q.type !== "text_display");
  const known = new Set(questions.map((q) => q.id));
  // Questions removed since keep their column, labelled as they were asked.
  const extra = new Map<string, string>();
  for (const r of responses) for (const a of r.answers) if (!known.has(a.questionId) && !extra.has(a.questionId)) extra.set(a.questionId, a.label);
  const columns = [...questions.map((q) => ({ id: q.id, label: q.label })), ...[...extra].map(([id, label]) => ({ id, label: `${label} (removed)` }))];
  const header = ["Response", "Submitted (UTC)", "Member ID", "Member", "Status", ...(form.kind === "rsvp" ? ["RSVP"] : []), "Reviewed by", "Reason", ...columns.map((c) => c.label)];
  const people: People = new Map();
  const person = personLoader(guild, people);
  const rows: string[][] = [header];
  for (const r of responses) {
    const who = r.anonymous ? null : await person(r.userId);
    const byId = new Map(r.answers.map((a) => [a.questionId, a.answer]));
    rows.push([
      String(r.id),
      r.createdAt.toISOString(),
      r.anonymous ? "" : r.userId,
      r.anonymous ? "Anonymous" : (who?.username ?? who?.name ?? ""),
      statusMeta(form, r.status).label,
      ...(form.kind === "rsvp" ? [r.rsvp ? `${r.rsvp.replace("_", " ")}${r.waitlisted ? " (waitlist)" : ""}` : ""] : []),
      r.reviewerId ?? "",
      r.reason ?? "",
      ...columns.map((c) => byId.get(c.id) ?? ""),
    ]);
  }
  const slug = (form.name.trim() || "form").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "form";
  return { filename: `${slug}-responses.csv`, csv: toCsv(rows), rows: responses.length };
}
