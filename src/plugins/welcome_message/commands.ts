import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zWelcomeMessageConfig } from "../../config/schemas/plugins.js";
import { sendWelcomeMessage } from "./functions/handlers.js";

export const welcomeMessageCommands: SlashCommandDefinition[] = [
  {
    plugin: "welcome_message",
    data: new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Configure welcome messages")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set the welcome channel and message")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Welcome channel").addChannelTypes(ChannelType.GuildText).setRequired(true),
          )
          .addStringOption((o) => o.setName("message").setDescription("Welcome message template")),
      )
      .addSubcommand((sub) => sub.setName("test").setDescription("Send a test welcome message"))
      .addSubcommand((sub) => sub.setName("disable").setDescription("Disable welcome messages")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "set") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_set");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const message = ctx.interaction.options.getString("message");
        const patch: Record<string, unknown> = { channel_id: channel.id };
        if (message !== null) patch.message = message;

        const result = await ctx.configManager.patchPluginConfig(guildId, "welcome_message", patch, ctx.interaction.user.id);
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply("Welcome configured", `Messages will be sent to <#${channel.id}>.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "test") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_test");
        if (!auth) return;

        const config = zWelcomeMessageConfig.parse(auth.pluginConfig);
        if (!config.channel_id) {
          await ctx.interaction.reply(resultReply("Not configured", "Set a welcome channel first with `/welcome set`.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        await sendWelcomeMessage(auth.member, config);
        await ctx.interaction.reply(resultReply("Test sent", `A test welcome message was sent to <#${config.channel_id}>.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "disable") {
        const auth = await requirePluginPermission(ctx, "welcome_message", "can_disable");
        if (!auth) return;

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "welcome_message",
          { channel_id: null },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(resultReply("Welcome disabled", "Welcome messages are now disabled.", ctx.ephemeral, slashResultOptions(ctx, { tone: "unchecked" })));
      }
    },
  },
];
