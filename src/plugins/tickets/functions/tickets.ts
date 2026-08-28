import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { tickets } from "../../../db/schema.js";
import type { TicketPriority } from "../../../config/schemas/tickets.js";

export type TicketFormAnswer = { questionId: string; label: string; answer: string };

export type TicketRecord = {
  id: number;
  guildId: string;
  panelId: string;
  categoryId: string;
  number: number;
  channelId: string;
  threadId: string | null;
  mode: "channel" | "thread";
  openerId: string;
  claimedBy: string | null;
  status: "open" | "closed";
  priority: TicketPriority;
  formResponses: TicketFormAnswer[];
  memberIds: string[];
  createdAt: Date;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
  lastActivityAt: Date;
  ratingScore: number | null;
  ratingComment: string | null;
  /** Last time a member with a support role sent a message in this ticket. Null if staff never replied. */
  lastStaffReplyAt: Date | null;
  /** Index of the highest escalation step fired since the last staff reply. -1 means none fired yet. */
  escalationStep: number;
};

function rowToRecord(row: typeof tickets.$inferSelect): TicketRecord {
  let formResponses: TicketFormAnswer[] = [];
  let memberIds: string[] = [];
  try {
    formResponses = JSON.parse(row.formResponses) as TicketFormAnswer[];
  } catch {
    formResponses = [];
  }
  try {
    memberIds = JSON.parse(row.memberIds) as string[];
  } catch {
    memberIds = [];
  }
  return {
    id: row.id,
    guildId: row.guildId,
    panelId: row.panelId,
    categoryId: row.categoryId,
    number: row.number,
    channelId: row.channelId,
    threadId: row.threadId ?? null,
    mode: row.mode === "thread" ? "thread" : "channel",
    openerId: row.openerId,
    claimedBy: row.claimedBy ?? null,
    status: row.status === "closed" ? "closed" : "open",
    priority: (row.priority as TicketPriority) ?? "medium",
    formResponses,
    memberIds,
    createdAt: row.createdAt,
    closedAt: row.closedAt ?? null,
    closedBy: row.closedBy ?? null,
    closeReason: row.closeReason ?? null,
    lastActivityAt: row.lastActivityAt,
    ratingScore: row.ratingScore ?? null,
    ratingComment: row.ratingComment ?? null,
    lastStaffReplyAt: row.lastStaffReplyAt ?? null,
    escalationStep: row.escalationStep ?? -1,
  };
}

export async function nextTicketNumber(guildId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ number: tickets.number })
    .from(tickets)
    .where(eq(tickets.guildId, guildId))
    .orderBy(desc(tickets.number))
    .limit(1);
  return (rows[0]?.number ?? 0) + 1;
}

export async function createTicket(input: {
  guildId: string;
  panelId: string;
  categoryId: string;
  channelId: string;
  threadId?: string | null;
  mode: "channel" | "thread";
  openerId: string;
  priority?: TicketPriority;
  formResponses?: TicketFormAnswer[];
  /** Pre-computed ticket number (e.g. already used to name the channel). Recomputed if omitted. */
  number?: number;
}): Promise<TicketRecord> {
  const db = getDb();
  const number = input.number ?? (await nextTicketNumber(input.guildId));
  const now = new Date();
  const row = await db
    .insert(tickets)
    .values({
      guildId: input.guildId,
      panelId: input.panelId,
      categoryId: input.categoryId,
      number,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      mode: input.mode,
      openerId: input.openerId,
      claimedBy: null,
      status: "open",
      priority: input.priority ?? "medium",
      formResponses: JSON.stringify(input.formResponses ?? []),
      memberIds: JSON.stringify([]),
      createdAt: now,
      lastActivityAt: now,
    })
    .returning()
    .get();
  return rowToRecord(row);
}

export async function getTicket(guildId: string, id: number): Promise<TicketRecord | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)))
    .get();
  return row ? rowToRecord(row) : null;
}

export async function getTicketByChannel(guildId: string, channelId: string): Promise<TicketRecord | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.channelId, channelId)))
    .get();
  if (row) return rowToRecord(row);
  const threadRow = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.threadId, channelId)))
    .get();
  return threadRow ? rowToRecord(threadRow) : null;
}

export async function getOpenTicketsForUser(guildId: string, userId: string): Promise<TicketRecord[]> {
  const db = getDb();
  const openerRows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.openerId, userId), eq(tickets.status, "open")));
  const memberRows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.status, "open"), like(tickets.memberIds, `%"${userId}"%`)));

  const byId = new Map<number, TicketRecord>();
  for (const row of [...openerRows, ...memberRows]) {
    const record = rowToRecord(row);
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export async function countOpenTicketsForUser(guildId: string, userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guildId), eq(tickets.openerId, userId), eq(tickets.status, "open")));
  return rows.length;
}

export type TicketQueryFilters = {
  status?: "open" | "closed";
  categoryId?: string;
  panelId?: string;
  openerId?: string;
  claimedBy?: string;
  limit?: number;
  offset?: number;
};

export async function queryTickets(guildId: string, filters: TicketQueryFilters): Promise<{ tickets: TicketRecord[]; total: number }> {
  const db = getDb();
  const conditions = [eq(tickets.guildId, guildId)];
  if (filters.status) conditions.push(eq(tickets.status, filters.status));
  if (filters.categoryId) conditions.push(eq(tickets.categoryId, filters.categoryId));
  if (filters.panelId) conditions.push(eq(tickets.panelId, filters.panelId));
  if (filters.openerId) conditions.push(eq(tickets.openerId, filters.openerId));
  if (filters.claimedBy) conditions.push(eq(tickets.claimedBy, filters.claimedBy));

  const all = await db.select().from(tickets).where(and(...conditions)).orderBy(desc(tickets.id));
  const total = all.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 40;
  const page = all.slice(offset, offset + limit);
  return { tickets: page.map(rowToRecord), total };
}

