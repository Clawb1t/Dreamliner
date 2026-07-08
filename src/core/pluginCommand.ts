import type { GuildMember } from "discord.js";
import type { SlashCommandContext } from "./types.js";
import { hasPluginPermission } from "./permissions.js";
import { getPluginDefaultOverrides } from "./guildHelpers.js";
import { resultReply, slashResultOptions } from "./responses.js";
import { resolvePluginConfig } from "./permissions.js";

export async function requirePluginPermission(
  ctx: SlashCommandContext,
  pluginName: string,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: Record<string, unknown> } | null> {
  const { interaction, guildConfig, ephemeral } = ctx;
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply("Server only", "This command can only be used in a server.", ephemeral, slashResultOptions(ctx)));
    return null;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(resultReply("Member error", "Could not resolve member.", ephemeral, slashResultOptions(ctx)));
    return null;
  }

  const guildMember = member as GuildMember;
  const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const defaultOverrides = getPluginDefaultOverrides(pluginName);

  if (!hasPluginPermission(guildConfig, pluginName, permission, guildMember, interaction.channelId, categoryId, defaultOverrides)) {
    await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ephemeral, slashResultOptions(ctx, { tone: "error" })));
    return null;
  }

  const pluginConfig = resolvePluginConfig(guildConfig, pluginName, defaultOverrides, guildMember, interaction.channelId, categoryId);
  return { member: guildMember, pluginConfig };
}

export function pluginEnabled(guildConfig: { plugins: Record<string, { enabled?: boolean } | undefined> }, name: string): boolean {
  const section = guildConfig.plugins[name];
  return section?.enabled !== false;
}
