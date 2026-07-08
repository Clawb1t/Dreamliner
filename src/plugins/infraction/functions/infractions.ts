import { and, desc, eq, isNotNull, like, lte, or } from "drizzle-orm";
import type { Client, Guild, GuildMember, User } from "discord.js";
import { getDb } from "../../../db/client.js";
import { modCases } from "../../../db/schema.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { InfractionType } from "../../../config/schemas/infraction.js";
import type { InfractionRecord } from "./embeds.js";
import { expiryFromDuration } from "./duration.js";

export function rowToRecord(row: typeof modCases.$inferSelect): InfractionRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    modId: row.modId,
    type: row.type,
    reason: row.reason,
    active: row.active,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
  };
}

const EXCLUDED_INFRACTION_COUNT_TYPES = ["note", "unmute", "unban"];

export async function countUserInfractions(guildId: string, userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.userId, userId)));
  return rows.filter((r) => !EXCLUDED_INFRACTION_COUNT_TYPES.includes(r.type)).length;
}

export async function countUserInfractionsGlobal(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select().from(modCases).where(eq(modCases.userId, userId));
  return rows.filter((r) => !EXCLUDED_INFRACTION_COUNT_TYPES.includes(r.type)).length;
}

export async function createInfraction(input: {
  guildId: string;
  userId: string;
  modId: string;
  type: InfractionType | string;
  reason?: string | null;
  active?: boolean;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<InfractionRecord> {
  const db = getDb();
  const row = await db
    .insert(modCases)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      modId: input.modId,
      type: input.type,
      reason: input.reason ?? null,
      active: input.active ?? true,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return rowToRecord(row);
}

export async function getInfraction(guildId: string, id: number): Promise<InfractionRecord | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, id)))
    .get();
  return row ? rowToRecord(row) : null;
}

export async function searchInfractions(
  guildId: string,
  query: string,
  limit = 15,
  type?: string,
): Promise<InfractionRecord[]> {
  const db = getDb();
  const trimmed = query.trim();
  const idNum = Number(trimmed.replace(/^#/, ""));
  const typeFilter = type ? eq(modCases.type, type) : undefined;
  let rows;

  if (!Number.isNaN(idNum) && idNum > 0) {
    rows = await db
      .select()
      .from(modCases)
      .where(and(eq(modCases.guildId, guildId), eq(modCases.id, idNum), ...(typeFilter ? [typeFilter] : [])))
      .limit(limit);
  } else if (/^\d{17,20}$/.test(trimmed)) {
    rows = await db
      .select()
      .from(modCases)
      .where(and(eq(modCases.guildId, guildId), or(eq(modCases.userId, trimmed), eq(modCases.modId, trimmed)), ...(typeFilter ? [typeFilter] : [])))
      .orderBy(desc(modCases.id))
      .limit(limit);
  } else if (trimmed) {
    rows = await db
      .select()
      .from(modCases)
      .where(and(eq(modCases.guildId, guildId), like(modCases.reason, `%${trimmed}%`), ...(typeFilter ? [typeFilter] : [])))
      .orderBy(desc(modCases.id))
      .limit(limit);
  } else {
    rows = await db
      .select()
      .from(modCases)
      .where(and(eq(modCases.guildId, guildId), ...(typeFilter ? [typeFilter] : [])))
      .orderBy(desc(modCases.id))
      .limit(limit);
  }

  return rows.map(rowToRecord);
}

export async function getActiveInfractions(
  guildId: string,
  userId: string,
  types: string[],
): Promise<InfractionRecord[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modCases)
    .where(
      and(
        eq(modCases.guildId, guildId),
        eq(modCases.userId, userId),
        eq(modCases.active, true),
        or(...types.map((t) => eq(modCases.type, t))),
      ),
    )
    .orderBy(desc(modCases.id));
  return rows.map(rowToRecord);
}

export async function deactivateInfractions(guildId: string, userId: string, types: string[]) {
  const db = getDb();
  await db
    .update(modCases)
    .set({ active: false })
    .where(
      and(
        eq(modCases.guildId, guildId),
        eq(modCases.userId, userId),
        eq(modCases.active, true),
        or(...types.map((t) => eq(modCases.type, t))),
      ),
    );
}

export async function updateInfractionReason(guildId: string, id: number, reason: string) {
  const db = getDb();
  await db
    .update(modCases)
    .set({ reason })
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, id)));
}

export async function updateInfractionDuration(
  guildId: string,
  id: number,
  durationMs: number,
  type?: InfractionType,
): Promise<Date> {
  const record = await getInfraction(guildId, id);
  if (!record) throw new Error("Infraction not found");
  const expiresAt = expiryFromDuration(durationMs, record.createdAt);
  const db = getDb();
  await db
    .update(modCases)
    .set({
      expiresAt,
      active: true,
      ...(type ? { type } : {}),
    })
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, id)));
  return expiresAt;
}

