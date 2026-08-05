import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission, pluginEnabled } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zAutomodConfig, type AutomodConfig } from "../../config/schemas/plugins.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId } from "../../core/logging/channels.js";
import { testAutomodRules } from "./functions/handlers.js";

function formatAutomodStatus(config: AutomodConfig, guildConfig: GuildConfig): string {
  const logChannelId = getModerationLogChannelId(guildConfig, config.log_channel_id);
  const enabled = pluginEnabled(guildConfig, "automod");
  const lines = [
    `**Plugin:** ${enabled ? "enabled" : "disabled"}`,
    `**Rules:** ${config.enabled_rules.join(", ") || "none"}`,
    `**Action:** ${config.action}`,
    `**Duplicate:** ${config.duplicate_max} / ${config.duplicate_window_ms}ms`,
    `**Rate limit:** ${config.rate_limit_count} / ${config.rate_limit_window_ms}ms`,
    `**Raid:** ${config.raid_join_count} joins / ${config.raid_join_window_ms}ms`,
    `**Ignored channels:** ${config.ignored_channels.map((id) => `<#${id}>`).join(", ") || "none"}`,
    `**Ignored roles:** ${config.ignored_roles.map((id) => `<@&${id}>`).join(", ") || "none"}`,
    `**Mute duration:** ${Math.round(config.mute_duration_ms / 60_000)}m`,
    `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "none (set moderation_log_channel_id)"}`,
  ];
  return lines.join("\n");
}

export const automodCommands: SlashCommandDefinition[] = [
  {
    plugin: "automod",
    data: new SlashCommandBuilder()
      .setName("automod")
      .setDescription("Automod status, testing, and configuration")
      .addSubcommand((sub) => sub.setName("status").setDescription("Show automod configuration"))
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Preview which configured rules apply to sample text")
          .addStringOption((o) => o.setName("message").setDescription("Sample message content").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("configure")
          .setDescription("Update common automod settings")
          .addStringOption((o) =>
            o
              .setName("action")
              .setDescription("Action when a rule hits")
              .addChoices(
                { name: "Delete", value: "delete" },
                { name: "Warn", value: "warn" },
                { name: "Mute", value: "mute" },
              ),
          )
          .addIntegerOption((o) =>
            o.setName("duplicate_max").setDescription("Duplicate messages before action").setMinValue(2).setMaxValue(20),
          )
          .addIntegerOption((o) =>
            o.setName("duplicate_window").setDescription("Duplicate window in seconds").setMinValue(1).setMaxValue(600),
          )
          .addIntegerOption((o) =>
            o.setName("rate_limit_count").setDescription("Messages before rate-limit action").setMinValue(2).setMaxValue(50),
          )
          .addIntegerOption((o) =>
            o.setName("rate_limit_window").setDescription("Rate-limit window in seconds").setMinValue(1).setMaxValue(600),
          )
          .addIntegerOption((o) =>
            o.setName("mute_minutes").setDescription("Mute duration when action is mute").setMinValue(1).setMaxValue(10_080),
          )
          .addChannelOption((o) =>
            o
              .setName("log_channel")
              .setDescription("Automod log channel")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("ignore-channel")
          .setDescription("Ignore or un-ignore a channel for automod")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          )
          .addBooleanOption((o) => o.setName("ignore").setDescription("True to ignore, false to stop ignoring").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("ignore-role")
          .setDescription("Ignore or un-ignore a role for automod")
          .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
          .addBooleanOption((o) => o.setName("ignore").setDescription("True to ignore, false to stop ignoring").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

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
        return;
      }

      if (sub === "configure") {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;

        const patch: Record<string, unknown> = {};
        const action = ctx.interaction.options.getString("action");
        const duplicateMax = ctx.interaction.options.getInteger("duplicate_max");
        const duplicateWindow = ctx.interaction.options.getInteger("duplicate_window");
        const rateCount = ctx.interaction.options.getInteger("rate_limit_count");
        const rateWindow = ctx.interaction.options.getInteger("rate_limit_window");
        const muteMinutes = ctx.interaction.options.getInteger("mute_minutes");
        const logChannel = ctx.interaction.options.getChannel("log_channel");

        if (action) patch.action = action;
        if (duplicateMax != null) patch.duplicate_max = duplicateMax;
        if (duplicateWindow != null) patch.duplicate_window_ms = duplicateWindow * 1000;
        if (rateCount != null) patch.rate_limit_count = rateCount;
        if (rateWindow != null) patch.rate_limit_window_ms = rateWindow * 1000;
        if (muteMinutes != null) patch.mute_duration_ms = muteMinutes * 60_000;
        if (logChannel) patch.log_channel_id = logChannel.id;

        if (!Object.keys(patch).length) {
          await ctx.interaction.reply(
            resultReply("Nothing to update", "Provide at least one setting to change.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(guildId, "automod", patch, ctx.interaction.user.id);
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const config = zAutomodConfig.parse(result.data.plugins.automod?.config ?? {});
        await ctx.interaction.reply(
          resultReply("Automod updated", formatAutomodStatus(config, result.data), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "ignore-channel") {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const channel = ctx.interaction.options.getChannel("channel", true);
        const ignore = ctx.interaction.options.getBoolean("ignore", true);
        const config = zAutomodConfig.parse(auth.pluginConfig);
        const set = new Set(config.ignored_channels);
        if (ignore) set.add(channel.id);
        else set.delete(channel.id);

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "automod",
          { ignored_channels: [...set] },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            ignore ? "Channel ignored" : "Channel unignored",
            `<#${channel.id}> ${ignore ? "will be ignored" : "is no longer ignored"} by automod.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "ignore-role") {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const role = ctx.interaction.options.getRole("role", true);
        const ignore = ctx.interaction.options.getBoolean("ignore", true);
        const config = zAutomodConfig.parse(auth.pluginConfig);
        const set = new Set(config.ignored_roles);
        if (ignore) set.add(role.id);
        else set.delete(role.id);

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "automod",
          { ignored_roles: [...set] },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            ignore ? "Role ignored" : "Role unignored",
            `<@&${role.id}> ${ignore ? "will be ignored" : "is no longer ignored"} by automod.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
      }
    },
  },
];
