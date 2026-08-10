import { ChannelType, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission, pluginEnabled } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import type { AutomodConfig, AutomodFilterEntry } from "../../config/schemas/automod.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId } from "../../core/logging/channels.js";
import { AUTOMOD_RULE_META } from "./catalog.js";
import { testAutomodRules } from "./functions/handlers.js";
import { parseAutomodConfig } from "./functions/migrate.js";
import { applyPresetToConfig } from "./functions/presets.js";
import { parseFilterEntries } from "./functions/customFilter.js";
import type { AutomodPresetName } from "../../config/schemas/automod.js";

function formatAutomodStatus(config: AutomodConfig, guildConfig: GuildConfig): string {
  const logChannelId = getModerationLogChannelId(guildConfig, config.log_channel_id);
  const enabled = pluginEnabled(guildConfig, "automod");
  const activeRules = AUTOMOD_RULE_META.filter((r) => config.rules[r.id]?.enabled).map((r) => r.name);
  const lines = [
    `**Plugin:** ${enabled ? "enabled" : "disabled"}`,
    `**Preset:** ${config.presets_applied ?? "custom / none"}`,
    `**Active rules:** ${activeRules.join(", ") || "none"}`,
    `**Ignored channels:** ${config.ignored_channels.map((id) => `<#${id}>`).join(", ") || "none"}`,
    `**Ignored roles:** ${config.ignored_roles.map((id) => `<@&${id}>`).join(", ") || "none"}`,
    `**Ignore above level:** ${config.ignore_above_level == null ? "off" : config.ignore_above_level}`,
    `**DM users:** ${config.dm_users ? "yes" : "no"}`,
    `**Custom filters:** ${parseFilterEntries(config.rules.custom_filter?.settings ?? {}).length}`,
    `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "none (set moderation_log_channel_id)"}`,
  ];
  return lines.join("\n");
}

