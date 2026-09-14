import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import {
  zIncidentResponseConfig,
  type IncidentResponseConfig,
  type IncidentStatus,
} from "../config/schemas/incidentResponse.js";
import {
  getIncident,
  listIncidents,
  listIncidentSignals,
  setIncidentStatus,
  type IncidentEntityType,
  type IncidentRow,
  type IncidentSignalRow,
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

async function resolveEntity(guild: Guild, entityType: IncidentEntityType, entityId: string): Promise<WebPerson> {
  if (entityType === "guild") {
    return { id: entityId, name: guild.name, username: null, avatar: guild.iconURL({ size: 64 }) };
  }
  if (entityType === "channel") {
    const channel = guild.channels.cache.get(entityId);
    return { id: entityId, name: channel ? `#${channel.name}` : `#${entityId}`, username: null, avatar: null };
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
  resolvedAt: string | null;
};

async function toWebIncident(guild: Guild, row: IncidentRow): Promise<WebIncidentRow> {
  return {
    id: row.id,
    entityType: row.entityType,
    entity: await resolveEntity(guild, row.entityType, row.entityId),
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
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export type WebIncidentSignal = {
  id: number;
  source: string;
  signalType: string;
  weight: number;
  entity: WebPerson;
  secondaryEntity: WebPerson | null;
  reason: string;
  detail: string | null;
  createdAt: string;
};

async function toWebSignal(guild: Guild, row: IncidentSignalRow): Promise<WebIncidentSignal> {
  return {
    id: row.id,
    source: row.source,
    signalType: row.signalType,
    weight: row.weight,
    entity: await resolveEntity(guild, row.entityType, row.entityId),
    secondaryEntity:
      row.secondaryEntityType && row.secondaryEntityId
        ? await resolveEntity(guild, row.secondaryEntityType, row.secondaryEntityId)
        : null,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

export type WebIncidentsQuery = { status?: IncidentStatus; limit: number; offset: number };

export function parseWebIncidentsQuery(url: URL): WebIncidentsQuery {
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw && ["open", "acknowledged", "resolved", "dismissed"].includes(statusRaw) ? (statusRaw as IncidentStatus) : undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 40) || 40));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  return { status, limit, offset };
}

export async function listWebIncidents(
  guild: Guild,
  query: WebIncidentsQuery,
): Promise<{ incidents: WebIncidentRow[]; total: number; limit: number; offset: number }> {
  const { incidents, total } = await listIncidents(guild.id, query);
  const resolved = await Promise.all(incidents.map((row) => toWebIncident(guild, row)));
  return { incidents: resolved, total, limit: query.limit, offset: query.offset };
}

export async function getWebIncident(
  guild: Guild,
  id: number,
): Promise<{ incident: WebIncidentRow; signals: WebIncidentSignal[] } | null> {
  const row = await getIncident(guild.id, id);
  if (!row) return null;
  const signalRows = await listIncidentSignals(id);
  const [incident, signals] = await Promise.all([
    toWebIncident(guild, row),
    Promise.all(signalRows.map((s) => toWebSignal(guild, s))),
  ]);
  return { incident, signals };
}

export async function resolveWebIncident(guild: Guild, id: number, actorId: string): Promise<WebIncidentRow | null> {
  const row = await setIncidentStatus(guild.id, id, "resolved", actorId);
  return row ? toWebIncident(guild, row) : null;
}

export async function dismissWebIncident(guild: Guild, id: number, actorId: string): Promise<WebIncidentRow | null> {
  const row = await setIncidentStatus(guild.id, id, "dismissed", actorId);
  return row ? toWebIncident(guild, row) : null;
}

export async function unlockWebChannel(
  guild: Guild,
  channelId: string,
  actorId: string,
): Promise<{ ok: boolean; error?: string }> {
  return unlockChannelManually(guild, channelId, actorId);
}
