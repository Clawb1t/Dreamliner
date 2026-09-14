import { AuditLogEvent, PermissionFlagsBits, type Guild, type GuildAuditLogsEntry } from "discord.js";
import { checkRateLimit } from "../../../core/rules.js";
import { configManager } from "../../../config/manager.js";
import type { IncidentResponseConfig } from "../../../config/schemas/incidentResponse.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { NUKE_SIGNAL_WEIGHTS, type NukeSignalType } from "./weights.js";
import { reportSignal } from "./signalBus.js";
import type { Client } from "discord.js";

type BurstRule = {
  action: AuditLogEvent;
  signalType: NukeSignalType;
  countKey: keyof IncidentResponseConfig["nuke"];
  windowKey: keyof IncidentResponseConfig["nuke"];
  label: string;
  /** What `entry.targetId` actually points at for this audit log action, if useful for the
   * graph. `null` when the target isn't worth carrying as a secondary entity (e.g. a role id,
   * which isn't one of our entity types). */
  secondaryEntityType: "channel" | "user" | null;
};

const BURST_RULES: BurstRule[] = [
  {
    action: AuditLogEvent.ChannelDelete,
    signalType: "mass_channel_delete",
    countKey: "channel_delete_count",
    windowKey: "channel_delete_window_ms",
    label: "channel deletions",
    secondaryEntityType: "channel",
  },
  {
    action: AuditLogEvent.RoleDelete,
    signalType: "mass_role_delete",
    countKey: "role_delete_count",
    windowKey: "role_delete_window_ms",
    label: "role deletions",
    secondaryEntityType: null,
  },
  {
    action: AuditLogEvent.MemberBanAdd,
    signalType: "mass_ban",
    countKey: "ban_count",
    windowKey: "ban_window_ms",
    label: "bans",
    secondaryEntityType: "user",
  },
  {
    action: AuditLogEvent.MemberKick,
    signalType: "mass_kick",
    countKey: "kick_count",
    windowKey: "kick_window_ms",
    label: "kicks",
    secondaryEntityType: "user",
  },
  {
    action: AuditLogEvent.WebhookCreate,
    signalType: "webhook_burst",
    countKey: "webhook_count",
    windowKey: "webhook_window_ms",
    label: "webhook creations",
    secondaryEntityType: "channel",
  },
];

async function checkAdminGrant(
  client: Client,
  guild: Guild,
  entry: GuildAuditLogsEntry,
  nuke: IncidentResponseConfig["nuke"],
): Promise<void> {
  if (nuke.admin_grant_new_account_hours <= 0) return;
  const targetId = entry.targetId;
  const executorId = entry.executorId;
  if (!targetId || !executorId) return;

  const addedRoleIds = entry.changes
    .filter((c) => c.key === "$add" && Array.isArray(c.new))
    .flatMap((c) => (c.new as { id: string }[]).map((r) => r.id));
  const grantsAdmin = addedRoleIds.some((id) => guild.roles.cache.get(id)?.permissions.has(PermissionFlagsBits.Administrator));
  if (!grantsAdmin) return;

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return;
  const ageHours = (Date.now() - member.user.createdTimestamp) / 3_600_000;
  if (ageHours > nuke.admin_grant_new_account_hours) return;

  await reportSignal(client, {
    guildId: guild.id,
    source: "nuke_detection",
    signalType: "admin_grant_new_account",
    weight: NUKE_SIGNAL_WEIGHTS.admin_grant_new_account,
    entityType: "user",
    entityId: executorId,
    entityLabel: `<@${executorId}>`,
    secondaryEntityType: "user",
    secondaryEntityId: targetId,
    reason: `Granted Administrator to a ${Math.round(ageHours)}h-old account`,
    detail: `<@${targetId}>`,
  }).catch(() => null);
}

/**
 * Server-nuke detection: watches the audit log for bursts of destructive actions by the same
 * executor (mass channel/role deletion, mass ban/kick, webhook-creation bursts — a common
 * raid-bot/compromised-webhook technique) plus a one-shot "Administrator handed to a
 * brand-new account" check. Nothing in the codebase listened to `GuildAuditLogEntryCreate`
 * before this. Entity is always the executor — the account whose behavior needs watching.
 */
export async function handleAuditLogEntry(client: Client, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (guildConfig.plugins.incident_response?.enabled !== true) return;
  const config = getPluginSettings(guildConfig, "incident_response") as IncidentResponseConfig;
  if (!config.sources.nuke_detection) return;

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    await checkAdminGrant(client, guild, entry, config.nuke);
    return;
  }

  const rule = BURST_RULES.find((r) => r.action === entry.action);
  if (!rule || !entry.executorId) return;

  const count = config.nuke[rule.countKey] as number;
  const windowMs = config.nuke[rule.windowKey] as number;
  const key = `${guild.id}:${entry.executorId}:nuke:${rule.signalType}`;
  if (!checkRateLimit(key, count, windowMs)) return;

  await reportSignal(client, {
    guildId: guild.id,
    source: "nuke_detection",
    signalType: rule.signalType,
    weight: NUKE_SIGNAL_WEIGHTS[rule.signalType],
    entityType: "user",
    entityId: entry.executorId,
    entityLabel: `<@${entry.executorId}>`,
    secondaryEntityType: rule.secondaryEntityType && entry.targetId ? rule.secondaryEntityType : undefined,
    secondaryEntityId: rule.secondaryEntityType && entry.targetId ? entry.targetId : undefined,
    reason: `${count}+ ${rule.label} / ${Math.round(windowMs / 1000)}s`,
  }).catch(() => null);
}