export const automodCommands: SlashCommandDefinition[] = [
  {
    plugin: "automod",
    data: new SlashCommandBuilder()
      .setName("automod")
      .setDescription("Automod status, testing, filters, and configuration")
      .addSubcommand((sub) => sub.setName("status").setDescription("Show automod configuration"))
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Preview which content rules match sample text")
          .addStringOption((o) => o.setName("message").setDescription("Sample message content").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("preset")
          .setDescription("Apply a recommended automod preset")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Preset")
              .setRequired(true)
              .addChoices(
                { name: "Light", value: "light" },
                { name: "Standard", value: "standard" },
                { name: "Strict", value: "strict" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("toggle")
          .setDescription("Enable or disable a rule")
          .addStringOption((o) =>
            o
              .setName("rule")
              .setDescription("Rule id")
              .setRequired(true)
              .addChoices(...AUTOMOD_RULE_META.slice(0, 25).map((r) => ({ name: r.name, value: r.id }))),
          )
          .addBooleanOption((o) => o.setName("enabled").setDescription("Enable?").setRequired(true)),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("filters")
          .setDescription("Manage custom word/phrase filters")
          .addSubcommand((sub) => sub.setName("list").setDescription("List custom filter entries"))
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Add a custom filter entry")
              .addStringOption((o) => o.setName("pattern").setDescription("Word, phrase, or regex").setRequired(true))
              .addBooleanOption((o) => o.setName("regex").setDescription("Treat as regex")),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove a custom filter by id or pattern")
              .addStringOption((o) => o.setName("pattern").setDescription("Entry id or exact pattern").setRequired(true)),
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
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "status" && !group) {
        const auth = await requirePluginPermission(ctx, "automod", "can_status");
        if (!auth) return;
        const config = parseAutomodConfig(auth.pluginConfig);
        await ctx.interaction.reply(
          resultReply("Automod status", formatAutomodStatus(config, ctx.guildConfig), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "test" && !group) {
        const auth = await requirePluginPermission(ctx, "automod", "can_test");
        if (!auth) return;
        const config = parseAutomodConfig(auth.pluginConfig);
        const message = ctx.interaction.options.getString("message", true);
        const hits = await testAutomodRules(message, config);
        await ctx.interaction.reply(
          resultReply("Automod test", hits.join("\n"), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "preset" && !group) {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const name = ctx.interaction.options.getString("name", true) as AutomodPresetName;
        const current = parseAutomodConfig(auth.pluginConfig);
        const next = applyPresetToConfig(current, name);
        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "automod",
          {
            presets_applied: next.presets_applied,
            rules: next.rules,
          },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await ctx.interaction.reply(
          resultReply(
            "Preset applied",
            `Applied **${name}** preset. Turn the Automod plugin **on** in the dashboard if it is still disabled.\n\n${formatAutomodStatus(parseAutomodConfig(result.data.plugins.automod?.config ?? {}), result.data)}`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "toggle" && !group) {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const ruleId = ctx.interaction.options.getString("rule", true);
        const enabled = ctx.interaction.options.getBoolean("enabled", true);
        const current = parseAutomodConfig(auth.pluginConfig);
        const rule = current.rules[ruleId];
        if (!rule) {
          await ctx.interaction.reply(resultReply("Error", "Unknown rule.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const rules = { ...current.rules, [ruleId]: { ...rule, enabled } };
        const result = await ctx.configManager.patchPluginConfig(guildId, "automod", { rules }, ctx.interaction.user.id);
        if (!result.success) {
          await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        await ctx.interaction.reply(
          resultReply("Rule updated", `**${ruleId}** is now **${enabled ? "enabled" : "disabled"}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (group === "filters") {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const current = parseAutomodConfig(auth.pluginConfig);
        const entries = parseFilterEntries(current.rules.custom_filter?.settings ?? {});

        if (sub === "list") {
          if (!entries.length) {
            await ctx.interaction.reply(resultReply("Custom filters", "No custom filter entries.", ctx.ephemeral, slashResultOptions(ctx)));
            return;
          }
          const lines = entries.slice(0, 25).map(
            (e) => `• \`${e.id.slice(0, 8)}\` ${e.regex ? "(regex) " : ""}**${e.pattern}** ${e.enabled ? "" : "(off)"}`,
          );
          await ctx.interaction.reply(resultReply("Custom filters", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        if (sub === "add") {
          const pattern = ctx.interaction.options.getString("pattern", true);
          const regex = ctx.interaction.options.getBoolean("regex") ?? false;
          const entry: AutomodFilterEntry = { id: randomUUID(), pattern, regex, enabled: true };
          const nextEntries = [...entries, entry];
          const custom = {
            ...(current.rules.custom_filter ?? parseAutomodConfig({}).rules.custom_filter!),
            enabled: true,
            settings: { ...(current.rules.custom_filter?.settings ?? {}), entries: nextEntries },
          };
          const result = await ctx.configManager.patchPluginConfig(
            guildId,
            "automod",
            { rules: { ...current.rules, custom_filter: custom } },
            ctx.interaction.user.id,
          );
          if (!result.success) {
            await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          await ctx.interaction.reply(
            resultReply("Filter added", `Added \`${pattern}\`. Custom filter rule enabled.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        if (sub === "remove") {
          const pattern = ctx.interaction.options.getString("pattern", true);
          const nextEntries = entries.filter((e) => e.id !== pattern && e.pattern !== pattern && !e.id.startsWith(pattern));
          if (nextEntries.length === entries.length) {
            await ctx.interaction.reply(resultReply("Not found", "No matching filter entry.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
            return;
          }
          const custom = {
            ...(current.rules.custom_filter ?? parseAutomodConfig({}).rules.custom_filter!),
            settings: { ...(current.rules.custom_filter?.settings ?? {}), entries: nextEntries },
          };
          const result = await ctx.configManager.patchPluginConfig(
            guildId,
            "automod",
            { rules: { ...current.rules, custom_filter: custom } },
            ctx.interaction.user.id,
          );
          if (!result.success) {
            await ctx.interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          await ctx.interaction.reply(resultReply("Filter removed", `Removed \`${pattern}\`.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
      }

      if (sub === "ignore-channel") {
        const auth = await requirePluginPermission(ctx, "automod", "can_configure");
        if (!auth) return;
        const channel = ctx.interaction.options.getChannel("channel", true);
        const ignore = ctx.interaction.options.getBoolean("ignore", true);
        const config = parseAutomodConfig(auth.pluginConfig);
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
        const config = parseAutomodConfig(auth.pluginConfig);
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
