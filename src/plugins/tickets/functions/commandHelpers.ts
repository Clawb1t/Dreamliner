import type { GuildMember } from "discord.js";
import type { SlashCommandContext } from "../../../core/types.js";
import { canUseTickets, getTicketsPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import type { TicketsConfig } from "../../../config/schemas/tickets.js";
import { getTicketByChannel, type TicketRecord } from "./tickets.js";

export async function requireTicketPermission(
  ctx: SlashCommandContext,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: TicketsConfig } | null> {
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
  const pluginConfig = getTicketsPluginConfig(guildConfig, guildMember, interaction.channelId, categoryId) as TicketsConfig;

  if (!canUseTickets(guildConfig, permission, guildMember, interaction.channelId, categoryId)) {
    await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  return { member: guildMember, pluginConfig };
}

/** Resolves the ticket tied to the channel the command was run in, replying with an error if none. */
export async function requireTicketChannel(ctx: SlashCommandContext): Promise<TicketRecord | null> {
  const { interaction, guildConfig } = ctx;
  const ticket = await getTicketByChannel(interaction.guildId!, interaction.channelId!);
  if (!ticket) {
    await interaction.reply(
      resultReply("Not a ticket", "This command can only be used inside a ticket channel.", ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })),
    );
    return null;
  }
  return ticket;
}
