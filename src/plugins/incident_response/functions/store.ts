import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { incidentEvents, incidentLockdowns, incidents, incidentSignals } from "../../../db/schema.js";
import type {
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
} from "../../../config/schemas/incidentResponse.js";

export type IncidentEntityType = "user" | "channel" | "guild";

export type IncidentRow = {
  id: number;
  guildId: string;
  entityType: IncidentEntityType;
  entityId: string;
  severity: IncidentSeverity;
  riskScore: number;
  status: IncidentStatus;
  title: string;
  signalCount: number;
  sourceCount: number;
  respondedSeverity: IncidentSeverity | null;
  actionsTaken: string[];
  firstSignalAt: Date;
  lastSignalAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IncidentSignalRow = {
  id: number;
  incidentId: number;
  guildId: string;
  source: IncidentSource;
  signalType: string;
  weight: number;
  entityType: IncidentEntityType;
  entityId: string;
  secondaryEntityType: IncidentEntityType | null;
  secondaryEntityId: string | null;
  reason: string;
  detail: string | null;
  createdAt: Date;
};

function toIncident(row: typeof incidents.$inferSelect): IncidentRow {
  return {
    id: row.id,
    guildId: row.guildId,
    entityType: row.entityType as IncidentEntityType,
    entityId: row.entityId,
    severity: row.severity as IncidentSeverity,
    riskScore: row.riskScore,
    status: row.status as IncidentStatus,
    title: row.title,
    signalCount: row.signalCount,
    sourceCount: row.sourceCount,
    respondedSeverity: (row.respondedSeverity as IncidentSeverity | null) ?? null,
    actionsTaken: safeParseStringArray(row.actionsTaken),
    firstSignalAt: row.firstSignalAt,
    lastSignalAt: row.lastSignalAt,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSignal(row: typeof incidentSignals.$inferSelect): IncidentSignalRow {
  return {
    id: row.id,
    incidentId: row.incidentId,
    guildId: row.guildId,
    source: row.source as IncidentSource,
    signalType: row.signalType,
    weight: row.weight,
    entityType: row.entityType as IncidentEntityType,
    entityId: row.entityId,
    secondaryEntityType: (row.secondaryEntityType as IncidentEntityType | null) ?? null,
    secondaryEntityId: row.secondaryEntityId,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Finds an open incident for this exact entity whose last signal is still within the
 * correlation window: the "same person/channel/server, recently" merge key. */
export async function findOpenIncidentForEntity(
  guildId: string,
  entityType: IncidentEntityType,
  entityId: string,
  windowMs: number,
): Promise<IncidentRow | null> {
  const cutoff = new Date(Date.now() - windowMs);
  const rows = await getDb()
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.guildId, guildId),
        eq(incidents.entityType, entityType),
        eq(incidents.entityId, entityId),
        eq(incidents.status, "open"),
        gte(incidents.lastSignalAt, cutoff),
      ),
    )
    .orderBy(desc(incidents.lastSignalAt))
    .limit(1);
  return rows[0] ? toIncident(rows[0]) : null;
}

/**
 * Every user with a still-open incident in this guild, regardless of how long ago the last
 * signal landed. Unlike `findOpenIncidentForEntity`, which is deliberately scoped to the
 * correlation window for its own "merge into the same incident" purpose, this is unscoped by
 * time. Used by Watchdog to cross-reference members against Incident Response without
 * re-running its correlation logic.
 */
export async function batchOpenIncidentUserIds(guildId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ entityId: incidents.entityId })
    .from(incidents)
    .where(and(eq(incidents.guildId, guildId), eq(incidents.entityType, "user"), eq(incidents.status, "open")));
  return new Set(rows.map((row) => row.entityId));
}

