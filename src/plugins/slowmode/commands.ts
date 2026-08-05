import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, embedReply, slashResultOptions } from "../../core/responses.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zSlowmodeConfig } from "../../config/schemas/plugins.js";
import { getSlowmodeGuildConfig } from "./functions/config.js";
import {
  describeResolvedDelay,
  formatSeconds,
  formatSlowmodeRule,
  normalizeSlowmodeRules,
  resolveIndividualDelay,
} from "./functions/rules.js";
import { buildSlowmodeRuleAddModal } from "./functions/modal.js";
import { invalidateSlowmodeConfigCache } from "./functions/handlers.js";

export const slowmodeCommands: SlashCommandDefinition[] = [
  {
    plugin: "slowmode",
    data: new SlashCommandBuilder()
      .setName("slowmode")
      .setDescription("Manage channel and individual slowmode")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set Discord channel slowmode")
          .addIntegerOption((o) =>
            o
              .setName("preset")
              .setDescription("Common slowmode preset")
              .addChoices(
                { name: "Off", value: 0 },
                { name: "5 seconds", value: 5 },
                { name: "10 seconds", value: 10 },
                { name: "15 seconds", value: 15 },
                { name: "30 seconds", value: 30 },
                { name: "1 minute", value: 60 },
                { name: "5 minutes", value: 300 },
                { name: "15 minutes", value: 900 },
                { name: "1 hour", value: 3600 },
              ),
          )
          .addIntegerOption((o) =>
            o.setName("seconds").setDescription("Custom seconds (overrides preset)").setMinValue(0).setMaxValue(21600),
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel (defaults to current)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("clear")
          .setDescription("Clear Discord channel slowmode")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel (defaults to current)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Show Discord channel slowmode and individual settings")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel (defaults to current)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("rule")
          .setDescription("Manage individual slowmode rules")
          .addSubcommand((sub) => sub.setName("add").setDescription("Open a form to add a user or role slowmode rule"))
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove an individual slowmode rule by ID")
              .addIntegerOption((o) =>
                o.setName("id").setDescription("Rule ID from /slowmode rule list").setRequired(true).setMinValue(1),
              ),
          )
          .addSubcommand((sub) => sub.setName("list").setDescription("List individual slowmode rules")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("check")
          .setDescription("Show the effective individual slowmode for a member")
          .addUserOption((o) => o.setName("user").setDescription("Member to check (defaults to you)"))
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel to evaluate (defaults to current)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("bypass")
          .setDescription("Toggle whether Manage Messages bypasses individual slowmode")
          .addBooleanOption((o) =>
            o
              .setName("enabled")
              .setDescription("True = members with Manage Messages bypass; false = nobody bypasses")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("individual")
          .setDescription("Configure individual (per-user/role) slowmode")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable individual slowmode"))
          .addIntegerOption((o) =>
            o
              .setName("default_seconds")
              .setDescription("Default delay when no rule matches (0 = none)")
              .setMinValue(0)
              .setMaxValue(21600),
          ),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const opts = slashResultOptions(ctx);

      if (group === "rule") {
        if (sub === "add") {
          const auth = await requirePluginPermission(ctx, "slowmode", "can_manage_rules");
          if (!auth) return;
          await ctx.interaction.showModal(buildSlowmodeRuleAddModal());
          return;
        }

        if (sub === "remove") {
          const auth = await requirePluginPermission(ctx, "slowmode", "can_manage_rules");
          if (!auth) return;

          const id = ctx.interaction.options.getInteger("id", true);
          const config = zSlowmodeConfig.parse(auth.pluginConfig);
          const rules = normalizeSlowmodeRules(config.rules);
          const filtered = rules.filter((rule) => rule.id !== id);

          if (filtered.length === rules.length) {
            await ctx.interaction.reply(
              resultReply("Not found", `No slowmode rule with ID **${id}**.`, ctx.ephemeral, opts),
            );
            return;
          }

          const result = await ctx.configManager.patchPluginConfig(
            guildId,
            "slowmode",
            { rules: filtered },
            ctx.interaction.user.id,
          );
          if (!result.success) {
            await ctx.interaction.reply(
              resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }

          invalidateSlowmodeConfigCache(guildId);

          await ctx.interaction.reply(
            resultReply("Slowmode rule removed", `Removed rule **#${id}**.`, ctx.ephemeral, opts),
          );
          return;
        }

        if (sub === "list") {
          const auth = await requirePluginPermission(ctx, "slowmode", "can_manage_rules");
          if (!auth) return;

          const config = getSlowmodeGuildConfig(ctx.guildConfig);
          const rules = normalizeSlowmodeRules(config.rules);
          if (!rules.length) {
            await ctx.interaction.reply(
              resultReply(
                "Individual slowmode",
                "No rules configured. Use `/slowmode rule add` to create one.",
                ctx.ephemeral,
                opts,
              ),
            );
            return;
          }

          const lines = rules.map((rule) => formatSlowmodeRule(rule));
          await ctx.interaction.reply(
            embedReply(
              setEmbedAuthor(baseEmbed(), "Individual slowmode rules", ctx.client, commandHeader(ctx.guildConfig)).addFields(
                embedField("Rules", trimLines(lines.join("\n"))),
                embedField(
                  "Settings",
                  [
                    `Enabled: **${config.individual_enabled ? "yes" : "no"}**`,
                    `Manage Messages bypass: **${config.allow_manage_messages_bypass ? "on" : "off"}**`,
                    `Default delay: **${formatSeconds(config.individual_default_seconds)}**`,
                  ].join("\n"),
                ),
              ),
              ctx.ephemeral,
            ),
          );
          return;
        }
      }

      if (sub === "check") {
        const auth = await requirePluginPermission(ctx, "slowmode", "can_manage_rules");
        if (!auth) return;

        const config = getSlowmodeGuildConfig(ctx.guildConfig);
        const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
        const channelRef = ctx.interaction.options.getChannel("channel") ?? ctx.interaction.channel;
        if (!channelRef) {
          await ctx.interaction.reply(
            resultReply("Channel required", "Select a valid text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        if (!member) {
          await ctx.interaction.reply(
            resultReply("Member not found", "That user is not in this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        if (!config.individual_enabled) {
          await ctx.interaction.reply(
            resultReply(
              "Individual slowmode",
              `Individual slowmode is **disabled**. <@${member.id}> is not limited by rules.`,
              ctx.ephemeral,
              opts,
            ),
          );
          return;
        }

        const hasManage = member.permissionsIn(channelRef.id).has(PermissionFlagsBits.ManageMessages);
        const wouldBypass = config.allow_manage_messages_bypass && hasManage;
        const resolved = resolveIndividualDelay(config, member, channelRef.id);

        const lines = [
          `<@${member.id}> in <#${channelRef.id}>`,
          wouldBypass
            ? "Effective delay: **bypassed** (Manage Messages)"
            : resolved.seconds > 0
              ? `Effective delay: **${formatSeconds(resolved.seconds)}** (${describeResolvedDelay(resolved)})`
              : "Effective delay: **none**",
          `Manage Messages bypass: **${config.allow_manage_messages_bypass ? "on" : "off"}**${hasManage ? " · member has permission" : ""}`,
        ];

        await ctx.interaction.reply(resultReply("Slowmode check", lines.join("\n"), ctx.ephemeral, opts));
        return;
      }

      if (sub === "bypass") {
        const auth = await requirePluginPermission(ctx, "slowmode", "can_configure");
        if (!auth) return;

        const enabled = ctx.interaction.options.getBoolean("enabled", true);
        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "slowmode",
          { allow_manage_messages_bypass: enabled },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        invalidateSlowmodeConfigCache(guildId);

        await ctx.interaction.reply(
          resultReply(
            "Bypass updated",
            enabled
              ? "Members with **Manage Messages** bypass individual slowmode."
              : "Individual slowmode **cannot be bypassed** by Manage Messages (or anyone).",
            ctx.ephemeral,
            opts,
          ),
        );
        return;
      }

      if (sub === "individual") {
        const auth = await requirePluginPermission(ctx, "slowmode", "can_configure");
        if (!auth) return;

        const enabled = ctx.interaction.options.getBoolean("enabled");
        const defaultSeconds = ctx.interaction.options.getInteger("default_seconds");
        if (enabled == null && defaultSeconds == null) {
          const config = getSlowmodeGuildConfig(ctx.guildConfig);
          await ctx.interaction.reply(
            resultReply(
              "Individual slowmode",
              [
                `Enabled: **${config.individual_enabled ? "yes" : "no"}**`,
                `Default delay: **${formatSeconds(config.individual_default_seconds)}**`,
                `Manage Messages bypass: **${config.allow_manage_messages_bypass ? "on" : "off"}**`,
                `Rules: **${normalizeSlowmodeRules(config.rules).length}**`,
                "",
                "Pass `enabled` and/or `default_seconds` to update.",
              ].join("\n"),
              ctx.ephemeral,
              opts,
            ),
          );
          return;
        }

        const patch: Record<string, unknown> = {};
        if (enabled != null) patch.individual_enabled = enabled;
        if (defaultSeconds != null) patch.individual_default_seconds = defaultSeconds;

        const result = await ctx.configManager.patchPluginConfig(guildId, "slowmode", patch, ctx.interaction.user.id);
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        invalidateSlowmodeConfigCache(guildId);

        const parts: string[] = [];
        if (enabled != null) parts.push(`Individual slowmode **${enabled ? "enabled" : "disabled"}**.`);
        if (defaultSeconds != null) {
          parts.push(
            defaultSeconds > 0
              ? `Default delay set to **${formatSeconds(defaultSeconds)}** when no rule matches.`
              : "Default delay cleared (no limit unless a rule matches).",
          );
        }

        await ctx.interaction.reply(resultReply("Individual slowmode updated", parts.join("\n"), ctx.ephemeral, opts));
        return;
      }

      // Native Discord channel slowmode commands
      const permissionKey = sub === "set" ? "can_set" : sub === "clear" ? "can_clear" : "can_set";
      const auth = await requirePluginPermission(ctx, "slowmode", permissionKey);
      if (!auth) return;

      if (sub === "set" || sub === "clear") {
        if (!ctx.interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await ctx.interaction.reply(
            resultReply(
              "Missing permission",
              "You need **Manage Channels** to change Discord channel slowmode.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        const me = ctx.interaction.guild!.members.me;
        if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await ctx.interaction.reply(
            resultReply(
              "Missing permission",
              "I need **Manage Channels** to change Discord channel slowmode.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
      }

      const channelRef = ctx.interaction.options.getChannel("channel") ?? ctx.interaction.channel;
      if (!channelRef) {
        await ctx.interaction.reply(
          resultReply("Slowmode", "Select a valid text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const channel = await ctx.interaction.guild!.channels.fetch(channelRef.id).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased() || !("setRateLimitPerUser" in channel)) {
        await ctx.interaction.reply(
          resultReply("Slowmode", "Select a valid text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (sub === "status") {
        const config = getSlowmodeGuildConfig(ctx.guildConfig);
        const current = "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0;
        const rules = normalizeSlowmodeRules(config.rules);
        const lines = [
          current
            ? `Discord channel slowmode: **${formatSeconds(current)}**`
            : "Discord channel slowmode: **off**",
          `Individual slowmode: **${config.individual_enabled ? "on" : "off"}** · **${rules.length}** rule(s)`,
          `Manage Messages bypass: **${config.allow_manage_messages_bypass ? "on" : "off"}**`,
          `Default individual delay: **${formatSeconds(config.individual_default_seconds)}**`,
        ];
        await ctx.interaction.reply(resultReply(`Slowmode · <#${channel.id}>`, lines.join("\n"), ctx.ephemeral, opts));
        return;
      }

      const seconds =
        sub === "set"
          ? (ctx.interaction.options.getInteger("seconds") ?? ctx.interaction.options.getInteger("preset"))
          : 0;

      if (sub === "set" && seconds === null) {
        await ctx.interaction.reply(
          resultReply(
            "Missing value",
            "Provide a `preset` or custom `seconds` value.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      await channel.setRateLimitPerUser(seconds ?? 0, `Slowmode ${sub} by ${ctx.interaction.user.tag}`);

      if (sub === "set") {
        await ctx.interaction.reply(
          resultReply(
            "Channel slowmode set",
            `<#${channel.id}> Discord slowmode set to **${formatSeconds(seconds ?? 0)}**.`,
            ctx.ephemeral,
            opts,
          ),
        );
        return;
      }

      await ctx.interaction.reply(
        resultReply(
          "Channel slowmode cleared",
          `<#${channel.id}> Discord slowmode disabled.`,
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "unchecked" }),
        ),
      );
    },
  },
];
