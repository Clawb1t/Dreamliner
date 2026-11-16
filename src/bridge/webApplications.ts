import type { Guild } from "discord.js";
import { APPLICATION_STATUSES, type ApplicationStatus } from "../config/schemas/applications.js";
import { configManager } from "../config/manager.js";
import type { FormAnswer } from "../core/formModal.js";
import { findOpening, loadApplicationsConfig } from "../plugins/applications/functions/config.js";
import { decide } from "../plugins/applications/functions/review.js";
import {
  addApplicationEvent,
  applicationStats,
  applicationsByUser,
  deleteApplicationEvent,
  getApplication,
  listApplicationEvents,
  listApplications,
  noteCounts,
  type ApplicationRecord,
  type ApplicationsQuery,
} from "../plugins/applications/functions/store.js";
import { resolvePerson, type WebPerson } from "./webReviews.js";

export { publishOpening } from "../plugins/applications/functions/post.js";

export type WebApplication = {
  id: number;
  openingId: string;
  openingName: string;
  status: ApplicationStatus;
  answers: FormAnswer[];
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Jump link to the review message in Discord, when there is one. */
  messageUrl: string | null;
  /** Jump link to the application's discussion thread, when it has one. */
  threadUrl: string | null;
  /** Staff notes on it (dashboard only). */
  noteCount: number;
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

export function parseApplicationsQuery(url: URL): ApplicationsQuery {
  const status = url.searchParams.get("status");
  return {
    status: (APPLICATION_STATUSES as readonly string[]).includes(status ?? "") ? (status as ApplicationStatus) : null,
    openingId: url.searchParams.get("opening")?.trim() || null,
    userId: url.searchParams.get("user")?.trim() || null,
    q: (url.searchParams.get("q") ?? "").trim().replace(/^#(?=\d+$)/, "").slice(0, 120),
    sort: url.searchParams.get("sort") === "oldest" ? "oldest" : "newest",
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
  };
}

type People = Map<string, Promise<WebPerson>>;

async function toWeb(guild: Guild, app: ApplicationRecord, people: People, notes = 0): Promise<WebApplication> {
  const person = (id: string) => {
    let cached = people.get(id);
    if (!cached) {
      cached = resolvePerson(guild, id);
      people.set(id, cached);
    }
    return cached;
  };
  return {
    id: app.id,
    openingId: app.openingId,
    openingName: app.openingName,
    status: app.status,
    answers: app.answers,
    reason: app.reason,
    createdAt: app.createdAt.toISOString(),
    decidedAt: app.decidedAt?.toISOString() ?? null,
    messageUrl:
      app.reviewChannelId && app.reviewMessageId
        ? `https://discord.com/channels/${guild.id}/${app.reviewChannelId}/${app.reviewMessageId}`
        : null,
    threadUrl: app.threadId ? `https://discord.com/channels/${guild.id}/${app.threadId}` : null,
    noteCount: notes,
    applicant: await person(app.userId),
    reviewer: app.reviewerId ? await person(app.reviewerId) : null,
  };
}

export async function listWebApplications(guild: Guild, query: ApplicationsQuery) {
  const { rows, total, counts } = listApplications(guild.id, query);
  const people: People = new Map();
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const notes = noteCounts(guild.id, rows.map((row) => row.id));
  return {
    applications: await Promise.all(rows.map((row) => toWeb(guild, row, people, notes.get(row.id) ?? 0))),
    total,
    counts,
    offset: query.offset,
    // For the opening filter: every configured opening, even ones nobody has applied to yet.
    openings: config.openings.map((o) => ({ id: o.id, name: o.name.trim() || "Untitled opening" })),
  };
}

export function getWebApplicationStats(guild: Guild) {
  const stats = applicationStats(guild.id);
  return { ...stats, oldestPendingAt: stats.oldestPendingAt?.toISOString() ?? null };
}

export async function getWebApplication(guild: Guild, id: number): Promise<WebApplication | null> {
  const app = getApplication(guild.id, id);
  if (!app) return null;
  return toWeb(guild, app, new Map(), noteCounts(guild.id, [app.id]).get(app.id) ?? 0);
}

/** The application page: the application, its notes, the applicant's other applications here. */
export async function getWebApplicationDetail(guild: Guild, id: number) {
  const app = getApplication(guild.id, id);
  if (!app) return null;
  const people: People = new Map();
  const events = listApplicationEvents(guild.id, app.id);
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const opening = findOpening(config, app.openingId);
  const person = (pid: string) => {
    let cached = people.get(pid);
    if (!cached) {
      cached = resolvePerson(guild, pid);
      people.set(pid, cached);
    }
    return cached;
  };
  return {
    application: await toWeb(guild, app, people, events.filter((e) => e.kind === "note").length),
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
    others: applicationsByUser(guild.id, app.userId)
      .filter((other) => other.id !== app.id)
      .map((other) => ({
        id: other.id,
        openingName: other.openingName,
        status: other.status,
        createdAt: other.createdAt.toISOString(),
      })),
    /** What accepting does for this opening (it may have been deleted since). */
    opening: opening
      ? {
          exists: true,
          name: opening.name.trim() || app.openingName,
          acceptRoles: opening.accept_roles,
          removeRoles: opening.accept_remove_roles,
          dmDecision: opening.dm_decision,
        }
      : { exists: false, name: app.openingName, acceptRoles: [], removeRoles: [], dmDecision: false },
  };
}

export async function decideWebApplication(
  guild: Guild,
  id: number,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<{ application: WebApplication; notes: string[] } | { error: string }> {
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const result = await decide(guild, config, id, decision, reviewerId, reason);
  if (!result.ok) return { error: result.error };
  return { application: await toWeb(guild, result.application, new Map()), notes: result.notes };
}

/** Accepts or denies several pending applications in turn (roles, DMs and Discord posts as usual). */
export async function bulkDecideWebApplications(
  guild: Guild,
  idsRaw: unknown,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): Promise<{ ok: number[]; failed: Array<{ id: number; error: string }>; notes: string[] } | { error: string }> {
  if (!Array.isArray(idsRaw)) return { error: "ids must be a list" };
  const ids = [...new Set(idsRaw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { error: "Pick at least one application." };
  if (ids.length > MAX_APPLICATION_BULK) return { error: `Up to ${MAX_APPLICATION_BULK} at a time.` };
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const ok: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  const notes = new Set<string>();
  for (const id of ids) {
    // getApplication is guild-scoped, so another server's id is just "not found".
    if (!getApplication(guild.id, id)) {
      failed.push({ id, error: "Application not found" });
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
  if (!getApplication(guild.id, applicationId)) return { status: 404, error: "Application not found" };
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
