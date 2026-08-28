import { PermissionFlagsBits, type Client, type Guild, type User } from "discord.js";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { modCases } from "../../../db/schema.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { EscalationCountType, InfractionConfig, InfractionType } from "../../../config/schemas/infraction.js";
import {
  applyTimeout,
  clampTimeoutMs,
  createInfraction,
  DISCORD_TIMEOUT_MAX_MS,
  postCaseLog,
} from "./infractions.js";

async function countQualifyingInfractions(
  guildId: string,
  userId: string,
  types: readonly string[],
  windowMs: number,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.userId, userId)));
  const cutoff = windowMs > 0 ? Date.now() - windowMs : null;
  return rows.filter((row) => types.includes(row.type) && (cutoff === null || row.createdAt.getTime() >= cutoff))
    .length;
}

/**
 * Called after every infraction command finishes. If the guild has an escalation ladder
 * configured and the just-created infraction's type counts toward it, checks whether the
 * member's qualifying-infraction total now matches a configured step and, if so, applies that
 * punishment automatically and logs it as its own case (reason tagged "Auto-escalation").
 */
export async function maybeEscalate(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  pluginConfig: InfractionConfig;
  user: User;
  triggeringType: InfractionType | string;
}): Promise<void> {
  const { client, guild, guildConfig, pluginConfig, user, triggeringType } = options;
  const escalation = pluginConfig.escalation;
  if (!escalation.enabled || !escalation.steps.length) return;
  if (!escalation.count_types.includes(triggeringType as EscalationCountType)) return;

  const count = await countQualifyingInfractions(guild.id, user.id, escalation.count_types, escalation.window_ms);
  const step = escalation.steps.find((s) => s.after === count);
  if (!step) return;

  const modId = client.user!.id;
  const reason = `Auto-escalation: reached ${count} infraction${count === 1 ? "" : "s"}`;
  const metadata = { source: "escalation", after: count };
  const member = await guild.members.fetch(user.id).catch(() => null);

  if (step.type === "mute") {
    const durationMs = clampTimeoutMs(step.duration_ms && step.duration_ms > 0 ? step.duration_ms : 600_000);
    if (member && durationMs <= DISCORD_TIMEOUT_MAX_MS) {
      await applyTimeout(member, durationMs, reason).catch(() => null);
    }
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "tempmute",
      reason,
      active: true,
      expiresAt: new Date(Date.now() + durationMs),
      metadata,
    });
    await postCaseLog(client, guildConfig, pluginConfig, record, user, client.user, {
      durationLabel: `${Math.round(durationMs / 60_000)}m`,
    }).catch(() => null);
    return;
  }

  if (step.type === "kick") {
    if (member?.kickable) await member.kick(reason).catch(() => null);
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "kick",
      reason,
      active: false,
      metadata,
    });
    await postCaseLog(client, guildConfig, pluginConfig, record, user, client.user).catch(() => null);
    return;
  }

  if (step.type === "softban") {
    const deleteDays = Math.min(7, Math.max(0, pluginConfig.softban_delete_message_days ?? 1));
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await guild.members
        .ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 })
        .catch(() => null);
      await guild.members.unban(user.id, "Auto-escalation softban").catch(() => null);
    }
    const record = await createInfraction({
      guildId: guild.id,
      userId: user.id,
      modId,
      type: "softban",
      reason,
      active: false,
      metadata,
    });
    await postCaseLog(client, guildConfig, pluginConfig, record, user, client.user).catch(() => null);
    return;
  }

  // ban / tempban
  const durationMs =
    step.type === "tempban" ? (step.duration_ms && step.duration_ms > 0 ? step.duration_ms : 86_400_000) : 0;
  if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    await guild.members.ban(user.id, { reason }).catch(() => null);
  }
  const record = await createInfraction({
    guildId: guild.id,
    userId: user.id,
    modId,
    type: step.type,
    reason,
    active: true,
    expiresAt: durationMs > 0 ? new Date(Date.now() + durationMs) : null,
    metadata,
  });
  await postCaseLog(client, guildConfig, pluginConfig, record, user, client.user, {
    durationLabel: durationMs > 0 ? `${Math.round(durationMs / 3_600_000)}h` : null,
  }).catch(() => null);
}
