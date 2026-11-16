import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  zIncidentResponseConfig,
  type IncidentResponseConfig,
  type IncidentSeverity,
  type IncidentSource,
  type IncidentStatus,
} from "../config/schemas/incidentResponse.js";
import {
  deleteIncidentNote,
  getIncident,
  getIncidentStats,
  insertIncidentEvent,
  listIncidentEvents,
  listIncidentLockdowns,
  listIncidents,
  listIncidentSignals,
  recordIncidentEvent,
  setIncidentStatus,
  type IncidentEntityType,
  type IncidentEventRow,
  type IncidentRow,
  type IncidentSignalRow,
  type IncidentSort,
  type IncidentStats,
} from "../plugins/incident_response/functions/store.js";
import { unlockChannelManually } from "../plugins/incident_response/functions/lockdown.js";
import type { WebPerson } from "./webModeration.js";

export type WebIncidentResponsePayload = {
  enabled: boolean;
  config: IncidentResponseConfig;
};

export async function getWebIncidentResponseState(guildId: string): Promise<WebIncidentResponsePayload> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const config = zIncidentResponseConfig.parse(guildConfig.plugins.incident_response?.config ?? {});
  return { enabled: guildConfig.plugins.incident_response?.enabled === true, config };
}

export async function saveWebIncidentResponse(
  guildId: string,
  userId: string,
  input: { enabled?: boolean; config?: unknown },
): Promise<WebIncidentResponsePayload> {
  if (input.config !== undefined) {
    const parsed = zIncidentResponseConfig.parse(input.config);
    const result = await configManager.patchPluginConfig(guildId, "incident_response", parsed, userId);
    if (!result.success) throw new Error(result.errors.join("\n"));
  }
  if (typeof input.enabled === "boolean") {
    const result = await configManager.setPluginEnabled(guildId, "incident_response", input.enabled, userId);
    if (!result.success) throw new Error(result.errors.join("\n"));
  }
  return getWebIncidentResponseState(guildId);
}

/** Resolves entities once per request: a list page can mention the same member many times. */
type EntityCache = Map<string, Promise<WebPerson>>;

