import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zWelcomeMessageConfig } from "../../config/schemas/welcome.js";
import { sendWelcomeEvent } from "./functions/handlers.js";
import type { WelcomeTarget } from "./functions/messageBuilder.js";

export const welcomeMessageCommands: SlashCommandDefinition[] = [
  {
    plugin: "welcome_message",
    data: new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Configure and test the welcomer")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set the join welcome channel")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel for join welcomes")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("show").setDescription("Show the current welcomer summary"))
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Send a test welcomer message")
          .addStringOption((o) =>
            o
              .setName("target")
              .setDescription("Which message to test")
              .addChoices(
                { name: "Join", value: "join" },
                { name: "Leave", value: "leave" },
                { name: "DM", value: "dm" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("disable").setDescription("Disable join welcome messages"),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "set") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_set");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const current = zWelcomeMessageConfig.parse(auth.pluginConfig);
        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "welcome_message",
          {
            join: {
              ...current.join,
              enabled: true,
              channel_id: channel.id,
            },
          },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            "Welcomer updated",
            `Join messages will be sent to <#${channel.id}>. Customize embeds and cards in the dashboard.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_wave:1544418074172727328>" }),
          ),
        );
        return;
      }

      if (sub === "show") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_set");
        if (!auth) return;
        const config = zWelcomeMessageConfig.parse(auth.pluginConfig);
        const lines = [
          `**Join:** ${config.join.enabled ? (config.join.channel_id ? `<#${config.join.channel_id}>` : "enabled (no channel)") : "off"}`,
          `**Leave:** ${config.leave.enabled ? (config.leave.channel_id ? `<#${config.leave.channel_id}>` : "enabled (no channel)") : "off"}`,
          `**DM:** ${config.dm.enabled ? "on" : "off"}`,
          "",
          "Edit embeds, cards, and copy in the Dreamliner dashboard.",
        ];
        await ctx.interaction.reply(
          resultReply(
            "Welcomer",
            lines.join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_summary:1544418222831571044>" }),
          ),
        );
        return;
      }

      if (sub === "test") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_test");
        if (!auth) return;

        const config = zWelcomeMessageConfig.parse(auth.pluginConfig);
        const target = (ctx.interaction.options.getString("target") ?? "join") as WelcomeTarget;
        const result = await sendWelcomeEvent(target, auth.member, config);
        await ctx.interaction.reply(
          resultReply(
            result.ok ? "Test sent" : "Test failed",
            result.detail,
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: result.ok ? "success" : "warning",
              ...(result.ok ? { emoji: "<:icons_hi:1544417555412811786>" } : {}),
            }),
          ),
        );
        return;
      }

      if (sub === "disable") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_disable");
        if (!auth) return;

        const current = zWelcomeMessageConfig.parse(auth.pluginConfig);
        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "welcome_message",
          {
            join: {
              ...current.join,
              enabled: false,
            },
          },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            "Join welcomes disabled",
            "Join channel messages are off. Leave and DM settings are unchanged.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "unchecked" }),
          ),
        );
      }
    },
  },
];
