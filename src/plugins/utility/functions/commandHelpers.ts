import type { GuildConfig } from "../../../config/schemas/guild.js";
import { PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { canUseUtility, getUtilityPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import type { SlashCommandContext } from "../../../core/types.js";

export async function requireUtilityPermission(
  ctx: SlashCommandContext,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: Record<string, unknown> } | null> {
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
  const pluginConfig = getUtilityPluginConfig(guildConfig, guildMember, interaction.channelId, categoryId);

  if (!canUseUtility(guildConfig, permission, guildMember, interaction.channelId, categoryId)) {
    await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  return { member: guildMember, pluginConfig };
}

export async function requireDiscordPerm(
  interaction: ChatInputCommandInteraction,
  perm: bigint,
  label: string,
  ephemeral = false,
  guildConfig?: GuildConfig,
): Promise<boolean> {
  const member = interaction.member;
  if (!member || typeof member === "string" || !("permissions" in member)) return false;
  if (!(member as GuildMember).permissions.has(perm)) {
    const options = guildConfig
      ? guildResultOptions(interaction.client, guildConfig, { tone: "error" })
      : { client: interaction.client, tone: "error" as const };
    await interaction.reply(resultReply("Missing permission", `You need the **${label}** permission.`, ephemeral, options));
    return false;
  }
  return true;
}

export const ManageMessages = PermissionFlagsBits.ManageMessages;
export const BanMembers = PermissionFlagsBits.BanMembers;
export const KickMembers = PermissionFlagsBits.KickMembers;
export const MoveMembers = PermissionFlagsBits.MoveMembers;
export const ManageNicknames = PermissionFlagsBits.ManageNicknames;
