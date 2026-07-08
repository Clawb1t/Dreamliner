import type { GuildMember, TextChannel } from "discord.js";
import { zWelcomeMessageConfig, type WelcomeMessageConfig } from "../../../config/schemas/plugins.js";
import { configManager } from "../../../config/manager.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { renderTemplate } from "../../../core/templates.js";

export async function sendWelcomeMessage(member: GuildMember, config: WelcomeMessageConfig): Promise<void> {
  if (!config.channel_id) return;

  const channel = await member.guild.channels.fetch(config.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  const text = renderTemplate(config.message, { member, guild: member.guild });
  await (channel as TextChannel).send({ content: text }).catch(() => null);
}

export async function handleWelcomeMemberAdd(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "welcome_message")) return;

  const config = zWelcomeMessageConfig.parse(
    resolvePluginConfig(guildConfig, "welcome_message", getPluginDefaultOverrides("welcome_message")),
  );

  if (!config.channel_id) return;
  await sendWelcomeMessage(member, config);
}
