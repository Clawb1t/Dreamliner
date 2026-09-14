import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { IncidentAction, IncidentSeverityPolicy } from "../../../config/schemas/incidentResponse.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import {
  applyTimeout,
  clampTimeoutMs,
  createInfraction,
  postCaseLog,
} from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";
import { lockChannel, lockdownServer } from "./lockdown.js";
import type { IncidentRow } from "./store.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("incident_response");

/**
 * The Response Policy Engine: runs every configured action for the severity tier an incident
 * just reached, once. Punitive actions only apply when the incident's entity is a user (a
 * "guild"-scoped raid incident has no single account to punish — lockdown-only tiers still work
 * for those). Every action is best-effort: one failure never blocks the rest.
 */
export async function applyPolicyForSeverity(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  incident: IncidentRow;
  policy: IncidentSeverityPolicy;
  triggerChannelId?: string | null;
}): Promise<string[]> {
  const { client, guild, guildConfig, incident, policy, triggerChannelId } = options;
  const actionsTaken: string[] = [];

  for (const action of policy.actions) {
    try {
      const label = await runAction(client, guild, guildConfig, incident, action, triggerChannelId);
      if (label) actionsTaken.push(label);
    } catch (err) {
      log.error(`[incident_response] action "${action.type}" failed for incident #${incident.id}:`, err);
    }
  }

  return actionsTaken;
}

async function runAction(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  incident: IncidentRow,
  action: IncidentAction,
  triggerChannelId?: string | null,
): Promise<string | null> {
  if (action.type === "lockdown_channel") {
    const channelId = triggerChannelId ?? (incident.entityType === "channel" ? incident.entityId : null);
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased() || channel.isThread()) return null;
    const id = await lockChannel(channel, {
      incidentId: incident.id,
      lockedBy: client.user!.id,
      unlockAfterMs: action.lockdown_duration_ms,
    });
    return id ? `locked #${channel.name ?? channelId}` : null;
  }

  if (action.type === "lockdown_server") {
    const count = await lockdownServer(guild, {
      incidentId: incident.id,
      lockedBy: client.user!.id,
      unlockAfterMs: action.lockdown_duration_ms,
    });
    return count > 0 ? `server lockdown (${count} channels)` : null;
  }

  // Everything else is a punitive action against the incident's user — skip for
  // guild/channel-scoped incidents (a raid burst or a nuke against a channel has no single
  // account attached unless the incident's entity itself is a user).
  if (incident.entityType !== "user") return null;
  const userId = incident.entityId;

  const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
  const modId = client.user!.id;
  const reason = formatReason(`Incident Response: ${incident.title} (incident #${incident.id}, risk ${incident.riskScore})`);
  const metadata = { source: "incident_response", incidentId: incident.id, severity: incident.severity };
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => null));
  if (!user) return null;

  if (action.type === "timeout") {
    const durationMs = clampTimeoutMs(action.duration_ms && action.duration_ms > 0 ? action.duration_ms : 3_600_000);
    if (member) await applyTimeout(member, durationMs, reason).catch(() => null);
    const record = await createInfraction({
      guildId: guild.id,
      userId,
      modId,
      type: "tempmute",
      reason,
      active: true,
      expiresAt: new Date(Date.now() + durationMs),
      metadata,
    });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user, {
      durationLabel: `${Math.round(durationMs / 60_000)}m`,
    }).catch(() => null);
    return `timeout #${record.id}`;
  }

  if (action.type === "kick") {
    if (member?.kickable) await member.kick(reason).catch(() => null);
    const record = await createInfraction({ guildId: guild.id, userId, modId, type: "kick", reason, active: false, metadata });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    return `kick #${record.id}`;
  }

  if (action.type === "softban") {
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      const deleteSeconds = (action.delete_message_days ?? 1) * 86_400;
      await guild.members.ban(userId, { reason, deleteMessageSeconds: deleteSeconds }).catch(() => null);
      await guild.members.unban(userId, "Incident Response softban").catch(() => null);
    }
    const record = await createInfraction({ guildId: guild.id, userId, modId, type: "softban", reason, active: false, metadata });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    return `softban #${record.id}`;
  }

  if (action.type === "ban") {
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      const deleteSeconds = (action.delete_message_days ?? 0) * 86_400;
      await guild.members.ban(userId, { reason, deleteMessageSeconds: deleteSeconds }).catch(() => null);
    }
    const record = await createInfraction({ guildId: guild.id, userId, modId, type: "ban", reason, active: true, metadata });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    return `ban #${record.id}`;
  }

  return null;
}
