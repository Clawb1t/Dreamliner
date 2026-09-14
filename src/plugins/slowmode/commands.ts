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
            resultReply(ctx.t("slowmode.channelRequiredTitle", "Channel required"), ctx.t("slowmode.selectValidChannel", "Select a valid text channel."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        if (!member) {
          await ctx.interaction.reply(
            resultReply(ctx.t("slowmode.memberNotFoundTitle", "Member not found"), ctx.t("slowmode.memberNotInServer", "That user is not in this server."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        if (!config.individual_enabled) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("slowmode.individualTitle", "Individual slowmode"),
              ctx.t("slowmode.individualDisabledDesc", "Individual slowmode is **disabled**. <@{memberId}> is not limited by rules.", { memberId: member.id }),
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
          ctx.t("slowmode.checkHeader", "<@{memberId}> in <#{channelId}>", { memberId: member.id, channelId: channelRef.id }),
          wouldBypass
            ? ctx.t("slowmode.effectiveDelayBypassed", "Effective delay: **bypassed** (Manage Messages)")
            : resolved.seconds > 0
              ? ctx.t("slowmode.effectiveDelay", "Effective delay: **{seconds}** ({description})", {
                  seconds: formatSeconds(resolved.seconds, ctx.t),
                  description: describeResolvedDelay(resolved, ctx.t),
                })
              : ctx.t("slowmode.effectiveDelayNone", "Effective delay: **none**"),
          ctx.t("slowmode.manageMessagesBypassLine", "Manage Messages bypass: **{state}**{permissionNote}", {
            state: config.allow_manage_messages_bypass ? ctx.t("slowmode.on", "on") : ctx.t("slowmode.off", "off"),
            permissionNote: hasManage ? ctx.t("slowmode.memberHasPermissionSuffix", " · member has permission") : "",
          }),
        ];

        await ctx.interaction.reply(
          resultReply(ctx.t("slowmode.checkTitle", "Slowmode check"), lines.join("\n"), ctx.ephemeral, {
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
              ctx.t("slowmode.missingPermissionTitle", "Missing permission"),
              ctx.t("slowmode.userNeedsManageChannels", "You need **Manage Channels** to change Discord channel slowmode."),
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
              ctx.t("slowmode.missingPermissionTitle", "Missing permission"),
              ctx.t("slowmode.botNeedsManageChannels", "I need **Manage Channels** to change Discord channel slowmode."),
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
          resultReply(ctx.t("slowmode.title", "Slowmode"), ctx.t("slowmode.selectValidChannel", "Select a valid text channel."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const channel = await ctx.interaction.guild!.channels.fetch(channelRef.id).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased() || !("setRateLimitPerUser" in channel)) {
        await ctx.interaction.reply(
          resultReply(ctx.t("slowmode.title", "Slowmode"), ctx.t("slowmode.selectValidChannel", "Select a valid text channel."), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (sub === "status") {
        const config = getSlowmodeGuildConfig(ctx.guildConfig);
        const current = "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0;
        const rules = normalizeSlowmodeRules(config.rules);
        const lines = [
          current
            ? ctx.t("slowmode.discordSlowmodeValue", "Discord channel slowmode: **{seconds}**", { seconds: formatSeconds(current, ctx.t) })
            : ctx.t("slowmode.discordSlowmodeOff", "Discord channel slowmode: **off**"),
          ctx.t("slowmode.individualSummaryLine", "Individual slowmode: **{state}** · **{count}** rule(s)", {
            state: config.individual_enabled ? ctx.t("slowmode.on", "on") : ctx.t("slowmode.off", "off"),
            count: rules.length,
          }),
          ctx.t("slowmode.manageMessagesBypassSummary", "Manage Messages bypass: **{state}**", {
            state: config.allow_manage_messages_bypass ? ctx.t("slowmode.on", "on") : ctx.t("slowmode.off", "off"),
          }),
          ctx.t("slowmode.defaultIndividualDelay", "Default individual delay: **{seconds}**", {
            seconds: formatSeconds(config.individual_default_seconds, ctx.t),
          }),
        ];
        await ctx.interaction.reply(
          resultReply(ctx.t("slowmode.statusTitle", "Slowmode · <#{channelId}>", { channelId: channel.id }), lines.join("\n"), ctx.ephemeral, {
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
            ctx.t("slowmode.missingValueTitle", "Missing value"),
            ctx.t("slowmode.missingValueDesc", "Provide a `preset` or custom `seconds` value."),
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
            ctx.t("slowmode.channelSlowmodeSetTitle", "Channel slowmode set"),
            ctx.t("slowmode.channelSlowmodeSetDesc", "<#{channelId}> Discord slowmode set to **{seconds}**.", {
              channelId: channel.id,
              seconds: formatSeconds(seconds ?? 0, ctx.t),
            }),
            ctx.ephemeral,
            { ...opts, emoji: "<:icons_clock:1544417185336664114>" },
          ),
        );
        return;
      }

      await ctx.interaction.reply(
        resultReply(
          ctx.t("slowmode.channelSlowmodeClearedTitle", "Channel slowmode cleared"),
          ctx.t("slowmode.channelSlowmodeClearedDesc", "<#{channelId}> Discord slowmode disabled.", { channelId: channel.id }),
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "unchecked", emoji: "<:icons_off:1544417567777628201>" }),
        ),
      );
    },
  },
];
