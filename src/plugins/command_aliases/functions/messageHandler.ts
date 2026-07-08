import type { Message } from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import type { SlashCommandContext } from "../../../core/types.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { commandAliasesDefaultOverrides } from "../defaultOverrides.js";
import { getCommandAlias } from "./store.js";
import { createMessageAliasInteraction } from "./messageInteraction.js";

export async function handleAliasMessage(message: Message, configManager: ConfigManager): Promise<void> {
  if (!message.guild || !message.member || message.author.bot) return;
  if (!message.content.trim() || message.content.includes("\n")) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "command_aliases")) return;

  const aliasConfig = resolvePluginConfig(
    guildConfig,
    "command_aliases",
    commandAliasesDefaultOverrides,
    message.member,
    message.channel.id,
    message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null,
  );

  if (aliasConfig.message_triggers === false) return;

  if (
    !hasPluginPermission(
      guildConfig,
      "command_aliases",
      "can_run",
      message.member,
      message.channel.id,
      message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null,
      commandAliasesDefaultOverrides,
    )
  ) {
    return;
  }

  const alias = await getCommandAlias(message.guild.id, message.content.trim());
  if (!alias) return;

  const command = getAllSlashCommands().find((cmd) => cmd.data.name === alias.command);
  if (!command) return;

  if (command.permission) {
    const allowed = hasPluginPermission(
      guildConfig,
      command.plugin,
      command.permission,
      message.member,
      message.channel.id,
      message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null,
      getPluginDefaultOverrides(command.plugin),
    );
    if (!allowed) return;
  }

  const categoryId =
    message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null;
  const pluginConfig = resolvePluginConfig(
    guildConfig,
    command.plugin,
    getPluginDefaultOverrides(command.plugin),
    message.member,
    message.channel.id,
    categoryId,
  );

  const ctx: SlashCommandContext = {
    interaction: createMessageAliasInteraction(message, alias.command, alias.options),
    guildConfig,
    pluginConfig,
    client: message.client,
    configManager,
    ephemeral: resolveEphemeral(guildConfig),
  };

  await command.execute(ctx).catch((err) => {
    console.error(`Error running alias ${alias.name}:`, err);
  });
}
