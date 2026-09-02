import {
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type User,
} from "discord.js";
import type { AutomodConfig, AutomodLadderAction, AutomodRuleConfig } from "../../../config/schemas/automod.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { buildAutomodLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import {
  applyTimeout,
  clampTimeoutMs,
  createInfraction,
  DISCORD_TIMEOUT_MAX_MS,
  postCaseLog,
} from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";
import type { AutomodHit } from "./detectors/types.js";

function channelRef(message: Message) {
  const name = "name" in message.channel ? (message.channel.name ?? message.channel.id) : message.channel.id;
  return { id: message.channel.id, name };
}

function pickLadderActions(rule: AutomodRuleConfig, score: number): AutomodLadderAction[] {
  const sorted = [...rule.ladder].sort((a, b) => a.after - b.after);
  let chosen: AutomodLadderAction[] = [];
  for (const step of sorted) {
    if (score >= step.after) chosen = step.actions;
  }
  return chosen;
}

function shouldNotify(rule: AutomodRuleConfig, action: AutomodLadderAction, config: AutomodConfig): boolean {
  if (typeof action.notify === "boolean") return action.notify;
  if (action.type === "warn") return rule.notify || config.dm_users;
  return rule.notify;
}

async function softbanUser(options: {
  client: Client;
  guild: import("discord.js").Guild;
  user: User;
  reason: string;
  deleteDays: number;
}): Promise<boolean> {
  const me = options.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) return false;
  try {
    await options.guild.members.ban(options.user.id, {
      reason: options.reason,
      deleteMessageSeconds: Math.min(7, Math.max(0, options.deleteDays)) * 86400,
    });
    await options.guild.members.unban(options.user.id, "Automod softban");
    return true;
  } catch {
    return false;
  }
}

export async function applyAutomodHit(options: {
  client: Client;
  guildConfig: GuildConfig;
  config: AutomodConfig;
  hit: AutomodHit;
  hitCount: number;
  rule: AutomodRuleConfig;
  message?: Message | null;
  member?: GuildMember | null;
  user: User;
  guildId: string;
}): Promise<void> {
  const { client, guildConfig, config, hit, hitCount, rule, message, user, guildId } = options;
  const member = options.member ?? message?.member ?? null;
  const guild = message?.guild ?? member?.guild ?? null;
  if (!guild) return;

  const pointsPerHit = Math.max(1, rule.points ?? 1);
  const score = hitCount * pointsPerHit;
  const reason = formatReason(
    rule.case_reason?.trim() ||
      `${hit.reason}${hit.detail ? ` (${hit.detail})` : ""} · rule \`${hit.ruleId}\` · ${score} pt${score === 1 ? "" : "s"}`,
  );
  const ladderActions = pickLadderActions(rule, score);
  const shouldDelete =
    Boolean(message) &&
    (rule.delete_message || ladderActions.some((a) => a.type === "delete"));

  if (shouldDelete && message?.deletable) {
    await message.delete().catch(() => null);
  }

  const infractionConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
  const modId = client.user!.id;
  const actionLabels: string[] = [];

  for (const action of ladderActions) {
    if (action.type === "delete" || action.type === "none") {
      if (action.type === "none") actionLabels.push("log");
      continue;
    }

    const actionReason = formatReason(action.reason ?? reason);
    const casePoints = action.points ?? pointsPerHit;
    const metadata = {
      source: "automod",
      ruleId: hit.ruleId,
      hitCount,
      points: casePoints,
      score,
    };
    const notify = shouldNotify(rule, action, config);

    if (action.type === "note") {
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: "note",
        reason: actionReason,
        active: false,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
      actionLabels.push(`note #${record.id}`);
      continue;
    }

    if (action.type === "warn") {
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: "warn",
        reason: actionReason,
        active: true,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
      if (notify) {
        await user
          .send(`You were warned by Automod in **${guild.name}**: ${actionReason}`)
          .catch(() => null);
      }
      actionLabels.push(`warn #${record.id}`);
      continue;
    }

    if (action.type === "mute") {
      const durationMs = clampTimeoutMs(action.duration_ms && action.duration_ms > 0 ? action.duration_ms : 600_000);
      if (member && durationMs <= DISCORD_TIMEOUT_MAX_MS) {
        await applyTimeout(member, durationMs, actionReason).catch(() => null);
      }
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: durationMs > 0 ? "tempmute" : "mute",
        reason: actionReason,
        active: true,
        expiresAt: durationMs > 0 ? new Date(Date.now() + durationMs) : null,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user, {
        durationLabel: `${Math.round(durationMs / 60_000)}m`,
      }).catch(() => null);
      if (notify) {
        await user
          .send(`You were timed out by Automod in **${guild.name}**: ${actionReason}`)
          .catch(() => null);
      }
      actionLabels.push(`mute #${record.id}`);
      continue;
    }

    if (action.type === "kick") {
      if (member?.kickable) await member.kick(actionReason).catch(() => null);
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: "kick",
        reason: actionReason,
        active: false,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
      if (notify) {
        await user
          .send(`You were kicked by Automod from **${guild.name}**: ${actionReason}`)
          .catch(() => null);
      }
      actionLabels.push(`kick #${record.id}`);
      continue;
    }

    if (action.type === "softban") {
      const deleteDays = Math.min(
        7,
        Math.max(0, action.delete_message_days ?? infractionConfig.softban_delete_message_days ?? 1),
      );
      await softbanUser({ client, guild, user, reason: actionReason, deleteDays });
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: "softban",
        reason: actionReason,
        active: false,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
      actionLabels.push(`softban #${record.id}`);
      continue;
    }

    if (action.type === "ban" || action.type === "tempban") {
      const durationMs =
        action.type === "tempban"
          ? action.duration_ms && action.duration_ms > 0
            ? action.duration_ms
            : 86_400_000
          : 0;
      const deleteDays = Math.min(7, Math.max(0, action.delete_message_days ?? 0));
      if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        await guild.members
          .ban(user.id, {
            reason: actionReason,
            deleteMessageSeconds: deleteDays > 0 ? deleteDays * 86400 : undefined,
          })
          .catch(() => null);
      }
      const record = await createInfraction({
        guildId,
        userId: user.id,
        modId,
        type: action.type === "tempban" ? "tempban" : "ban",
        reason: actionReason,
        active: true,
        expiresAt: durationMs > 0 ? new Date(Date.now() + durationMs) : null,
        metadata,
      });
      await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user, {
        durationLabel: durationMs > 0 ? `${Math.round(durationMs / 3_600_000)}h` : null,
      }).catch(() => null);
      actionLabels.push(`${action.type} #${record.id}`);
    }
  }

  const actionSummary = actionLabels.length ? actionLabels.join(", ") : shouldDelete ? "delete" : "log";
  await sendModerationLog(
    client,
    guildConfig,
    buildAutomodLog({
      user: {
        id: user.id,
        name: user.username,
        avatarUrl: user.displayAvatarURL({ size: 128 }),
      },
      channel: message ? channelRef(message) : { id: guild.id, name: guild.name },
      reason: `${reason} → ${actionSummary}`,
      action: actionSummary,
    }),
    {
      guildId,
      eventType: "automod",
      actorId: user.id,
      targetId: user.id,
      channelId: message?.channel.id,
      messageId: message?.id,
      caseLogOverride: config.log_channel_id,
    },
  );
}
