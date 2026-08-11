import type { GuildMember } from "discord.js";
import type { SlashCommandContext } from "../../../core/types.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { createAliasInteractionProxy } from "./optionsProxy.js";

type StoredOptions = Record<string, unknown>;

export async function runStoredAlias(ctx: SlashCommandContext, commandName: string, storedOptions: StoredOptions): Promise<boolean> {
  const command = getAllSlashCommands().find((cmd) => cmd.data.name === commandName);
  if (!command) return false;

  if (command.plugin !== "config" && !pluginEnabled(ctx.guildConfig, command.plugin)) {
    await ctx.interaction.reply(
      resultReply(
        "Plugin disabled",
        `The **${command.plugin}** plugin is disabled for this server.`,
        ctx.ephemeral,
        slashResultOptions(ctx, { tone: "error" }),
      ),
    );
    return true;
  }

  const proxiedInteraction = createAliasInteractionProxy(ctx.interaction, storedOptions);

  const categoryId =
    ctx.interaction.channel?.isTextBased() && "parentId" in ctx.interaction.channel
      ? ctx.interaction.channel.parentId
      : null;
  const member =
    ctx.interaction.member && typeof ctx.interaction.member !== "string"
      ? (ctx.interaction.member as GuildMember)
      : undefined;
  const defaultOverrides = getPluginDefaultOverrides(command.plugin);
  const pluginConfig = resolvePluginConfig(
    ctx.guildConfig,
    command.plugin,
    defaultOverrides,
    member,
    ctx.interaction.channelId,
    categoryId,
  );

  await command.execute({
    ...ctx,
    interaction: proxiedInteraction,
    pluginConfig,
  });
  // Count the resolved target command (the /alias wrapper is tracked separately).
  const { trackCommandUsage } = await import("../../stats/functions/commandUsage.js");
  trackCommandUsage(ctx.interaction.guildId, commandName);
  return true;
}
