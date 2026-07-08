import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zAutomodConfig, type AutomodConfig } from "../../config/schemas/plugins.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId } from "../../core/logging/channels.js";
import { testAutomodRules } from "./functions/handlers.js";

function formatAutomodStatus(config: AutomodConfig, guildConfig: GuildConfig): string {
  const logChannelId = getModerationLogChannelId(guildConfig, config.log_channel_id);
  const lines = [
    `**Rules:** ${config.enabled_rules.join(", ") || "none"}`,
    `**Action:** ${config.action}`,
    `**Duplicate:** ${config.duplicate_max} / ${config.duplicate_window_ms}ms`,
    `**Rate limit:** ${config.rate_limit_count} / ${config.rate_limit_window_ms}ms`,
    `**Raid:** ${config.raid_join_count} joins / ${config.raid_join_window_ms}ms`,
    `**Ignored channels:** ${config.ignored_channels.length}`,
    `**Ignored roles:** ${config.ignored_roles.length}`,
    `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "none (set moderation_log_channel_id)"}`,
  ];
  return lines.join("\n");
}

export const automodCommands: SlashCommandDefinition[] = [
  {
    plugin: "automod",
    data: new SlashCommandBuilder()
      .setName("automod")
      .setDescription("Automod status and testing")
      .addSubcommand((sub) => sub.setName("status").setDescription("Show automod configuration"))
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Test message against automod rules")
          .addStringOption((o) => o.setName("message").setDescription("Sample message content").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();

      if (sub === "status") {
        const auth = await requirePluginPermission(ctx, "automod", "can_status");
        if (!auth) return;
        const config = zAutomodConfig.parse(auth.pluginConfig);
        await ctx.interaction.reply(
          resultReply("Automod status", formatAutomodStatus(config, ctx.guildConfig), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "test") {
        const auth = await requirePluginPermission(ctx, "automod", "can_test");
        if (!auth) return;
        const config = zAutomodConfig.parse(auth.pluginConfig);
        const message = ctx.interaction.options.getString("message", true);
        const hits = await testAutomodRules(message, config);
        await ctx.interaction.reply(
          resultReply("Automod test", hits.join("\n"), ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