export type TicketStats = {
  openCount: number;
  closedCount: number;
  avgResolutionMs: number | null;
  topClaimers: { staffId: string; count: number }[];
};

export async function getTicketStats(guildId: string): Promise<TicketStats> {
  const db = getDb();
  const rows = await db.select().from(tickets).where(eq(tickets.guildId, guildId));
  const records = rows.map(rowToRecord);
  const openCount = records.filter((r) => r.status === "open").length;
  const closedRecords = records.filter((r) => r.status === "closed" && r.closedAt);
  const closedCount = closedRecords.length;

  const durations = closedRecords.map((r) => r.closedAt!.getTime() - r.createdAt.getTime());
  const avgResolutionMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  const claimCounts = new Map<string, number>();
  for (const record of records) {
    if (!record.claimedBy) continue;
    claimCounts.set(record.claimedBy, (claimCounts.get(record.claimedBy) ?? 0) + 1);
  }
  const topClaimers = [...claimCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([staffId, count]) => ({ staffId, count }));

  return { openCount, closedCount, avgResolutionMs, topClaimers };
}

export async function listOpenTickets(limit = 500): Promise<TicketRecord[]> {
  const db = getDb();
  const rows = await db.select().from(tickets).where(eq(tickets.status, "open")).limit(limit);
  return rows.map(rowToRecord);
}

/** Broad candidate set for the auto-close sweep; per-category hour thresholds are applied by the caller. */
export async function getExpiredInactiveTickets(limit = 500): Promise<TicketRecord[]> {
  return listOpenTickets(limit);
}

export async function claimTicket(guildId: string, id: number, staffId: string): Promise<void> {
  const db = getDb();
  await db.update(tickets).set({ claimedBy: staffId }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function unclaimTicket(guildId: string, id: number): Promise<void> {
  const db = getDb();
  await db.update(tickets).set({ claimedBy: null }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function closeTicket(
  guildId: string,
  id: number,
  actorId: string,
  reason?: string | null,
): Promise<Date> {
  const db = getDb();
  const closedAt = new Date();
  await db
    .update(tickets)
    .set({ status: "closed", closedAt, closedBy: actorId, closeReason: reason ?? null })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
  return closedAt;
}

export async function reopenTicket(guildId: string, id: number): Promise<void> {
  const db = getDb();
  await db
    .update(tickets)
    .set({ status: "open", closedAt: null, closedBy: null, closeReason: null, lastActivityAt: new Date() })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function deleteTicket(guildId: string, id: number): Promise<void> {
  const db = getDb();
  const { ticketTranscripts } = await import("../../../db/schema.js");
  await db.delete(ticketTranscripts).where(and(eq(ticketTranscripts.guildId, guildId), eq(ticketTranscripts.ticketId, id)));
  await db.delete(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function addMember(guildId: string, id: number, userId: string): Promise<TicketRecord | null> {
  const ticket = await getTicket(guildId, id);
  if (!ticket) return null;
  if (ticket.memberIds.includes(userId)) return ticket;
  const memberIds = [...ticket.memberIds, userId];
  const db = getDb();
  await db
    .update(tickets)
    .set({ memberIds: JSON.stringify(memberIds) })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
  return { ...ticket, memberIds };
}

export async function removeMember(guildId: string, id: number, userId: string): Promise<TicketRecord | null> {
  const ticket = await getTicket(guildId, id);
  if (!ticket) return null;
  const memberIds = ticket.memberIds.filter((m) => m !== userId);
  const db = getDb();
  await db
    .update(tickets)
    .set({ memberIds: JSON.stringify(memberIds) })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
  return { ...ticket, memberIds };
}

export async function setPriority(guildId: string, id: number, priority: TicketPriority): Promise<void> {
  const db = getDb();
  await db.update(tickets).set({ priority }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function setRating(guildId: string, id: number, score: number, comment?: string | null): Promise<void> {
  const db = getDb();
  await db
    .update(tickets)
    .set({ ratingScore: score, ratingComment: comment ?? null })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

export async function touchActivity(guildId: string, channelId: string): Promise<void> {
  const db = getDb();
  const ticket = await getTicketByChannel(guildId, channelId);
  if (!ticket || ticket.status !== "open") return;
  await db
    .update(tickets)
    .set({ lastActivityAt: new Date() })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticket.id)));
}

/**
 * Records a staff reply: bumps both activity and last-staff-reply timestamps, and re-arms the
 * escalation ladder (resets escalationStep to -1) so it can fire again if staff goes quiet again.
 */
export async function touchStaffReply(guildId: string, channelId: string): Promise<void> {
  const db = getDb();
  const ticket = await getTicketByChannel(guildId, channelId);
  if (!ticket || ticket.status !== "open") return;
  const now = new Date();
  await db
    .update(tickets)
    .set({ lastActivityAt: now, lastStaffReplyAt: now, escalationStep: -1 })
    .where(and(eq(tickets.guildId, guildId), eq(tickets.id, ticket.id)));
}

export async function setEscalationStep(guildId: string, id: number, step: number): Promise<void> {
  const db = getDb();
  await db.update(tickets).set({ escalationStep: step }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
}

/** Renames a ticket's Discord channel/thread. The `tickets` table has no name column of its own. */
export async function renameTicket(
  client: import("discord.js").Client,
  ticket: TicketRecord,
  name: string,
): Promise<boolean> {
  const targetId = ticket.threadId ?? ticket.channelId;
  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (!channel || !("setName" in channel)) return false;
  await (channel as import("discord.js").TextChannel | import("discord.js").ThreadChannel)
    .setName(name.slice(0, 100))
    .catch(() => null);
  return true;
}