export async function deleteInfraction(guildId: string, id: number) {
  const db = getDb();
  await db.delete(modCases).where(and(eq(modCases.guildId, guildId), eq(modCases.id, id)));
}

export async function getExpiredActiveInfractions(): Promise<InfractionRecord[]> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.active, true), isNotNull(modCases.expiresAt), lte(modCases.expiresAt, now)))
    .limit(50);
  return rows.map(rowToRecord);
}

export async function postCaseLog(
  client: Client,
  guildConfig: GuildConfig,
  pluginConfig: InfractionConfig,
  record: InfractionRecord,
  user?: User | null,
  mod?: User | null,
  options?: { durationLabel?: string | null },
) {
  const { buildCaseCreateLog } = await import("../../../core/logging/format.js");
  const { sendModerationLog } = await import("../../../core/logging/send.js");
  const content = buildCaseCreateLog(record, {
    durationLabel: options?.durationLabel,
    user: user ? { id: user.id, name: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) } : { id: record.userId },
    mod: mod ? { id: mod.id, name: mod.username, avatarUrl: mod.displayAvatarURL({ size: 128 }) } : { id: record.modId },
  });
  await sendModerationLog(client, guildConfig, content, {
    caseLogOverride: pluginConfig.case_log_channel,
  });
}

export async function dmUser(
  user: User,
  pluginConfig: InfractionConfig,
  action: keyof InfractionConfig["notify"],
  message: string,
): Promise<boolean> {
  const settings = pluginConfig.notify[action];
  if (!settings?.dm) return false;
  try {
    await user.send(message);
    return true;
  } catch {
    return false;
  }
}

export function buildNotifyMessage(
  pluginConfig: InfractionConfig,
  action: keyof InfractionConfig["notify"],
  vars: Record<string, string>,
): string | null {
  const settings = pluginConfig.notify[action];
  if (!settings?.dm) return null;
  if (!settings.format) {
    return `You have been **${vars.action ?? action}** in **${vars.guild}**. Reason: ${vars.reason}`;
  }
  return settings.format
    .replace(/\{action\}/g, vars.action ?? action)
    .replace(/\{guild\}/g, vars.guild ?? "")
    .replace(/\{reason\}/g, vars.reason ?? "No reason provided")
    .replace(/\{mod\}/g, vars.mod ?? "Staff")
    .replace(/\{expires\}/g, vars.expires ?? "");
}

export async function applyMuteRole(member: GuildMember, muteRoleId: string) {
  await member.roles.add(muteRoleId, "Dreamliner mute");
}

export async function removeMuteRole(member: GuildMember, muteRoleId: string) {
  await member.roles.remove(muteRoleId, "Dreamliner unmute");
}

export async function expireInfraction(client: Client, record: InfractionRecord) {
  const guild = await client.guilds.fetch(record.guildId).catch(() => null);
  if (!guild) return;

  const db = getDb();
  await db
    .update(modCases)
    .set({ active: false })
    .where(and(eq(modCases.guildId, record.guildId), eq(modCases.id, record.id)));

  const { configManager } = await import("../../../config/manager.js");
  const guildConfig = await configManager.getEffectiveConfig(record.guildId);
  const { buildMuteExpiredLog, buildTempbanExpiredLog } = await import("../../../core/logging/format.js");
  const { sendModerationLog } = await import("../../../core/logging/send.js");

  if (record.type === "tempmute" || record.type === "mute") {
    const { getInfractionPluginConfig } = await import("../../../core/guildHelpers.js");
    const pluginConfig = getInfractionPluginConfig(guildConfig) as InfractionConfig;
    const muteRoleId = pluginConfig.mute_role;
    if (muteRoleId) {
      const member = await guild.members.fetch(record.userId).catch(() => null);
      if (member?.roles.cache.has(muteRoleId)) {
        await removeMuteRole(member, muteRoleId).catch(() => null);
      }
    }
    const user = await client.users.fetch(record.userId).catch(() => null);
    const userRef = user
      ? { id: user.id, name: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) }
      : { id: record.userId };
    await sendModerationLog(client, guildConfig, buildMuteExpiredLog(userRef));
  }

  if (record.type === "tempban") {
    await guild.members.unban(record.userId, "Dreamliner tempban expired").catch(() => null);
    const user = await client.users.fetch(record.userId).catch(() => null);
    const userRef = user
      ? { id: user.id, name: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) }
      : { id: record.userId };
    await sendModerationLog(client, guildConfig, buildTempbanExpiredLog(userRef));
  }
}

export async function processExpiredInfractions(client: Client) {
  const expired = await getExpiredActiveInfractions();
  for (const record of expired) {
    await expireInfraction(client, record).catch((err) => {
      console.error(`Failed to expire infraction #${record.id}:`, err);
    });
  }
}

export function requireMuteRole(pluginConfig: InfractionConfig): string | null {
  return pluginConfig.mute_role ?? null;
}

export async function isUserMuted(guild: Guild, userId: string, muteRoleId: string): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  return member?.roles.cache.has(muteRoleId) ?? false;
}
