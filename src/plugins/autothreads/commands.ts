import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zAutothreadsConfig, zAutothreadTrigger } from "../../config/schemas/plugins.js";
import { validateRegexPatternForSave } from "../../core/regexSafety.js";
import {
  formatAutothreadRule,
  nextAutothreadRuleId,
  normalizeAutothreadRules,
  THREAD_ARCHIVE_MINUTES,
  type ThreadArchiveMinutes,
} from "./functions/rules.js";

const ALL_CHANNELS = "*";

function formatChannelLabel(channelId: string): string {
  return channelId === ALL_CHANNELS ? "All channels" : `<#${channelId}>`;
}

function isArchiveMinutes(value: number): value is ThreadArchiveMinutes {
  return (THREAD_ARCHIVE_MINUTES as readonly number[]).includes(value);
}

export const autothreadsCommands: SlashCommandDefinition[] = [
  {
    plugin: "autothreads",
    data: new SlashCommandBuilder()
      .setName("autothread")
      .setDescription("Configure automatic threads on matching messages")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Create an auto-thread rule")
          .addStringOption((o) =>
            o
              .setName("message")
              .setDescription("Message Dreamliner posts in the new thread")
              .setRequired(true)
              .setMaxLength(2000),
          )
          .addStringOption((o) =>
            o
              .setName("thread_name")
              .setDescription("Thread title. Placeholders like {user_display} work")
              .setMaxLength(100),
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel to listen in. Omit for all channels")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) =>
            o
              .setName("trigger")
              .setDescription("When to start a thread")
              .addChoices(
                { name: "Every message", value: "every_message" },
                { name: "Contains", value: "contains" },
                { name: "Starts with", value: "starts_with" },
                { name: "Exact", value: "exact" },
                { name: "Regex", value: "regex" },
              ),
          )
          .addStringOption((o) =>
            o.setName("match").setDescription("Text or regex to match").setMaxLength(200),
          )
          .addIntegerOption((o) =>
            o
              .setName("auto_archive")
              .setDescription("Minutes until the thread auto-archives")
              .addChoices(
                { name: "1 hour", value: 60 },
                { name: "24 hours", value: 1440 },
                { name: "3 days", value: 4320 },
                { name: "1 week", value: 10080 },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove an auto-thread rule by ID")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("Rule ID from /autothread list").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List auto-thread rules")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autothreads", "can_add");
        if (!auth) return;

        const message = ctx.interaction.options.getString("message", true).trim();
        if (!message) {
          await ctx.interaction.reply(
            resultReply(
              "Message required",
              "Provide a thread message.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        const triggerRaw = ctx.interaction.options.getString("trigger") ?? "every_message";
        const triggerParsed = zAutothreadTrigger.safeParse(triggerRaw);
        const trigger = triggerParsed.success ? triggerParsed.data : "every_message";
        const match = ctx.interaction.options.getString("match")?.trim() || undefined;
        if (trigger !== "every_message" && !match) {
          await ctx.interaction.reply(
            resultReply(
              "Match required",
              "Provide match text unless the trigger is every message.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
        if (trigger === "regex" && match) {
          const validation = await validateRegexPatternForSave(match, "i");
          if (!validation.ok) {
            await ctx.interaction.reply(
              resultReply("Invalid regex", validation.error, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
        }

        const archiveRaw = ctx.interaction.options.getInteger("auto_archive") ?? 1440;
        const auto_archive_minutes: ThreadArchiveMinutes = isArchiveMinutes(archiveRaw) ? archiveRaw : 1440;
        const config = zAutothreadsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutothreadRules(config.rules);
        const newRule = {
          id: nextAutothreadRuleId(rules),
          channel_id: ctx.interaction.options.getChannel("channel")?.id ?? ALL_CHANNELS,
          thread_name: ctx.interaction.options.getString("thread_name")?.trim() || "{user_display}",
          auto_archive_minutes,
          response: message,
          trigger,
          ...(match ? { match } : {}),
        };

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autothreads",
          { rules: [...rules, newRule] },
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
            "Auto-thread added",
            `Created rule **#${newRule.id}**. Use the dashboard for embeds, webhooks, and buttons.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "autothreads", "can_remove");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const config = zAutothreadsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutothreadRules(config.rules);
        const filtered = rules.filter((rule) => rule.id !== id);

        if (filtered.length === rules.length) {
          await ctx.interaction.reply(
            resultReply("Not found", `No auto-thread rule with ID **${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autothreads",
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
          resultReply("Auto-thread removed", `Removed rule **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autothreads", "can_list");
        if (!auth) return;

        const config = zAutothreadsConfig.parse(auth.pluginConfig);
        const rules = normalizeAutothreadRules(config.rules);
        if (!rules.length) {
          await ctx.interaction.reply(
            resultReply("Auto-threads", "No auto-thread rules configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rules.map((rule) => {
          const scope = formatChannelLabel(rule.channel_id);
          const preview = rule.response.length > 60 ? `${rule.response.slice(0, 57)}…` : rule.response;
          return `**#${rule.id}** · ${scope} · \`${rule.thread_name}\` · \`${preview}\` · ${formatAutothreadRule(rule)}`;
        });

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Auto-threads", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Rules", trimLines(lines.join("\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
