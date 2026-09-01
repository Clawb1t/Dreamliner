import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { normalizeEmojiInput } from "../../core/emoji.js";
import { zAutoreactionsConfig } from "../../config/schemas/plugins.js";
import { formatAutoreactionRule, normalizeAutoreactionRules, AUTOREACTION_ALL_CHANNELS } from "./functions/rules.js";
import { buildAutoreactionAddModal } from "./functions/modal.js";
import { setPendingAutoreactionEmoji } from "./functions/pending.js";

function formatChannelLabel(channelId: string): string {
  return channelId === AUTOREACTION_ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
}

export const autoreactionsCommands: SlashCommandDefinition[] = [
  {
    plugin: "autoreactions",
    data: new SlashCommandBuilder()
      .setName("autoreaction")
      .setDescription("Configure automatic message reactions")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Open a form to create an auto-reaction rule")
          .addStringOption((o) =>
            o.setName("emoji").setDescription("Emoji to react with").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove an auto-reaction rule by ID")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Rule ID from /autoreaction list").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List auto-reaction rules")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autoreactions", "can_add");
        if (!auth) return;

        const emoji = normalizeEmojiInput(ctx.interaction.options.getString("emoji", true));
        if (!emoji) {
          await ctx.interaction.reply(
            resultReply("Emoji required", "Provide an emoji to react with.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        setPendingAutoreactionEmoji(guildId, ctx.interaction.user.id, emoji);
        await ctx.interaction.showModal(buildAutoreactionAddModal());
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "autoreactions", "can_remove");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const config = zAutoreactionsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreactionRules(config.rules);
        const filtered = rules.filter((rule) => rule.id !== id);

        if (filtered.length === rules.length) {
          await ctx.interaction.reply(
            resultReply("Not found", `No auto-reaction rule with ID **${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autoreactions",
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
          resultReply(
            "Auto-reaction removed",
            `Removed rule **#${id}**.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_deleteemoji:1544417847965524009>" }),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autoreactions", "can_list");
        if (!auth) return;

        const config = zAutoreactionsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreactionRules(config.rules);
        if (!rules.length) {
          await ctx.interaction.reply(
            resultReply("Auto-reactions", "No auto-reaction rules configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rules.map((rule) => {
          const scope = formatChannelLabel(rule.channel_id);
          return `**#${rule.id}** · ${scope} · ${rule.emoji} · ${formatAutoreactionRule(rule)}`;
        });

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Auto-reactions", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Rules", trimLines(lines.join("\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
