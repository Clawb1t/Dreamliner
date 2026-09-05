import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { impersonationAlerts } from "../../../db/schema.js";

export type AlertTrigger = "join" | "username" | "display_name" | "nickname" | "avatar";
export type AlertStatus = "open" | "resolved" | "dismissed";

export type ImpersonationAlert = {
  id: string;
  guildId: string;
  subjectUserId: string;
  subjectUsername: string;
  subjectAvatarUrl: string | null;
  matchedUserId: string | null;
  matchedWatchlistId: string | null;
  matchedLabel: string;
  matchedAvatarUrl: string | null;
  trigger: AlertTrigger;
  nameSimilarity: number | null;
  avatarDistance: number | null;
  autoAction: string | null;
  status: AlertStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
};

function toAlert(row: typeof impersonationAlerts.$inferSelect): ImpersonationAlert {
  return {
    id: row.id,
    guildId: row.guildId,
    subjectUserId: row.subjectUserId,
    subjectUsername: row.subjectUsername,
    subjectAvatarUrl: row.subjectAvatarUrl,
    matchedUserId: row.matchedUserId,
    matchedWatchlistId: row.matchedWatchlistId,
    matchedLabel: row.matchedLabel,
    matchedAvatarUrl: row.matchedAvatarUrl,
    trigger: row.trigger as AlertTrigger,
    nameSimilarity: row.nameSimilarity,
    avatarDistance: row.avatarDistance,
    autoAction: row.autoAction,
    status: row.status as AlertStatus,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export async function createAlert(input: {
  guildId: string;
  subjectUserId: string;
  subjectUsername: string;
  subjectAvatarUrl: string | null;
  matchedUserId?: string | null;
  matchedWatchlistId?: string | null;
  matchedLabel: string;
  matchedAvatarUrl: string | null;
  trigger: AlertTrigger;
  nameSimilarity: number | null;
  avatarDistance: number | null;
  autoAction: string | null;
}): Promise<ImpersonationAlert> {
  const row = {
    id: randomUUID(),
    guildId: input.guildId,
    subjectUserId: input.subjectUserId,
    subjectUsername: input.subjectUsername,
    subjectAvatarUrl: input.subjectAvatarUrl,
    matchedUserId: input.matchedUserId ?? null,
    matchedWatchlistId: input.matchedWatchlistId ?? null,
    matchedLabel: input.matchedLabel,
    matchedAvatarUrl: input.matchedAvatarUrl,
    trigger: input.trigger,
    nameSimilarity: input.nameSimilarity,
    avatarDistance: input.avatarDistance,
    autoAction: input.autoAction,
    status: "open" as const,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(),
  };
  await getDb().insert(impersonationAlerts).values(row);
  return toAlert(row);
}

export async function listAlerts(
  guildId: string,
  opts: { status?: AlertStatus; limit?: number } = {},
): Promise<ImpersonationAlert[]> {
  const conditions = [eq(impersonationAlerts.guildId, guildId)];
  if (opts.status) conditions.push(eq(impersonationAlerts.status, opts.status));
  const rows = await getDb()
    .select()
    .from(impersonationAlerts)
    .where(and(...conditions))
    .orderBy(desc(impersonationAlerts.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map(toAlert);
}

export async function setAlertStatus(
  guildId: string,
  id: string,
  status: Exclude<AlertStatus, "open">,
  resolvedBy: string,
): Promise<ImpersonationAlert | null> {
  const result = await getDb()
    .update(impersonationAlerts)
    .set({ status, resolvedBy, resolvedAt: new Date() })
    .where(and(eq(impersonationAlerts.guildId, guildId), eq(impersonationAlerts.id, id)))
    .returning()
    .get();
  return result ? toAlert(result) : null;
}

export async function countOpenAlerts(guildId: string): Promise<number> {
  const rows = await getDb()
    .select()
    .from(impersonationAlerts)
    .where(and(eq(impersonationAlerts.guildId, guildId), eq(impersonationAlerts.status, "open")));
  return rows.length;
}
