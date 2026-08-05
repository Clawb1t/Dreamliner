import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zAutorepliesConfig } from "../../config/schemas/plugins.js";
import { formatAutoreplyRule, normalizeAutoreplyRules } from "./functions/rules.js";
import { buildAutoreplyAddModal } from "./functions/modal.js";
import { setPendingAutoreplyResponse } from "./functions/pending.js";

const ALL_CHANNELS = "*";

function formatChannelLabel(channelId: string): string {
  return channelId === ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
}

export const autorepliesCommands: SlashCommandDefinition[] = [
  {
    plugin: "autoreplies",
    data: new SlashCommandBuilder()
      .setName("autoreply")
      .setDescription("Configure automatic message replies")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Open a form to create an auto-reply rule")
          .addStringOption((o) =>
            o.setName("message").setDescription("Message the bot should send").setRequired(true).setMaxLength(2000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove an auto-reply rule by ID")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Rule ID from /autoreply list").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List auto-reply rules")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autoreplies", "can_add");
        if (!auth) return;

        const message = ctx.interaction.options.getString("message", true).trim();
        if (!message) {
          await ctx.interaction.reply(
            resultReply("Message required", "Provide a reply message.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        setPendingAutoreplyResponse(guildId, ctx.interaction.user.id, message);
        await ctx.interaction.showModal(buildAutoreplyAddModal());
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "autoreplies", "can_remove");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const config = zAutorepliesConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreplyRules(config.rules);
        const filtered = rules.filter((rule) => rule.id !== id);

        if (filtered.length === rules.length) {
          await ctx.interaction.reply(
            resultReply("Not found", `No auto-reply rule with ID **${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autoreplies",
          { rules: filtered },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply("Auto-reply removed", `Removed rule **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autoreplies", "can_list");
        if (!auth) return;

        const config = zAutorepliesConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreplyRules(config.rules);
        if (!rules.length) {
          await ctx.interaction.reply(
            resultReply("Auto-replies", "No auto-reply rules configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rules.map((rule) => {
          const scope = formatChannelLabel(rule.channel_id);
          const preview = rule.response.length > 60 ? `${rule.response.slice(0, 57)}…` : rule.response;
          return `**#${rule.id}** · ${scope} · \`${preview}\` · ${formatAutoreplyRule(rule)}`;
        });

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Auto-replies", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Rules", trimLines(lines.join("\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
