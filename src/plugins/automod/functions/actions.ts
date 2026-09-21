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
import { getLogger } from "../../../core/logger.js";
import {
  applyTimeout,
  clampTimeoutMs,
  createInfraction,
  DISCORD_TIMEOUT_MAX_MS,
  postCaseLog,
} from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";
import type { AutomodHit } from "./detectors/types.js";
import { translatorFor } from "../../../i18n/index.js";

const log = getLogger("automod");

/** Real (non-note) infraction types that count as moderation history for the escalation bridge. */
const REAL_INFRACTION_TYPES = ["warn", "mute", "tempmute", "kick", "softban", "tempban", "ban"] as const;

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
  let score = hitCount * pointsPerHit;

  if (member) {
    try {
      const { getPassportDeescalationFactor } = await import("../../passport/functions/gate.js");
      score = Math.round(score * (await getPassportDeescalationFactor(member)));
    } catch {
      // Passport unavailable or errored, keep the unadjusted score.
    }
  }

  if (member && config.escalation_bridge.use_infraction_history) {
    try {
      const { countQualifyingInfractions } = await import("../../infraction/functions/escalation.js");
      const priorCount = await countQualifyingInfractions(
        guildId,
        user.id,
        REAL_INFRACTION_TYPES,
        config.escalation_bridge.lookback_ms,
      );
      score += Math.round(priorCount * config.escalation_bridge.points_per_infraction);
    } catch (err) {
      log.error("Escalation bridge lookup error:", err);
    }
  }

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
  const { t } = await translatorFor(user.id);
  const createdTypes: string[] = [];
  let hadRealCase = false;
  const hadSilentLadderAction = ladderActions.some((a) => a.type === "delete" || a.type === "none");

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
      hadRealCase = true;
      createdTypes.push(record.type);
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
          .send(
            t("automod.dmWarn", "You were warned by Automod in **{guild}**: {reason}", {
              guild: guild.name,
              reason: actionReason,
            }),
          )
          .catch(() => null);
      }
      hadRealCase = true;
      createdTypes.push(record.type);
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
          .send(
            t("automod.dmMute", "You were timed out by Automod in **{guild}**: {reason}", {
              guild: guild.name,
              reason: actionReason,
            }),
          )
          .catch(() => null);
      }
      hadRealCase = true;
      createdTypes.push(record.type);
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
          .send(
            t("automod.dmKick", "You were kicked by Automod from **{guild}**: {reason}", {
              guild: guild.name,
              reason: actionReason,
            }),
          )
          .catch(() => null);
      }
      hadRealCase = true;
      createdTypes.push(record.type);
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
      hadRealCase = true;
      createdTypes.push(record.type);
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
      hadRealCase = true;
      createdTypes.push(record.type);
      actionLabels.push(`${action.type} #${record.id}`);
    }
  }

  if (rule.log_silent_hits_as_cases && hadSilentLadderAction && !hadRealCase) {
    const silentMetadata = { source: "automod", ruleId: hit.ruleId, hitCount, points: pointsPerHit, score, silent: true };
    const record = await createInfraction({
      guildId,
      userId: user.id,
      modId,
      type: "note",
      reason: formatReason(rule.case_reason?.trim() || `${reason} (automod log-only hit)`),
      active: false,
      metadata: silentMetadata,
    });
    await postCaseLog(client, guildConfig, infractionConfig, record, user, client.user).catch(() => null);
    createdTypes.push(record.type);
    actionLabels.push(`note #${record.id}`);
  }

  if (config.escalation_bridge.feed_real_escalation) {
    for (const triggeringType of createdTypes) {
      try {
        const { maybeEscalate } = await import("../../infraction/functions/escalation.js");
        await maybeEscalate({ client, guild, guildConfig, pluginConfig: infractionConfig, user, triggeringType }).catch(
          (err) => log.error("Escalation error:", err),
        );
      } catch (err) {
        log.error("Escalation bridge import error:", err);
      }
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