/** Single-user, unscoped-by-time version of `batchOpenIncidentUserIds`, for the `/watchdog` path. */
export async function hasOpenIncidentForUser(guildId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.guildId, guildId),
        eq(incidents.entityType, "user"),
        eq(incidents.entityId, userId),
        eq(incidents.status, "open"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function createIncident(input: {
  guildId: string;
  entityType: IncidentEntityType;
  entityId: string;
  title: string;
}): Promise<IncidentRow> {
  const now = new Date();
  const row = await getDb()
    .insert(incidents)
    .values({
      guildId: input.guildId,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: "low",
      riskScore: 0,
      status: "open",
      title: input.title,
      signalCount: 0,
      sourceCount: 0,
      respondedSeverity: null,
      actionsTaken: "[]",
      firstSignalAt: now,
      lastSignalAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toIncident(row);
}

export async function insertIncidentSignal(input: {
  incidentId: number;
  guildId: string;
  source: IncidentSource;
  signalType: string;
  weight: number;
  entityType: IncidentEntityType;
  entityId: string;
  secondaryEntityType?: IncidentEntityType | null;
  secondaryEntityId?: string | null;
  reason: string;
  detail?: string | null;
}): Promise<IncidentSignalRow> {
  const row = await getDb()
    .insert(incidentSignals)
    .values({
      incidentId: input.incidentId,
      guildId: input.guildId,
      source: input.source,
      signalType: input.signalType,
      weight: input.weight,
      entityType: input.entityType,
      entityId: input.entityId,
      secondaryEntityType: input.secondaryEntityType ?? null,
      secondaryEntityId: input.secondaryEntityId ?? null,
      reason: input.reason,
      detail: input.detail ?? null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return toSignal(row);
}

export async function listIncidentSignals(incidentId: number): Promise<IncidentSignalRow[]> {
  const rows = await getDb()
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId))
    .orderBy(incidentSignals.createdAt);
  return rows.map(toSignal);
}

export async function updateIncidentAfterSignal(
  incidentId: number,
  patch: {
    riskScore: number;
    severity: IncidentSeverity;
    signalCount: number;
    sourceCount: number;
    lastSignalAt: Date;
    title?: string;
  },
): Promise<IncidentRow> {
  const row = await getDb()
    .update(incidents)
    .set({
      riskScore: patch.riskScore,
      severity: patch.severity,
      signalCount: patch.signalCount,
      sourceCount: patch.sourceCount,
      lastSignalAt: patch.lastSignalAt,
      ...(patch.title ? { title: patch.title } : {}),
      updatedAt: new Date(),
    })
    .where(eq(incidents.id, incidentId))
    .returning()
    .get();
  return toIncident(row);
}

export async function markIncidentResponded(
  incidentId: number,
  severity: IncidentSeverity,
  actionsTaken: string[],
): Promise<void> {
  await getDb()
    .update(incidents)
    .set({ respondedSeverity: severity, actionsTaken: JSON.stringify(actionsTaken), updatedAt: new Date() })
    .where(eq(incidents.id, incidentId));
}

export async function getIncident(guildId: string, id: number): Promise<IncidentRow | null> {
  const row = await getDb()
    .select()
    .from(incidents)
    .where(and(eq(incidents.guildId, guildId), eq(incidents.id, id)))
    .get();
  return row ? toIncident(row) : null;
}

export type IncidentSort = "recent" | "oldest" | "risk" | "signals" | "created";

export type IncidentListFilters = {
  status?: IncidentStatus;
  /** Several statuses at once (e.g. "active" = open + acknowledged). Ignored when `status` is set. */
  statuses?: IncidentStatus[];
  severity?: IncidentSeverity;
  source?: IncidentSource;
  entityType?: IncidentEntityType;
  /** Free text: "#12" or "12" matches the id, a snowflake matches the entity, anything else the title. */
  q?: string;
  sort?: IncidentSort;
  limit?: number;
  offset?: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listIncidents(
  guildId: string,
  filters: IncidentListFilters = {},
): Promise<{ incidents: IncidentRow[]; total: number }> {
  const conditions: SQL[] = [eq(incidents.guildId, guildId)];
  if (filters.status) conditions.push(eq(incidents.status, filters.status));
  else if (filters.statuses?.length) conditions.push(inArray(incidents.status, filters.statuses));
  if (filters.severity) conditions.push(eq(incidents.severity, filters.severity));
  if (filters.entityType) conditions.push(eq(incidents.entityType, filters.entityType));
  if (filters.source) {
    // Scoped to this guild's signals too, so a source filter can never reach another server's rows.
    const withSource = getDb()
      .select({ id: incidentSignals.incidentId })
      .from(incidentSignals)
      .where(and(eq(incidentSignals.guildId, guildId), eq(incidentSignals.source, filters.source)));
    conditions.push(inArray(incidents.id, withSource));
  }
  const q = filters.q?.trim();
  if (q) {
    const idMatch = /^#?(\d{1,9})$/.exec(q);
    if (idMatch) {
      conditions.push(eq(incidents.id, Number(idMatch[1])));
    } else if (/^\d{15,22}$/.test(q)) {
      conditions.push(eq(incidents.entityId, q));
    } else {
      conditions.push(sql`${incidents.title} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`);
    }
  }

  const where = and(...conditions);
  const limit = filters.limit ?? 40;
  const offset = filters.offset ?? 0;
  const order =
    filters.sort === "oldest"
      ? [asc(incidents.lastSignalAt)]
      : filters.sort === "risk"
        ? [desc(incidents.riskScore), desc(incidents.lastSignalAt)]
        : filters.sort === "signals"
          ? [desc(incidents.signalCount), desc(incidents.lastSignalAt)]
          : filters.sort === "created"
            ? [desc(incidents.firstSignalAt)]
            : [desc(incidents.lastSignalAt)];

  const [rows, [totalRow]] = await Promise.all([
    getDb().select().from(incidents).where(where).orderBy(...order).limit(limit).offset(offset),
    getDb().select({ value: count() }).from(incidents).where(where),
  ]);

  return { incidents: rows.map(toIncident), total: totalRow?.value ?? 0 };
}

export async function setIncidentStatus(
  guildId: string,
  id: number,
  status: IncidentStatus,
  actorId: string,
): Promise<IncidentRow | null> {
  const closing = status === "resolved" || status === "dismissed";
  const row = await getDb()
    .update(incidents)
    .set({
      status,
      updatedAt: new Date(),
      // Reopening or acknowledging clears who closed it, so the closed-by line never goes stale.
      ...(closing ? { resolvedBy: actorId, resolvedAt: new Date() } : { resolvedBy: null, resolvedAt: null }),
    })
    .where(and(eq(incidents.guildId, guildId), eq(incidents.id, id)))
    .returning()
    .get();
  return row ? toIncident(row) : null;
}

// --- Activity log (incident_events) -------------------------------------------------------

export type IncidentEventKind = "note" | "status" | "response" | "unlock";

export type IncidentEventRow = {
  id: number;
  incidentId: number;
  kind: IncidentEventKind;
  actorId: string | null;
  value: string | null;
  content: string | null;
  createdAt: Date;
};

function toEvent(row: typeof incidentEvents.$inferSelect): IncidentEventRow {
  return {
    id: row.id,
    incidentId: row.incidentId,
    kind: row.kind as IncidentEventKind,
    actorId: row.actorId,
    value: row.value,
    content: row.content,
    createdAt: row.createdAt,
  };
}

export async function insertIncidentEvent(input: {
  incidentId: number;
  guildId: string;
  kind: IncidentEventKind;
  actorId?: string | null;
  value?: string | null;
  content?: string | null;
}): Promise<IncidentEventRow> {
  const row = await getDb()
    .insert(incidentEvents)
    .values({
      incidentId: input.incidentId,
      guildId: input.guildId,
      kind: input.kind,
      actorId: input.actorId ?? null,
      value: input.value ?? null,
      content: input.content ?? null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return toEvent(row);
}

/** Best-effort event write: the activity log must never break the action it describes. */
export async function recordIncidentEvent(input: Parameters<typeof insertIncidentEvent>[0]): Promise<void> {
  await insertIncidentEvent(input).catch(() => null);
}

export async function listIncidentEvents(guildId: string, incidentId: number): Promise<IncidentEventRow[]> {
  const rows = await getDb()
    .select()
    .from(incidentEvents)
    .where(and(eq(incidentEvents.guildId, guildId), eq(incidentEvents.incidentId, incidentId)))
    .orderBy(asc(incidentEvents.createdAt), asc(incidentEvents.id));
  return rows.map(toEvent);
}

/** Deletes one staff note. Only notes: status changes and automatic actions stay in the log. */
export async function deleteIncidentNote(guildId: string, incidentId: number, eventId: number): Promise<boolean> {
  const row = await getDb()
    .delete(incidentEvents)
    .where(
      and(
        eq(incidentEvents.guildId, guildId),
        eq(incidentEvents.incidentId, incidentId),
        eq(incidentEvents.id, eventId),
        eq(incidentEvents.kind, "note"),
      ),
    )
    .returning({ id: incidentEvents.id })
    .get();
  return Boolean(row);
}

// --- Lockdowns and stats --------------------------------------------------------------------

export type IncidentLockdownRow = {
  id: number;
  channelId: string;
  lockedAt: Date;
  lockedBy: string;
  unlockAt: Date | null;
  unlockedAt: Date | null;
  unlockedBy: string | null;
};

export async function listIncidentLockdowns(guildId: string, incidentId: number): Promise<IncidentLockdownRow[]> {
  const rows = await getDb()
    .select()
    .from(incidentLockdowns)
    .where(and(eq(incidentLockdowns.guildId, guildId), eq(incidentLockdowns.incidentId, incidentId)))
    .orderBy(asc(incidentLockdowns.lockedAt));
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    lockedAt: row.lockedAt,
    lockedBy: row.lockedBy,
    unlockAt: row.unlockAt,
    unlockedAt: row.unlockedAt,
    unlockedBy: row.unlockedBy,
  }));
}

export type IncidentStats = {
  total: number;
  byStatus: Record<IncidentStatus, number>;
  /** Open or acknowledged incidents, by severity. */
  activeBySeverity: Record<IncidentSeverity, number>;
  /** Incidents with at least one signal from each source, last 30 days. */
  bySource30d: Partial<Record<IncidentSource, number>>;
  createdLast7d: number;
  createdLast30d: number;
  closedLast30d: number;
  activeLockdowns: number;
  /** New incidents per day, oldest first, last 30 days (today last). */
  daily: number[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getIncidentStats(guildId: string, now = new Date()): Promise<IncidentStats> {
  const db = getDb();
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);

  const [statusRows, severityRows, sourceRows, recentRows, closedRow, lockRow] = await Promise.all([
    db
      .select({ status: incidents.status, value: count() })
      .from(incidents)
      .where(eq(incidents.guildId, guildId))
      .groupBy(incidents.status),
    db
      .select({ severity: incidents.severity, value: count() })
      .from(incidents)
      .where(and(eq(incidents.guildId, guildId), inArray(incidents.status, ["open", "acknowledged"])))
      .groupBy(incidents.severity),
    db
      .select({ source: incidentSignals.source, value: countDistinct(incidentSignals.incidentId) })
      .from(incidentSignals)
      .where(and(eq(incidentSignals.guildId, guildId), gte(incidentSignals.createdAt, since30)))
      .groupBy(incidentSignals.source),
    db
      .select({ at: incidents.firstSignalAt })
      .from(incidents)
      .where(and(eq(incidents.guildId, guildId), gte(incidents.firstSignalAt, since30))),
    db
      .select({ value: count() })
      .from(incidents)
      .where(and(eq(incidents.guildId, guildId), gte(incidents.resolvedAt, since30)))
      .get(),
    db
      .select({ value: count() })
      .from(incidentLockdowns)
      .where(and(eq(incidentLockdowns.guildId, guildId), isNull(incidentLockdowns.unlockedAt)))
      .get(),
  ]);

  const byStatus: Record<IncidentStatus, number> = { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 };
  let total = 0;
  for (const row of statusRows) {
    total += row.value;
    if (row.status in byStatus) byStatus[row.status as IncidentStatus] = row.value;
  }
  const activeBySeverity: Record<IncidentSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of severityRows) {
    if (row.severity in activeBySeverity) activeBySeverity[row.severity as IncidentSeverity] = row.value;
  }
  const bySource30d: Partial<Record<IncidentSource, number>> = {};
  for (const row of sourceRows) bySource30d[row.source as IncidentSource] = row.value;

  const daily = new Array<number>(30).fill(0);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  let createdLast7d = 0;
  for (const row of recentRows) {
    const at = row.at.getTime();
    if (at >= since7.getTime()) createdLast7d++;
    const daysAgo = at >= todayStart.getTime() ? 0 : Math.ceil((todayStart.getTime() - at) / DAY_MS);
    const index = 29 - daysAgo;
    if (index >= 0 && index < 30) daily[index]! += 1;
  }

  return {
    total,
    byStatus,
    activeBySeverity,
    bySource30d,
    createdLast7d,
    createdLast30d: recentRows.length,
    closedLast30d: closedRow?.value ?? 0,
    activeLockdowns: lockRow?.value ?? 0,
    daily,
  };
}
