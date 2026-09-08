import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { getSlowmodeGuildConfig } from "./functions/config.js";
import {
  describeResolvedDelay,
  formatSeconds,
  normalizeSlowmodeRules,
  resolveIndividualDelay,
} from "./functions/rules.js";

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
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const opts = slashResultOptions(ctx);

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

        await ctx.interaction.reply(
          resultReply("Slowmode check", lines.join("\n"), ctx.ephemeral, {
            ...opts,
            emoji: "<:icons_fingerprint:1544418020682899537>",
          }),
        );
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
        await ctx.interaction.reply(
          resultReply(`Slowmode · <#${channel.id}>`, lines.join("\n"), ctx.ephemeral, {
            ...opts,
            emoji: "<:icons_clock:1544417185336664114>",
          }),
        );
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
            { ...opts, emoji: "<:icons_clock:1544417185336664114>" },
          ),
        );
        return;
      }

      await ctx.interaction.reply(
        resultReply(
          "Channel slowmode cleared",
          `<#${channel.id}> Discord slowmode disabled.`,
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "unchecked", emoji: "<:icons_off:1544417567777628201>" }),
        ),
      );
    },
  },
];
