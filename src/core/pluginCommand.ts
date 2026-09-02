import type { GuildMember } from "discord.js";
import type { SlashCommandContext } from "./types.js";
import { hasPermission, resolveEffectivePluginConfig } from "./permissionRoles.js";
import { resultReply, slashResultOptions } from "./responses.js";

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

  if (!pluginEnabled(guildConfig, pluginName)) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        `The **${pluginName}** plugin is disabled for this server.`,
        ephemeral,
        slashResultOptions(ctx, { tone: "error" }),
      ),
    );
    return null;
  }

  const guildMember = member as GuildMember;

  if (!(await hasPermission(interaction.guildId, pluginName, permission, guildMember, guildConfig))) {
    await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ephemeral, slashResultOptions(ctx, { tone: "error" })));
    return null;
  }

  const pluginConfig = await resolveEffectivePluginConfig(interaction.guildId, pluginName, guildMember, guildConfig);
  return { member: guildMember, pluginConfig };
}

export function pluginEnabled(guildConfig: { plugins: Record<string, { enabled?: boolean } | undefined> }, name: string): boolean {
  const section = guildConfig.plugins[name];
  return section?.enabled !== false;
}
