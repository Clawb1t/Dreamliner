import { SlashCommandBuilder } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { configEditorWithSupportRow } from "../../core/docsUrl.js";
import { resultReply, guildResultOptions } from "../../core/responses.js";
import { permissionsCommand } from "./commands/permissions.js";
import { pluginCommand } from "./commands/plugin.js";

export const configPlugin = definePlugin({
  name: "config",
  slashCommands: [
    {
      plugin: "config",
      manageServer: true,
      data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("Open the Dreamliner dashboard to configure this server"),
      execute: async ({ interaction, guildConfig, client, ephemeral }) => {
        const guildId = interaction.guildId!;
        const resultOptions = guildResultOptions(client, guildConfig);

        await interaction.reply(
          resultReply(
            "Dashboard",
            [
              "Dreamliner is configured entirely from the web dashboard now.",
              "",
              "**1.** Open the dashboard and sign in with Discord.",
              "**2.** This server should already be selected.",
              "**3.** Edit plugins and fields (channels/roles/members have search autocomplete).",
              "**4.** Click **Save**. Dreamliner applies the config immediately.",
              "",
              "Stats, leaderboards, tags, welcomer, and the rest of setup live in the same dashboard.",
            ].join("\n"),
            ephemeral,
            { ...resultOptions, emoji: "<:icons_link:1544417328597434500>" },
            [configEditorWithSupportRow(guildId)],
          ),
        );
      },
    },
    permissionsCommand,
    pluginCommand,
  ],
});
