import type { GuildMember, PartialGuildMember, PartialUser, User } from "discord.js";
import { zImpersonationConfig, type ImpersonationConfig } from "../../../config/schemas/impersonation.js";
import { configManager } from "../../../config/manager.js";
import { buildImpersonationLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { getModerationLogChannelId } from "../../../core/logging/channels.js";
import { hashAvatarUrl } from "./watchlist.js";
import { recordIdentityChange } from "./history.js";
import { buildCandidateFromMember, findImpersonationMatch, isIgnored, isProtectedByRole } from "./detect.js";
import { createAlert, type AlertTrigger } from "./alerts.js";
import { applyAutoAction } from "./actions.js";
import { weightForImpersonationScore } from "../../incident_response/functions/weights.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("impersonation");

function parseImpersonationConfig(raw: unknown): ImpersonationConfig {
  return zImpersonationConfig.parse(raw ?? {});
}

async function loadConfig(guildId: string) {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (guildConfig.plugins.impersonation?.enabled !== true) return null;
  const config = parseImpersonationConfig(guildConfig.plugins.impersonation?.config ?? {});
  return { guildConfig, config };
}

function avatarUrlOf(member: GuildMember): string | null {
  return member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 }) ?? null;
}

/** Shared tail end of every check: on a match, records the alert, logs it, and (if
 * configured) runs the auto action + DMs the member. Skipped entirely for members who are
 * themselves protected (a staff member's avatar happening to resemble another staffer's
 * shouldn't page anyone) or exempt via ignored_roles. */
async function checkAndAlert(
  member: GuildMember,
  trigger: AlertTrigger,
  guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>,
  config: ImpersonationConfig,
): Promise<void> {
  if (member.user.bot) return;
  if (isIgnored(member, config.ignored_roles)) return;
  if (isProtectedByRole(member, config.protected_roles)) return;

  const candidate = await buildCandidateFromMember(member);
  const match = await findImpersonationMatch(member.guild, candidate, config);
  if (!match) return;

  const autoActionLabel = config.auto_action !== "none"
    ? await applyAutoAction({
        client: member.client,
        guild: member.guild,
        guildConfig,
        config,
        member,
        user: member.user,
        match,
      }).catch(() => null)
    : null;

  await createAlert({
    guildId: member.guild.id,
    subjectUserId: member.id,
    subjectUsername: member.user.tag ?? member.user.username,
    subjectAvatarUrl: avatarUrlOf(member),
    matchedUserId: match.protectedIdentity.userId,
    matchedWatchlistId: match.protectedIdentity.watchlistId,
    matchedLabel: match.protectedIdentity.label,
    matchedAvatarUrl: match.protectedIdentity.avatarUrl,
    trigger,
    nameSimilarity: match.nameSimilarity,
    avatarDistance: match.avatarDistance,
    autoAction: autoActionLabel,
  });

  const score = Math.max(match.nameSimilarity ?? 0, match.avatarDistance !== null ? 100 - match.avatarDistance : 0);
  try {
    const { reportSignal } = await import("../../incident_response/functions/signalBus.js");
    await reportSignal(member.client, {
      guildId: member.guild.id,
      source: "impersonation",
      signalType: `impersonation:${trigger}`,
      weight: weightForImpersonationScore(score),
      entityType: "user",
      entityId: member.id,
      entityLabel: `<@${member.id}>`,
      reason: `Looks like "${match.protectedIdentity.label}"`,
      detail: match.nameSimilarity ? `name ${match.nameSimilarity}%` : match.avatarDistance !== null ? `avatar Δ${match.avatarDistance}` : undefined,
    });
  } catch (err) {
    log.error("Incident Response signal report failed:", err);
  }

  if (config.notify_staff) {
    const logChannelId = getModerationLogChannelId(guildConfig, config.log_channel_id);
    await sendModerationLog(
      member.client,
      guildConfig,
      buildImpersonationLog({
        subject: {
          id: member.id,
          name: member.user.username,
          avatarUrl: avatarUrlOf(member) ?? undefined,
          createdAt: member.user.createdTimestamp,
          joinedAt: member.joinedTimestamp,
        },
        matchedLabel: match.protectedIdentity.label,
        matchedUserId: match.protectedIdentity.userId,
        matchedAvatarUrl: match.protectedIdentity.avatarUrl,
        trigger,
        nameSimilarity: match.nameSimilarity,
        avatarDistance: match.avatarDistance,
        autoAction: autoActionLabel,
      }),
      {
        guildId: member.guild.id,
        eventType: "impersonation",
        actorId: member.id,
        targetId: member.id,
        caseLogOverride: logChannelId,
      },
    ).catch(() => null);
  }

  if (config.dm_flagged_member) {
    await member
      .send(
        `Your profile in **${member.guild.name}** was flagged as a possible impersonation match. If this wasn't intentional, consider changing your name or avatar. If you believe this is a mistake, contact server staff.`,
      )
      .catch(() => null);
  }
}

