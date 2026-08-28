import type { SlashCommandContext } from "../../../core/types.js";
import { canUseInfractions, getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import type { GuildMember } from "discord.js";
import type { InfractionConfig, ReasonRequirableType } from "../../../config/schemas/infraction.js";

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

/**
 * If the guild requires a reason for this action and none (or a blank string) was given,
 * replies with an error and returns true so the caller can bail out.
 */
export async function replyIfReasonRequired(
  ctx: SlashCommandContext,
  pluginConfig: InfractionConfig,
  type: ReasonRequirableType,
  rawReason: string | null,
  label: string,
): Promise<boolean> {
  if (!pluginConfig.require_reason[type] || rawReason?.trim()) return false;
  await ctx.interaction.reply(
    resultReply(label, "This server requires a reason for this action.", ctx.ephemeral, guildResultOptions(ctx.client, ctx.guildConfig, { tone: "error" })),
  );
  return true;
}
