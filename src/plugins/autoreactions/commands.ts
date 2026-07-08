import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zAutoreactionsConfig } from "../../config/schemas/plugins.js";
import { nextAutoreactionRuleId, normalizeAutoreactionRules } from "./functions/rules.js";

const ALL_CHANNELS = "*";

function formatChannelLabel(channelId: string): string {
  return channelId === ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
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
          .setDescription("Add an auto-reaction rule")
          .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true))
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Target channel (omit for all channels)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) => o.setName("regex").setDescription("Only react when message content matches this regex")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove an auto-reaction rule by ID")
          .addIntegerOption((o) => o.setName("id").setDescription("Rule ID from /autoreaction list").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List auto-reaction rules")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autoreactions", "can_add");
        if (!auth) return;

        const emoji = ctx.interaction.options.getString("emoji", true);
        const channel = ctx.interaction.options.getChannel("channel");
        const regexRaw = ctx.interaction.options.getString("regex")?.trim();
        const config = zAutoreactionsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreactionRules(config.rules);

        if (regexRaw) {
          try {
            new RegExp(regexRaw);
          } catch {
            await ctx.interaction.reply(
              resultReply("Invalid regex", "Provide a valid regular expression.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
        }

        const channelId = channel?.id ?? ALL_CHANNELS;
        const duplicate = rules.some(
          (rule) => rule.channel_id === channelId && rule.emoji === emoji && (rule.regex ?? "") === (regexRaw ?? ""),
        );
        if (duplicate) {
          await ctx.interaction.reply(resultReply("Already exists", "That auto-reaction rule already exists.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        const newRule = {
          id: nextAutoreactionRuleId(rules),
          channel_id: channelId,
          emoji,
          ...(regexRaw ? { regex: regexRaw } : {}),
        };

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autoreactions",
          { rules: [...rules, newRule] },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const scope = formatChannelLabel(channelId);
        const regexNote = regexRaw ? ` when content matches \`${regexRaw}\`` : "";
        await ctx.interaction.reply(
          resultReply(
            "Auto-reaction added",
            `Rule **#${newRule.id}**: react with ${emoji} in ${scope}${regexNote}.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
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
          await ctx.interaction.reply(resultReply("Not found", `No auto-reaction rule with ID **${id}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(guildId, "autoreactions", { rules: filtered }, ctx.interaction.user.id);
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply("Auto-reaction removed", `Removed rule **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autoreactions", "can_list");
        if (!auth) return;

        const config = zAutoreactionsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutoreactionRules(config.rules);
        if (!rules.length) {
          await ctx.interaction.reply(resultReply("Auto-reactions", "No auto-reaction rules configured.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = rules.map((rule) => {
          const scope = formatChannelLabel(rule.channel_id);
          const regex = rule.regex ? ` · regex \`${rule.regex}\`` : "";
          return `**#${rule.id}** · ${scope} · ${rule.emoji}${regex}`;
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