export async function handleImpersonationMemberAdd(member: GuildMember): Promise<void> {
  const loaded = await loadConfig(member.guild.id);
  if (!loaded) return;
  const { guildConfig, config } = loaded;

  await recordIdentityChange({
    guildId: member.guild.id,
    userId: member.id,
    field: "joined",
    newValue: member.user.username,
  });

  if (!config.check_on_join) return;
  await checkAndAlert(member, "join", guildConfig, config);
}

export async function handleImpersonationMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  const loaded = await loadConfig(newMember.guild.id);
  if (!loaded) return;
  const { guildConfig, config } = loaded;

  const oldNickname = oldMember.nickname ?? null;
  const newNickname = newMember.nickname ?? null;
  const nicknameChanged = oldNickname !== newNickname;
  if (nicknameChanged) {
    await recordIdentityChange({
      guildId: newMember.guild.id,
      userId: newMember.id,
      field: "nickname",
      oldValue: oldNickname,
      newValue: newNickname,
    });
  }

  const oldAvatar = oldMember.avatar ?? null;
  const newAvatar = newMember.avatar ?? null;
  const guildAvatarChanged = oldAvatar !== newAvatar;
  if (guildAvatarChanged) {
    const oldUrl = oldMember.avatarURL?.({ size: 128 }) ?? null;
    const newUrl = newMember.avatarURL({ size: 128 });
    await recordIdentityChange({
      guildId: newMember.guild.id,
      userId: newMember.id,
      field: "avatar",
      oldValue: oldUrl ? await hashAvatarUrl(oldUrl) : null,
      newValue: newUrl ? await hashAvatarUrl(newUrl) : null,
    });
  }

  const trigger: AlertTrigger | null = guildAvatarChanged && config.check_avatar
    ? "avatar"
    : nicknameChanged && config.check_nickname
      ? "nickname"
      : null;
  if (!trigger) return;
  await checkAndAlert(newMember, trigger, guildConfig, config);
}

export async function handleImpersonationUserUpdate(
  oldUser: User | PartialUser,
  newUser: User,
): Promise<void> {
  const usernameChanged = oldUser.username !== newUser.username;
  const displayNameChanged = (oldUser.globalName ?? null) !== (newUser.globalName ?? null);
  const oldAvatar = oldUser.avatar ?? null;
  const newAvatar = newUser.avatar ?? null;
  const avatarChanged = oldAvatar !== newAvatar;
  if (!usernameChanged && !displayNameChanged && !avatarChanged) return;

  // A username/global-avatar change is guild-agnostic — re-check it against every mutual
  // guild that has the plugin enabled (this is why it's keyed off Client.guilds, not one guild).
  for (const guild of newUser.client.guilds.cache.values()) {
    const member = guild.members.cache.get(newUser.id);
    if (!member) continue;

    const loaded = await loadConfig(guild.id);
    if (!loaded) continue;
    const { guildConfig, config } = loaded;

    if (usernameChanged) {
      await recordIdentityChange({
        guildId: guild.id,
        userId: newUser.id,
        field: "username",
        oldValue: oldUser.username,
        newValue: newUser.username,
      });
    }
    if (displayNameChanged) {
      await recordIdentityChange({
        guildId: guild.id,
        userId: newUser.id,
        field: "display_name",
        oldValue: oldUser.globalName ?? null,
        newValue: newUser.globalName ?? null,
      });
    }
    if (avatarChanged) {
      const oldUrl = "avatarURL" in oldUser ? oldUser.avatarURL({ size: 128 }) : null;
      const newUrl = newUser.avatarURL({ size: 128 });
      await recordIdentityChange({
        guildId: guild.id,
        userId: newUser.id,
        field: "avatar",
        oldValue: oldUrl ? await hashAvatarUrl(oldUrl) : null,
        newValue: newUrl ? await hashAvatarUrl(newUrl) : null,
      });
    }

    const trigger: AlertTrigger | null = avatarChanged && config.check_avatar
      ? "avatar"
      : usernameChanged && config.check_username
        ? "username"
        : displayNameChanged && config.check_display_name
          ? "display_name"
          : null;
    if (!trigger) continue;
    await checkAndAlert(member, trigger, guildConfig, config);
  }
}

export { parseImpersonationConfig };
