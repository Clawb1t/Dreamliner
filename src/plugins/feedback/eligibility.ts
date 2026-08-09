import type { GuildMember } from "discord.js";
import { getGuildMessageCount } from "../utility/functions/messageCounts.js";
import { parseDuration } from "../infraction/functions/duration.js";

export type EligibilityConfig = {
  min_messages?: number;
  min_account_age?: string;
  min_member_age?: string;
  cooldown?: string;
  allowed_roles?: string[];
  blocked_roles?: string[];
  ignored_channels?: string[];
  command_channels?: string[];
};

export type EligibilityResult = { ok: true } | { ok: false; message: string };

function memberHasAnyRole(member: GuildMember, roleIds: string[]): boolean {
  return roleIds.some((id) => member.roles.cache.has(id));
}

function ageOk(createdAtMs: number, minAge: string | undefined, label: string): EligibilityResult {
  if (!minAge?.trim()) return { ok: true };
  const ms = parseDuration(minAge.trim());
  if (ms == null) return { ok: false, message: `Invalid ${label} setting. Ask staff to fix the config.` };
  if (Date.now() - createdAtMs < ms) {
    return { ok: false, message: `Your ${label} must be at least \`${minAge.trim()}\`.` };
  }
  return { ok: true };
}

export async function checkFeedbackEligibility(options: {
  member: GuildMember;
  channelId: string | null;
  config: EligibilityConfig;
  lastActionAt?: Date | null;
}): Promise<EligibilityResult> {
  const { member, channelId, config, lastActionAt } = options;

  if (channelId && config.ignored_channels?.includes(channelId)) {
    return { ok: false, message: "This command cannot be used in this channel." };
  }

  if (channelId && config.command_channels && config.command_channels.length > 0) {
    if (!config.command_channels.includes(channelId)) {
      return { ok: false, message: "This command can only be used in designated channels." };
    }
  }

  if (config.blocked_roles?.length && memberHasAnyRole(member, config.blocked_roles)) {
    return { ok: false, message: "You are not allowed to use this feature." };
  }

  if (config.allowed_roles?.length && !memberHasAnyRole(member, config.allowed_roles)) {
    return { ok: false, message: "You need a required role to use this feature." };
  }

  const accountAge = ageOk(member.user.createdTimestamp, config.min_account_age, "account age");
  if (!accountAge.ok) return accountAge;

  const joinedAt = member.joinedTimestamp ?? Date.now();
  const memberAge = ageOk(joinedAt, config.min_member_age, "server membership");
  if (!memberAge.ok) return memberAge;

  const minMessages = config.min_messages ?? 0;
  if (minMessages > 0) {
    const count = await getGuildMessageCount(member.guild.id, member.id);
    if (count < minMessages) {
      return {
        ok: false,
        message: `You need at least **${minMessages}** messages in this server before using this (you have **${count}**).`,
      };
    }
  }

  if (config.cooldown?.trim() && lastActionAt) {
    const cooldownMs = parseDuration(config.cooldown.trim());
    if (cooldownMs != null) {
      const elapsed = Date.now() - lastActionAt.getTime();
      if (elapsed < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
        return {
          ok: false,
          message: `Please wait another **${remainingSec}s** before trying again.`,
        };
      }
    }
  }

  return { ok: true };
}
