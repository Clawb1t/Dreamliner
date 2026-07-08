import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
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
      const resolved = await resolveInfoTarget(target, ctx.interaction.guild!, ctx.guildConfig, ctx.client);
      if (!resolved) {
        await ctx.interaction.reply(resultReply("Info", "Could not resolve target.", ctx.ephemeral, slashResultOptions(ctx)));
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
      );
      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
  {
    plugin: "utility",
    permission: "can_server",
    data: new SlashCommandBuilder()
      .setName("server")
      .setDescription("Show information about this server"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_server");
      if (!auth) return;
      await ctx.interaction.reply(embedReply(buildServerInfoEmbed(ctx.interaction.guild!, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
        await ctx.interaction.reply(resultReply("Channel", "Channel not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const guildChannel = await ctx.interaction.guild!.channels.fetch(channel.id);
      if (!guildChannel) {
        await ctx.interaction.reply(resultReply("Channel", "Channel not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildChannelInfoEmbed(guildChannel, ctx.interaction.guild!, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
        await ctx.interaction.reply(resultReply("Message", "Use this command in a text channel.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const id = ctx.interaction.options.getString("message_id", true);
      const message = await channel.messages.fetch(id).catch(() => null);
      if (!message) {
        await ctx.interaction.reply(resultReply("Message", "Message not found in this channel.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildMessageInfoEmbed(message, ctx.interaction.guildId!, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
        await ctx.interaction.reply(embedReply(buildInviteInfoEmbed(invite, ctx.guildConfig, ctx.client), ctx.ephemeral));
      } catch {
        await ctx.interaction.reply(resultReply("Invite", "Invalid invite.", ctx.ephemeral, slashResultOptions(ctx)));
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
        await ctx.interaction.reply(resultReply("Role", "Role not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildRoleInfoEmbed(guildRole, ctx.interaction.guild!, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
        await ctx.interaction.reply(resultReply("Emoji", "Custom emoji not found in this server.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildEmojiInfoEmbed(emoji, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
        await ctx.interaction.reply(resultReply("Snowflake", "Invalid snowflake ID.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      await ctx.interaction.reply(embedReply(buildSnowflakeInfoEmbed(id, ctx.guildConfig, ctx.client), ctx.ephemeral));
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
      .setDescription("Show a member's permission level")
      .addUserOption((o) => o.setName("member").setDescription("Member")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_level");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("member") ?? ctx.interaction.user;
      const member = await ctx.interaction.guild!.members.fetch(user.id);
      await ctx.interaction.reply(embedReply(buildLevelEmbed(member, ctx.guildConfig, ctx.client), ctx.ephemeral));
    },
  },
];