function resolveEntity(
  guild: Guild,
  entityType: IncidentEntityType,
  entityId: string,
  cache: EntityCache = new Map(),
): Promise<WebPerson> {
  const key = `${entityType}:${entityId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = resolveEntityUncached(guild, entityType, entityId);
  cache.set(key, pending);
  return pending;
}

async function resolveEntityUncached(guild: Guild, entityType: IncidentEntityType, entityId: string): Promise<WebPerson> {
  if (entityType === "guild") {
    // Only ever this guild's own name: a guild entity id from another server is never looked up.
    return { id: entityId, name: entityId === guild.id ? guild.name : "Server", username: null, avatar: entityId === guild.id ? guild.iconURL({ size: 64 }) : null };
  }
  if (entityType === "channel") {
    const channel = guild.channels.cache.get(entityId);
    return { id: entityId, name: channel ? `#${channel.name}` : "#deleted-channel", username: null, avatar: null };
  }
  const member = await guild.members.fetch(entityId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(entityId).catch(() => null));
  return {
    id: entityId,
    name: member?.displayName ?? user?.username ?? entityId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

/** A staff member (or Dreamliner itself, for a null actor or the bot's own id). */
function resolveActor(guild: Guild, actorId: string | null, cache: EntityCache): Promise<WebPerson> {
  if (!actorId || actorId === "system" || actorId === guild.client.user?.id) {
    return Promise.resolve({
      id: guild.client.user?.id ?? "dreamliner",
      name: "Dreamliner",
      username: null,
      avatar: guild.client.user?.displayAvatarURL({ size: 64 }) ?? null,
    });
  }
  return resolveEntity(guild, "user", actorId, cache);
}

export type WebIncidentRow = {
  id: number;
  entityType: IncidentEntityType;
  entity: WebPerson;
  severity: string;
  riskScore: number;
  status: IncidentStatus;
  title: string;
  signalCount: number;
  sourceCount: number;
  actionsTaken: string[];
  firstSignalAt: string;
  lastSignalAt: string;
  resolvedBy: string | null;
  resolvedByPerson: WebPerson | null;
  resolvedAt: string | null;
};

async function toWebIncident(guild: Guild, row: IncidentRow, cache: EntityCache = new Map()): Promise<WebIncidentRow> {
  const [entity, resolvedByPerson] = await Promise.all([
    resolveEntity(guild, row.entityType, row.entityId, cache),
    row.resolvedBy ? resolveActor(guild, row.resolvedBy, cache) : Promise.resolve(null),
  ]);
  return {
    id: row.id,
    entityType: row.entityType,
    entity,
    severity: row.severity,
    riskScore: row.riskScore,
    status: row.status,
    title: row.title,
    signalCount: row.signalCount,
    sourceCount: row.sourceCount,
    actionsTaken: row.actionsTaken,
    firstSignalAt: row.firstSignalAt.toISOString(),
    lastSignalAt: row.lastSignalAt.toISOString(),
    resolvedBy: row.resolvedBy,
    resolvedByPerson,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export type WebIncidentSignal = {
  id: number;
  source: string;
  signalType: string;
  weight: number;
  entityType: IncidentEntityType;
  entity: WebPerson;
  secondaryEntityType: IncidentEntityType | null;
  secondaryEntity: WebPerson | null;
  reason: string;
  detail: string | null;
  createdAt: string;
};

async function toWebSignal(guild: Guild, row: IncidentSignalRow, cache: EntityCache): Promise<WebIncidentSignal> {
  return {
    id: row.id,
    source: row.source,
    signalType: row.signalType,
    weight: row.weight,
    entityType: row.entityType,
    entity: await resolveEntity(guild, row.entityType, row.entityId, cache),
    secondaryEntityType: row.secondaryEntityType,
    secondaryEntity:
      row.secondaryEntityType && row.secondaryEntityId
        ? await resolveEntity(guild, row.secondaryEntityType, row.secondaryEntityId, cache)
        : null,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

export type WebIncidentEvent = {
  id: number;
  kind: IncidentEventRow["kind"];
  actor: WebPerson;
  value: string | null;
  /** For "unlock": the channel's name. */
  valueLabel: string | null;
  content: string | null;
  createdAt: string;
};

async function toWebEvent(guild: Guild, row: IncidentEventRow, cache: EntityCache): Promise<WebIncidentEvent> {
  let valueLabel: string | null = null;
  if (row.kind === "unlock" && row.value) {
    const channel = guild.channels.cache.get(row.value);
    valueLabel = channel ? `#${channel.name}` : "#deleted-channel";
  }
  return {
    id: row.id,
    kind: row.kind,
    actor: await resolveActor(guild, row.actorId, cache),
    value: row.value,
    valueLabel,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

export type WebIncidentLockdown = {
  id: number;
  channelId: string;
  channelName: string;
  /** False when the channel no longer exists in this server. */
  exists: boolean;
  active: boolean;
  lockedAt: string;
  unlockAt: string | null;
  unlockedAt: string | null;
  unlockedBy: WebPerson | null;
};

export type WebIncidentStatusFilter = IncidentStatus | "active" | "closed";

export type WebIncidentsQuery = {
  status?: WebIncidentStatusFilter;
  severity?: IncidentSeverity;
  source?: IncidentSource;
  entityType?: IncidentEntityType;
  q?: string;
  sort: IncidentSort;
  limit: number;
  offset: number;
};

const SORTS: readonly IncidentSort[] = ["recent", "oldest", "risk", "signals", "created"];
const ENTITY_TYPES: readonly IncidentEntityType[] = ["user", "channel", "guild"];

function pick<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

export function parseWebIncidentsQuery(url: URL): WebIncidentsQuery {
  const p = url.searchParams;
  const limit = Math.min(100, Math.max(1, Number(p.get("limit") ?? 40) || 40));
  const offset = Math.max(0, Number(p.get("offset") ?? 0) || 0);
  const q = p.get("q")?.trim().slice(0, 100) || undefined;
  return {
    status: pick<WebIncidentStatusFilter>(p.get("status"), [...INCIDENT_STATUSES, "active", "closed"]),
    severity: pick(p.get("severity"), INCIDENT_SEVERITIES),
    source: pick(p.get("source"), INCIDENT_SOURCES),
    entityType: pick(p.get("entityType"), ENTITY_TYPES),
    q,
    sort: pick(p.get("sort"), SORTS) ?? "recent",
    limit,
    offset,
  };
}

export async function listWebIncidents(
  guild: Guild,
  query: WebIncidentsQuery,
): Promise<{ incidents: WebIncidentRow[]; total: number; limit: number; offset: number }> {
  const statusFilter =
    query.status === "active"
      ? { statuses: ["open", "acknowledged"] as IncidentStatus[] }
      : query.status === "closed"
        ? { statuses: ["resolved", "dismissed"] as IncidentStatus[] }
        : { status: query.status };
  const { incidents, total } = await listIncidents(guild.id, {
    ...statusFilter,
    severity: query.severity,
    source: query.source,
    entityType: query.entityType,
    q: query.q,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });
  const cache: EntityCache = new Map();
  const resolved = await Promise.all(incidents.map((row) => toWebIncident(guild, row, cache)));
  return { incidents: resolved, total, limit: query.limit, offset: query.offset };
}

export async function getWebIncidentStats(guild: Guild): Promise<IncidentStats> {
  return getIncidentStats(guild.id);
}

export type WebIncidentDetail = {
  incident: WebIncidentRow;
  signals: WebIncidentSignal[];
  events: WebIncidentEvent[];
  lockdowns: WebIncidentLockdown[];
};

export async function getWebIncident(guild: Guild, id: number): Promise<WebIncidentDetail | null> {
  // getIncident is scoped by guild id, so every lookup below only runs for this guild's incident.
  const row = await getIncident(guild.id, id);
  if (!row) return null;
  const [signalRows, eventRows, lockdownRows] = await Promise.all([
    listIncidentSignals(id),
    listIncidentEvents(guild.id, id),
    listIncidentLockdowns(guild.id, id),
  ]);
  const cache: EntityCache = new Map();
  const [incident, signals, events, lockdowns] = await Promise.all([
    toWebIncident(guild, row, cache),
    Promise.all(signalRows.filter((s) => s.guildId === guild.id).map((s) => toWebSignal(guild, s, cache))),
    Promise.all(eventRows.map((e) => toWebEvent(guild, e, cache))),
    Promise.all(
      lockdownRows.map(async (l): Promise<WebIncidentLockdown> => {
        const channel = guild.channels.cache.get(l.channelId);
        return {
          id: l.id,
          channelId: l.channelId,
          channelName: channel ? `#${channel.name}` : "#deleted-channel",
          exists: Boolean(channel),
          active: l.unlockedAt == null,
          lockedAt: l.lockedAt.toISOString(),
          unlockAt: l.unlockAt?.toISOString() ?? null,
          unlockedAt: l.unlockedAt?.toISOString() ?? null,
          unlockedBy: l.unlockedAt ? await resolveActor(guild, l.unlockedBy, cache) : null,
        };
      }),
    ),
  ]);
  return { incident, signals, events, lockdowns };
}

export type WebIncidentAction = "resolve" | "dismiss" | "acknowledge" | "reopen";

const ACTION_STATUS: Record<WebIncidentAction, IncidentStatus> = {
  resolve: "resolved",
  dismiss: "dismissed",
  acknowledge: "acknowledged",
  reopen: "open",
};

export const MAX_INCIDENT_NOTE = 1000;

function cleanNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim().slice(0, MAX_INCIDENT_NOTE);
  return trimmed || null;
}

/** Changes an incident's status, logging who did it (and their optional note) on its timeline. */
export async function setWebIncidentStatus(
  guild: Guild,
  id: number,
  action: WebIncidentAction,
  actorId: string,
  note?: unknown,
): Promise<WebIncidentRow | null> {
  const status = ACTION_STATUS[action];
  const current = await getIncident(guild.id, id);
  if (!current) return null;
  if (current.status === status) return toWebIncident(guild, current);
  const row = await setIncidentStatus(guild.id, id, status, actorId);
  if (!row) return null;
  await recordIncidentEvent({ incidentId: id, guildId: guild.id, kind: "status", actorId, value: status, content: cleanNote(note) });
  return toWebIncident(guild, row);
}

export async function resolveWebIncident(guild: Guild, id: number, actorId: string): Promise<WebIncidentRow | null> {
  return setWebIncidentStatus(guild, id, "resolve", actorId);
}

export async function dismissWebIncident(guild: Guild, id: number, actorId: string): Promise<WebIncidentRow | null> {
  return setWebIncidentStatus(guild, id, "dismiss", actorId);
}

/** Bulk status change, up to 50 of this guild's incidents. */
export async function bulkWebIncidents(
  guild: Guild,
  ids: unknown,
  action: WebIncidentAction,
  actorId: string,
): Promise<{ ok: number[]; failed: Array<{ id: number; error: string }> }> {
  const list = Array.isArray(ids)
    ? [...new Set(ids.filter((v): v is number => Number.isInteger(v) && v > 0))].slice(0, 50)
    : [];
  const ok: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  for (const id of list) {
    try {
      const row = await setWebIncidentStatus(guild, id, action, actorId);
      if (row) ok.push(id);
      else failed.push({ id, error: "Incident not found." });
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : "Failed to update." });
    }
  }
  return { ok, failed };
}

export async function addWebIncidentNote(
  guild: Guild,
  id: number,
  actorId: string,
  content: unknown,
): Promise<{ event: WebIncidentEvent } | { error: string; status: number }> {
  const text = cleanNote(content);
  if (!text) return { error: "Write a note first.", status: 400 };
  const incident = await getIncident(guild.id, id);
  if (!incident) return { error: "Incident not found.", status: 404 };
  const row = await insertIncidentEvent({ incidentId: id, guildId: guild.id, kind: "note", actorId, content: text });
  return { event: await toWebEvent(guild, row, new Map()) };
}

export async function deleteWebIncidentNote(guild: Guild, id: number, noteId: number): Promise<boolean> {
  return deleteIncidentNote(guild.id, id, noteId);
}

export async function unlockWebChannel(
  guild: Guild,
  channelId: string,
  actorId: string,
): Promise<{ ok: boolean; error?: string }> {
  // unlockChannelManually only finds this guild's lockdown rows and this guild's channels.
  return unlockChannelManually(guild, channelId, actorId);
}
