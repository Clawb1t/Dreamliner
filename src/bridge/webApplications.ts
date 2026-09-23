import type { Guild } from "discord.js";
import { APPLICATION_STATUSES, type ApplicationStatus } from "../config/schemas/applications.js";
import { configManager } from "../config/manager.js";
import type { FormAnswer } from "../core/formModal.js";
import { loadApplicationsConfig } from "../plugins/applications/functions/config.js";
import { decide } from "../plugins/applications/functions/review.js";
import {
  getApplication,
  listApplications,
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
  applicant: WebPerson;
  reviewer: WebPerson | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export function parseApplicationsQuery(url: URL): ApplicationsQuery {
  const status = url.searchParams.get("status");
  return {
    status: (APPLICATION_STATUSES as readonly string[]).includes(status ?? "") ? (status as ApplicationStatus) : null,
    openingId: url.searchParams.get("opening")?.trim() || null,
    userId: url.searchParams.get("user")?.trim() || null,
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
  };
}

async function toWeb(guild: Guild, app: ApplicationRecord, people: Map<string, Promise<WebPerson>>): Promise<WebApplication> {
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
    applicant: await person(app.userId),
    reviewer: app.reviewerId ? await person(app.reviewerId) : null,
  };
}

export async function listWebApplications(guild: Guild, query: ApplicationsQuery) {
  const { rows, total, counts } = listApplications(guild.id, query);
  const people = new Map<string, Promise<WebPerson>>();
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  return {
    applications: await Promise.all(rows.map((row) => toWeb(guild, row, people))),
    total,
    counts,
    offset: query.offset,
    // For the opening filter: every configured opening, even ones nobody has applied to yet.
    openings: config.openings.map((o) => ({ id: o.id, name: o.name.trim() || "Untitled opening" })),
  };
}

export async function getWebApplication(guild: Guild, id: number): Promise<WebApplication | null> {
  const app = getApplication(guild.id, id);
  return app ? toWeb(guild, app, new Map()) : null;
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
