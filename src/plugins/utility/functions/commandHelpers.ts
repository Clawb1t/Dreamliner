import type { GuildConfig } from "../../../config/schemas/guild.js";
import { PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { canUseUtility, getUtilityPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions, replyOrEdit } from "../../../core/responses.js";
import type { SlashCommandContext } from "../../../core/types.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

export async function requireUtilityPermission(
  ctx: SlashCommandContext,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: Record<string, unknown> } | null> {
  const { interaction, guildConfig, t } = ctx;
  if (!interaction.inGuild() || !interaction.guild) {
    await replyOrEdit(interaction, resultReply(t("utility.commandHelpers.serverOnlyTitle", "Server only"), t("utility.commandHelpers.serverOnlyDesc", "This command can only be used in a server."), ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await replyOrEdit(interaction, resultReply(t("utility.commandHelpers.memberErrorTitle", "Member error"), t("utility.commandHelpers.memberErrorDesc", "Could not resolve member."), ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  const guildMember = member as GuildMember;

  if (!(await canUseUtility(interaction.guildId, guildConfig, permission, guildMember))) {
    await replyOrEdit(interaction, resultReply(t("utility.commandHelpers.permissionDeniedTitle", "Permission denied"), t("utility.commandHelpers.permissionDeniedDesc", "You do not have permission to use this command."), ctx.ephemeral, guildResultOptions(ctx.client, guildConfig, { tone: "error" })));
    return null;
  }

  const pluginConfig = await getUtilityPluginConfig(interaction.guildId, guildConfig, guildMember);

  return { member: guildMember, pluginConfig };
}

export async function requireDiscordPerm(
  interaction: ChatInputCommandInteraction,
  perm: bigint,
  label: string,
  ephemeral = false,
  guildConfig: GuildConfig | undefined,
  t: Translator = defaultTranslator,
): Promise<boolean> {
  const member = interaction.member;
  if (!member || typeof member === "string" || !("permissions" in member)) return false;
  if (!(member as GuildMember).permissions.has(perm)) {
    const options = guildConfig
      ? guildResultOptions(interaction.client, guildConfig, { tone: "error" })
      : { client: interaction.client, tone: "error" as const };
    await replyOrEdit(interaction, resultReply(t("utility.commandHelpers.missingPermissionTitle", "Missing permission"), t("utility.commandHelpers.missingPermissionDesc", "You need the **{label}** permission.", { label }), ephemeral, options));
    return false;
  }
  return true;
}

export const ManageMessages = PermissionFlagsBits.ManageMessages;
export const BanMembers = PermissionFlagsBits.BanMembers;
export const KickMembers = PermissionFlagsBits.KickMembers;
export const MoveMembers = PermissionFlagsBits.MoveMembers;
export const ManageNicknames = PermissionFlagsBits.ManageNicknames;
export const ManageGuildExpressions = PermissionFlagsBits.ManageGuildExpressions;
