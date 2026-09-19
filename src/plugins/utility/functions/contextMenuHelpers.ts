import type { ActionRowBuilder, MessageActionRowComponentBuilder } from "discord.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import type { ContextMenuCommandContext } from "../../../core/types.js";

export async function replyContextMenuError(
  ctx: ContextMenuCommandContext,
  title: string,
  details?: string,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): Promise<void> {
  const { interaction, guildConfig, client } = ctx;
  const options = guildResultOptions(client, guildConfig, { tone: "error" });

  if (interaction.deferred || interaction.replied) {
    await interaction.deleteReply().catch(() => null);
    await interaction.followUp(resultReply(title, details, true, options, components));
    return;
  }

  await interaction.reply(resultReply(title, details, true, options, components));
}

export async function replyContextMenuPermissionDenied(ctx: ContextMenuCommandContext): Promise<void> {
  await ctx.interaction.reply(
    resultReply(
      ctx.t("utility.contextMenuHelpers.permissionDeniedTitle", "Permission denied"),
      ctx.t("utility.contextMenuHelpers.permissionDeniedDesc", "You do not have permission to use this command."),
      true,
      guildResultOptions(ctx.client, ctx.guildConfig, { tone: "error" }),
    ),
  );
}
