import type { SlashCommandContext } from "../../../core/types.js";
import { canUseInfractions, getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { resultReply, guildResultOptions, replyOrEdit } from "../../../core/responses.js";
import type { GuildMember } from "discord.js";
import type { InfractionConfig, ReasonRequirableType } from "../../../config/schemas/infraction.js";

export async function requireInfractionPermission(
  ctx: SlashCommandContext,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: InfractionConfig } | null> {
  const { interaction, guildConfig, t } = ctx;
  if (!interaction.inGuild() || !interaction.guild) {
    await replyOrEdit(
      interaction,
      resultReply(
        t("infraction.serverOnlyTitle", "Server only"),
        t("infraction.serverOnlyBody", "This command can only be used in a server."),
        ctx.ephemeral,
        guildResultOptions(ctx.client, guildConfig, { tone: "error" }),
      ),
    );
    return null;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await replyOrEdit(
      interaction,
      resultReply(
        t("infraction.memberErrorTitle", "Member error"),
        t("infraction.couldNotResolveMember", "Could not resolve member."),
        ctx.ephemeral,
        guildResultOptions(ctx.client, guildConfig, { tone: "error" }),
      ),
    );
    return null;
  }

  const guildMember = member as GuildMember;

  if (!(await canUseInfractions(interaction.guildId, guildConfig, permission, guildMember))) {
    await replyOrEdit(
      interaction,
      resultReply(
        t("infraction.permissionDeniedTitle", "Permission denied"),
        t("infraction.permissionDeniedBody", "You do not have permission to use this command."),
        ctx.ephemeral,
        guildResultOptions(ctx.client, guildConfig, { tone: "error" }),
      ),
    );
    return null;
  }

  const pluginConfig = (await getInfractionPluginConfig(interaction.guildId, guildConfig, guildMember)) as InfractionConfig;

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
  await replyOrEdit(
    ctx.interaction,
    resultReply(
      label,
      ctx.t("infraction.reasonRequired", "This server requires a reason for this action."),
      ctx.ephemeral,
      guildResultOptions(ctx.client, ctx.guildConfig, { tone: "error" }),
    ),
  );
  return true;
}
