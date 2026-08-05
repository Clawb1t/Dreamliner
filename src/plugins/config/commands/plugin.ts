import { SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { buildPluginListMessage } from "../pluginList.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import {
  autocompleteToggleablePlugins,
  formatPluginLabel,
  isToggleablePlugin,
} from "../toggleablePlugins.js";

export async function handlePluginAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "plugin") return;

  const matches = autocompleteToggleablePlugins(String(focused.value ?? ""));
  await interaction.respond(matches);
}

export const pluginCommand: SlashCommandDefinition = {
  plugin: "config",
  manageServer: true,
  data: new SlashCommandBuilder()
    .setName("plugin")
    .setDescription("Enable or disable Dreamliner plugins")
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Enable or disable a plugin for this server")
        .addStringOption((o) =>
          o.setName("plugin").setDescription("Plugin to toggle").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((o) =>
          o
            .setName("state")
            .setDescription("Turn the plugin on or off")
            .setRequired(true)
            .addChoices(
              { name: "Enable", value: "enable" },
              { name: "Disable", value: "disable" },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List plugin enabled/disabled status")),
  execute: async (ctx) => {
    const sub = ctx.interaction.options.getSubcommand();
    const guildId = ctx.interaction.guildId!;
    const opts = slashResultOptions(ctx);

    if (sub === "list") {
      await ctx.interaction.reply(buildPluginListMessage(0, ctx.guildConfig, ctx.client, ctx.ephemeral));
      return;
    }

    if (sub === "toggle") {
      const pluginName = ctx.interaction.options.getString("plugin", true).trim().toLowerCase();
      const state = ctx.interaction.options.getString("state", true);
      const enable = state === "enable";

      if (!isToggleablePlugin(pluginName)) {
        await ctx.interaction.reply(
          resultReply(
            "Unknown plugin",
            `**\`${pluginName}\`** is not a configurable plugin. Use \`/plugin list\` or pick one from autocomplete.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const currentlyEnabled = pluginEnabled(ctx.guildConfig, pluginName);
      if (enable === currentlyEnabled) {
        await ctx.interaction.reply(
          resultReply(
            "Plugin unchanged",
            `**${formatPluginLabel(pluginName)}** is already **${enable ? "enabled" : "disabled"}**.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const result = await ctx.configManager.setPluginEnabled(guildId, pluginName, enable, ctx.interaction.user.id);
      if (!result.success) {
        await ctx.interaction.reply(
          resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const label = formatPluginLabel(pluginName);
      const details = enable
        ? `**${label}** is now **enabled**. Preconfigured settings from your template apply — adjust them in YAML or with that plugin's commands.`
        : `**${label}** is now **disabled**. It will not run until you enable it again with \`/plugin toggle\`.`;

      await ctx.interaction.reply(
        resultReply(enable ? "Plugin enabled" : "Plugin disabled", details, ctx.ephemeral, opts),
      );
    }
  },
};
