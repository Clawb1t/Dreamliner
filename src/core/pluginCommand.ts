import type { GuildMember } from "discord.js";
import type { SlashCommandContext } from "./types.js";
import { hasPermission, resolveEffectivePluginConfig } from "./permissionRoles.js";
import { resultReply, slashResultOptions } from "./responses.js";

export async function requirePluginPermission(
  ctx: SlashCommandContext,
  pluginName: string,
  permission: string,
): Promise<{ member: GuildMember; pluginConfig: Record<string, unknown> } | null> {
  const { interaction, guildConfig, ephemeral, t } = ctx;
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(resultReply(t("common.serverOnlyTitle", "Server only"), t("common.serverOnlyBody", "This command can only be used in a server."), ephemeral, slashResultOptions(ctx)));
    return null;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") {
    await interaction.reply(resultReply(t("common.memberErrorTitle", "Member error"), t("common.memberErrorBody", "Could not resolve member."), ephemeral, slashResultOptions(ctx)));
    return null;
  }

  if (!pluginEnabled(guildConfig, pluginName)) {
    await interaction.reply(
      resultReply(
        t("common.pluginDisabledTitle", "Plugin disabled"),
        t("common.pluginDisabledBody", `The **${pluginName}** plugin is disabled for this server.`, { plugin: pluginName }),
        ephemeral,
        slashResultOptions(ctx, { tone: "error" }),
      ),
    );
    return null;
  }

  const guildMember = member as GuildMember;

  if (!(await hasPermission(interaction.guildId, pluginName, permission, guildMember, guildConfig))) {
    await interaction.reply(resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("common.noPermission", "You do not have permission to use this command."), ephemeral, slashResultOptions(ctx, { tone: "error" })));
    return null;
  }

  const pluginConfig = await resolveEffectivePluginConfig(interaction.guildId, pluginName, guildMember, guildConfig);
  return { member: guildMember, pluginConfig };
}

export function pluginEnabled(guildConfig: { plugins: Record<string, { enabled?: boolean } | undefined> }, name: string): boolean {
  const section = guildConfig.plugins[name];
  return section?.enabled !== false;
}
