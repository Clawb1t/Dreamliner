import type { SlashCommandContext } from "../../../core/types.js";
import { canUseInfractions, getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import type { GuildMember } from "discord.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";

export async function requireInfractionPermission(
  ctx: SlashCommandContext,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: InfractionConfig } | null> {
  const { interaction, guildConfig } = ctx;
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply("Server only", "This command can only be used in a server.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(resultReply("Member error", "Could not resolve member.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  const guildMember = member as GuildMember;
  const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const pluginConfig = getInfractionPluginConfig(guildConfig, guildMember, interaction.channelId, categoryId) as InfractionConfig;

  if (!canUseInfractions(guildConfig, permission, guildMember, interaction.channelId, categoryId)) {
    await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  return { member: guildMember, pluginConfig };
}
