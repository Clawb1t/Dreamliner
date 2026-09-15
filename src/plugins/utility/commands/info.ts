import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { getGuildServerPageUrl, siteLinkRow } from "../../../core/docsUrl.js";
import { embedReply, embedEdit, resultReply, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { requireUtilityPermission } from "../functions/commandHelpers.js";
import {
  buildUserInfoEmbed,
  buildServerInfoEmbed,
  buildChannelInfoEmbed,
  buildMessageInfoEmbed,
  buildInviteInfoEmbed,
  buildRoleInfoEmbed,
  buildEmojiInfoEmbed,
  buildSnowflakeInfoEmbed,
  buildRolesListEmbed,
  buildLevelEmbed,
  resolveInfoTarget,
} from "../functions/info.js";
import { buildWatchdogEmbed } from "../functions/watchdog.js";

export const infoCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_info",
    data: new SlashCommandBuilder()
      .setName("info")
      .setDescription("Show information about a target (auto-detect type)")
      .addStringOption((o) => o.setName("target").setDescription("ID, mention, or invite URL").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_info");
      if (!auth) return;
      const target = ctx.interaction.options.getString("target", true);
      const resolved = await resolveInfoTarget(target, ctx.interaction.guild!, ctx.guildConfig, ctx.client, ctx.t);
      if (!resolved) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.infoTitle", "Info"), ctx.t("utility.info.couldNotResolveTarget", "Could not resolve target."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(resolved.embed, ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_userinfo",
    data: new SlashCommandBuilder()
      .setName("user")
      .setDescription("Show information about a user")
      .addUserOption((o) => o.setName("member").setDescription("User to inspect"))
      .addBooleanOption((o) => o.setName("compact").setDescription("Compact output")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_userinfo");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("member") ?? ctx.interaction.user;
      const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const embed = await buildUserInfoEmbed(
        user,
        member,
        ctx.guildConfig,
        ctx.interaction.guildId!,
        ctx.client,
        ctx.interaction.options.getBoolean("compact") ?? false,
        ctx.t,
      );
      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_server",
    data: new SlashCommandBuilder()
      .setName("server")
      .setDescription("Show detailed information about this server"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_server");
      if (!auth) return;
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const guild = ctx.interaction.guild!;
      const embed = await buildServerInfoEmbed(guild, ctx.guildConfig, ctx.client, ctx.t);
      await ctx.interaction.editReply(
        embedEdit(embed, [siteLinkRow({ label: ctx.t("utility.info.serverPageLabel", "Server page"), url: getGuildServerPageUrl(guild.id) })]),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_channelinfo",
    data: new SlashCommandBuilder()
      .setName("channel")
      .setDescription("Show information about a channel")
      .addChannelOption((o) =>
        o.setName("target").setDescription("Channel").addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildCategory,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
        ),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_channelinfo");
      if (!auth) return;
      const channel = ctx.interaction.options.getChannel("target") ?? ctx.interaction.channel;
      if (!channel) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.channelTitle", "Channel"), ctx.t("utility.info.channelNotFound", "Channel not found."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const guildChannel = await ctx.interaction.guild!.channels.fetch(channel.id);
      if (!guildChannel) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.channelTitle", "Channel"), ctx.t("utility.info.channelNotFound", "Channel not found."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildChannelInfoEmbed(guildChannel, ctx.interaction.guild!, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_messageinfo",
    data: new SlashCommandBuilder()
      .setName("message")
      .setDescription("Show information about a message")
      .addStringOption((o) => o.setName("message_id").setDescription("Message ID").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_messageinfo");
      if (!auth) return;
      const channel = ctx.interaction.channel;
      if (!channel?.isTextBased() || channel.isDMBased()) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.messageTitle", "Message"), ctx.t("utility.info.useInTextChannel", "Use this command in a text channel."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const id = ctx.interaction.options.getString("message_id", true);
      const message = await channel.messages.fetch(id).catch(() => null);
      if (!message) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.messageTitle", "Message"), ctx.t("utility.info.messageNotFoundInChannel", "Message not found in this channel."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildMessageInfoEmbed(message, ctx.interaction.guildId!, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_inviteinfo",
    data: new SlashCommandBuilder()
      .setName("invite")
      .setDescription("Show information about an invite")
      .addStringOption((o) => o.setName("code").setDescription("Invite code or URL").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_inviteinfo");
      if (!auth) return;
      const code = ctx.interaction.options.getString("code", true).replace(/.*\//, "");
      try {
        const invite = await ctx.interaction.client.fetchInvite(code);
        await ctx.interaction.reply(embedReply(buildInviteInfoEmbed(invite, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
      } catch {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.inviteTitle", "Invite"), ctx.t("utility.info.invalidInvite", "Invalid invite."), ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
  {
    plugin: "utility",
    permission: "can_roleinfo",
    data: new SlashCommandBuilder()
      .setName("role")
      .setDescription("Show information about a role")
      .addRoleOption((o) => o.setName("target").setDescription("Role").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_roleinfo");
      if (!auth) return;
      const role = ctx.interaction.options.getRole("target", true);
      const guildRole = ctx.interaction.guild!.roles.cache.get(role.id);
      if (!guildRole) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.roleTitle", "Role"), ctx.t("utility.info.roleNotFound", "Role not found."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildRoleInfoEmbed(guildRole, ctx.interaction.guild!, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_emojiinfo",
    data: new SlashCommandBuilder()
      .setName("emoji")
      .setDescription("Show information about a custom emoji")
      .addStringOption((o) => o.setName("emoji").setDescription("Emoji").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_emojiinfo");
      if (!auth) return;
      const input = ctx.interaction.options.getString("emoji", true);
      const match = input.match(/<a?:(\w+):(\d+)>/);
      const id = match?.[2] ?? input;
      const emoji = ctx.interaction.guild!.emojis.cache.get(id);
      if (!emoji) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.emojiTitle", "Emoji"), ctx.t("utility.info.customEmojiNotFound", "Custom emoji not found in this server."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildEmojiInfoEmbed(emoji, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_snowflake",
    data: new SlashCommandBuilder()
      .setName("snowflake")
      .setDescription("Decode a Discord snowflake ID")
      .addStringOption((o) => o.setName("id").setDescription("Snowflake ID").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_snowflake");
      if (!auth) return;
      const id = ctx.interaction.options.getString("id", true);
      if (!/^\d{17,20}$/.test(id)) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.snowflakeTitle", "Snowflake"), ctx.t("utility.info.invalidSnowflake", "Invalid snowflake ID."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildSnowflakeInfoEmbed(id, ctx.guildConfig, ctx.client, false, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_roles",
    data: new SlashCommandBuilder()
      .setName("rolelist")
      .setDescription("List roles in this server")
      .addBooleanOption((o) => o.setName("counts").setDescription("Show member counts"))
      .addStringOption((o) =>
        o
          .setName("sort")
          .setDescription("Sort order")
          .addChoices(
            { name: "Name", value: "name" },
            { name: "Position", value: "position" },
            { name: "Member count", value: "memberCount" },
          ),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_roles");
      if (!auth) return;
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      await ctx.interaction.guild!.members.fetch();
      const roles = [...ctx.interaction.guild!.roles.cache.values()];
      await ctx.interaction.editReply(
        embedEdit(
          buildRolesListEmbed(
            roles,
            ctx.interaction.options.getBoolean("counts") ?? false,
            ctx.interaction.options.getString("sort") ?? "name",
            ctx.guildConfig,
            ctx.client,
            ctx.t,
          ),
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_level",
    data: new SlashCommandBuilder()
      .setName("level")
      .setDescription("Show a member's Dreamliner Roles")
      .addUserOption((o) => o.setName("member").setDescription("Member")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_level");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("member") ?? ctx.interaction.user;
      const member = await ctx.interaction.guild!.members.fetch(user.id);
      await ctx.interaction.reply(embedReply(await buildLevelEmbed(ctx.interaction.guildId!, member, ctx.guildConfig, ctx.client, ctx.t), ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_watchdog",
    data: new SlashCommandBuilder()
      .setName("watchdog")
      .setDescription("Show a member's Watchdog risk score and reasons")
      .addUserOption((o) => o.setName("member").setDescription("Member to check").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_watchdog");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("member", true);
      const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      if (!member) {
        await ctx.interaction.reply(resultReply(ctx.t("utility.info.watchdogTitle", "Watchdog"), ctx.t("utility.info.notAMemberOfServer", "That user isn't a member of this server."), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const embed = await buildWatchdogEmbed(member, ctx.guildConfig, ctx.client, ctx.t);
      await ctx.interaction.editReply(embedEdit(embed));
    },
  },
];
