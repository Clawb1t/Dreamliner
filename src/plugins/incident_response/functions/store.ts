import { and, count, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { incidents, incidentSignals } from "../../../db/schema.js";
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
 * correlation window — the "same person/channel/server, recently" merge key. */
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

export type IncidentListFilters = {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  limit?: number;
  offset?: number;
};

export async function listIncidents(
  guildId: string,
  filters: IncidentListFilters = {},
): Promise<{ incidents: IncidentRow[]; total: number }> {
  const conditions = [eq(incidents.guildId, guildId)];
  if (filters.status) conditions.push(eq(incidents.status, filters.status));
  if (filters.severity) conditions.push(eq(incidents.severity, filters.severity));

  const where = and(...conditions);
  const limit = filters.limit ?? 40;
  const offset = filters.offset ?? 0;

  const [rows, [totalRow]] = await Promise.all([
    getDb().select().from(incidents).where(where).orderBy(desc(incidents.lastSignalAt)).limit(limit).offset(offset),
    getDb().select({ value: count() }).from(incidents).where(where),
  ]);

  return { incidents: rows.map(toIncident), total: totalRow?.value ?? 0 };
}

export async function setIncidentStatus(
  guildId: string,
  id: number,
  status: Extract<IncidentStatus, "resolved" | "dismissed" | "acknowledged">,
  actorId: string,
): Promise<IncidentRow | null> {
  const row = await getDb()
    .update(incidents)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === "resolved" || status === "dismissed"
        ? { resolvedBy: actorId, resolvedAt: new Date() }
        : {}),
    })
    .where(and(eq(incidents.guildId, guildId), eq(incidents.id, id)))
    .returning()
    .get();
  return row ? toIncident(row) : null;
}
