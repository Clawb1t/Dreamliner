import type { GuildMember, Message } from "discord.js";
import { zAutomodConfig, type AutomodConfig } from "../../../config/schemas/plugins.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { checkRateLimit } from "../../../core/rules.js";
import { safeAddRole } from "../../../core/roles.js";
import { getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { buildAutomodLog, buildRaidDetectedLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { automodDefaultOverrides } from "../defaultOverrides.js";

function isIgnored(member: GuildMember | null, config: AutomodConfig, channelId: string): boolean {
  if (config.ignored_channels.includes(channelId)) return true;
  if (!member) return false;
  return config.ignored_roles.some((roleId) => member.roles.cache.has(roleId));
}

function channelRef(message: Message) {
  const name = "name" in message.channel ? (message.channel.name ?? message.channel.id) : message.channel.id;
  return { id: message.channel.id, name };
}

async function logAutomod(message: Message, config: AutomodConfig, reason: string): Promise<void> {
  if (!message.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  await sendModerationLog(
    message.client,
    guildConfig,
    buildAutomodLog({
      user: {
        id: message.author.id,
        name: message.author.username,
        avatarUrl: message.author.displayAvatarURL({ size: 128 }),
      },
      channel: channelRef(message),
      reason,
      action: config.action,
    }),
    { caseLogOverride: config.log_channel_id },
  );
}

async function applyAutomodAction(message: Message, config: AutomodConfig, reason: string): Promise<void> {
  if (config.action === "delete") {
    await message.delete().catch(() => null);
    await logAutomod(message, config, reason);
    return;
  }

  if (config.action === "warn") {
    await message.delete().catch(() => null);
    await message.author.send(`You were flagged by automod in **${message.guild?.name}**: ${reason}`).catch(() => null);
    await logAutomod(message, config, reason);
    return;
  }

  if (config.action === "mute" && message.member && message.guild) {
    await message.delete().catch(() => null);
    const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
    const infractionConfig = getInfractionPluginConfig(guildConfig);
    const muteRoleId = infractionConfig.mute_role as string | undefined;
    if (muteRoleId) {
      await safeAddRole(message.member, muteRoleId, `Automod: ${reason}`);
      if (config.mute_duration_ms > 0) {
        setTimeout(() => {
          message.member?.roles.remove(muteRoleId, "Automod mute expired").catch(() => null);
        }, config.mute_duration_ms);
      }
    }
    await logAutomod(message, config, reason);
  }
}

export async function handleAutomodMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.content) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "automod")) return;

  const member = message.member;
  const config = zAutomodConfig.parse(
    resolvePluginConfig(guildConfig, "automod", automodDefaultOverrides, member ?? undefined, message.channel.id),
  );

  if (isIgnored(member, config, message.channel.id)) return;

  const channelId = message.channel.id;
  const userId = message.author.id;
  const guildId = message.guild.id;
  const normalized = message.content.trim().toLowerCase();

  if (config.enabled_rules.includes("duplicate") && normalized) {
    const dupKey = `${guildId}:${userId}:${channelId}:dup:${normalized}`;
    if (checkRateLimit(dupKey, config.duplicate_max, config.duplicate_window_ms)) {
      await applyAutomodAction(message, config, "Duplicate message spam");
      return;
    }
  }

  if (config.enabled_rules.includes("rate_limit")) {
    const rateKey = `${guildId}:${userId}:${channelId}:rate`;
    if (checkRateLimit(rateKey, config.rate_limit_count, config.rate_limit_window_ms)) {
      await applyAutomodAction(message, config, "Rate limit exceeded");
    }
  }
}

export async function handleAutomodMemberAdd(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "automod")) return;

  const config = zAutomodConfig.parse(resolvePluginConfig(guildConfig, "automod", automodDefaultOverrides));

  const raidKey = `${member.guild.id}:raid`;
  if (!checkRateLimit(raidKey, config.raid_join_count, config.raid_join_window_ms)) return;

  await sendModerationLog(
    member.client,
    guildConfig,
    buildRaidDetectedLog({
      user: {
        id: member.id,
        name: member.user.username,
        avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      },
      joinCount: config.raid_join_count,
      windowMs: config.raid_join_window_ms,
    }),
    { caseLogOverride: config.log_channel_id },
  );
}

export async function testAutomodRules(content: string, config: AutomodConfig): Promise<string[]> {
  const hits: string[] = [];
  const normalized = content.trim().toLowerCase();

  if (config.enabled_rules.includes("duplicate") && normalized) {
    hits.push(`Duplicate rule active (${config.duplicate_max} in ${config.duplicate_window_ms}ms)`);
  }
  if (config.enabled_rules.includes("rate_limit")) {
    hits.push(`Rate limit rule active (${config.rate_limit_count} in ${config.rate_limit_window_ms}ms)`);
  }
  if (!hits.length) hits.push("No automod rules enabled.");
  return hits;
}
