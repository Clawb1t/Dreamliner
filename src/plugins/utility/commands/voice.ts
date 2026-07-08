import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { trimLines } from "../../../core/embeds.js";
import { requireUtilityPermission, MoveMembers, ManageNicknames, requireDiscordPerm } from "../functions/commandHelpers.js";
import { canActOn } from "../functions/members.js";
import { markForcedVoiceAction } from "../../../core/logging/voice.js";
import {
  buildVoiceForceDisconnectLog,
  buildVoiceForceMoveAllLog,
  buildVoiceForceMoveLog,
} from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";

export const voiceCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_vcmove",
    data: new SlashCommandBuilder()
      .setName("voice")
      .setDescription("Voice channel management")
      .addSubcommand((sub) =>
        sub
          .setName("move")
          .setDescription("Move a member to a voice channel")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Destination voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("move-all")
          .setDescription("Move all members from one voice channel to another")
          .addChannelOption((o) =>
            o.setName("from").setDescription("Source voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true),
          )
          .addChannelOption((o) =>
            o.setName("to").setDescription("Destination voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("disconnect")
          .setDescription("Disconnect a member from voice")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const permission = sub === "disconnect" ? "can_vckick" : "can_vcmove";
      const auth = await requireUtilityPermission(ctx, permission);
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, MoveMembers, "Move Members", ctx.ephemeral, ctx.guildConfig))) return;

      if (sub === "move") {
        const user = ctx.interaction.options.getUser("member", true);
        const channel = ctx.interaction.options.getChannel("channel", true);
        const member = await ctx.interaction.guild!.members.fetch(user.id);
        if (!canActOn(auth.member, member, ctx.guildConfig)) {
          await ctx.interaction.reply(resultReply("Voice move", "You cannot act on this member.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const dest = await ctx.interaction.guild!.channels.fetch(channel.id);
        if (!dest?.isVoiceBased()) {
          await ctx.interaction.reply(resultReply("Voice move", "Destination must be a voice channel.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const fromChannelId = member.voice.channelId;
        const fromChannelName = member.voice.channel?.name;
        markForcedVoiceAction(ctx.interaction.guildId!, member.id);
        await member.voice.setChannel(dest.id);
        await sendModerationLog(
          ctx.interaction.client,
          ctx.guildConfig,
          buildVoiceForceMoveLog({
            target: { id: member.id, name: member.user.username, avatarUrl: member.displayAvatarURL({ size: 128 }) },
            mod: { id: auth.member.id, name: auth.member.user.username, avatarUrl: auth.member.displayAvatarURL({ size: 128 }) },
            fromChannel: fromChannelId ? { id: fromChannelId, name: fromChannelName } : null,
            toChannel: { id: dest.id, name: dest.name },
          }),
        );
        await ctx.interaction.reply(
          resultReply(
            "Voice move",
            trimLines(`
              Member: **${member.displayName}**
              Channel: **${dest.name}**
            `),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "move-all") {
        const fromCh = await ctx.interaction.guild!.channels.fetch(ctx.interaction.options.getChannel("from", true).id);
        const toCh = await ctx.interaction.guild!.channels.fetch(ctx.interaction.options.getChannel("to", true).id);
        if (!fromCh?.isVoiceBased() || !toCh?.isVoiceBased()) {
          await ctx.interaction.reply(resultReply("Voice move-all", "Both channels must be voice channels.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        let moved = 0;
        for (const [, member] of fromCh.members) {
          if (canActOn(auth.member, member, ctx.guildConfig)) {
            markForcedVoiceAction(ctx.interaction.guildId!, member.id);
            await member.voice.setChannel(toCh.id).catch(() => null);
            moved++;
          }
        }
        await sendModerationLog(
          ctx.interaction.client,
          ctx.guildConfig,
          buildVoiceForceMoveAllLog({
            mod: { id: auth.member.id, name: auth.member.user.username, avatarUrl: auth.member.displayAvatarURL({ size: 128 }) },
            count: moved,
            fromChannel: { id: fromCh.id, name: fromCh.name },
            toChannel: { id: toCh.id, name: toCh.name },
          }),
        );
        await ctx.interaction.reply(
          resultReply(
            "Voice move-all",
            trimLines(`
              From: **${fromCh.name}**
              To: **${toCh.name}**
              Moved: **${moved}** member(s)
            `),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "disconnect") {
        const user = ctx.interaction.options.getUser("member", true);
        const member = await ctx.interaction.guild!.members.fetch(user.id);
        if (!canActOn(auth.member, member, ctx.guildConfig)) {
          await ctx.interaction.reply(resultReply("Voice disconnect", "You cannot act on this member.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        if (!member.voice.channel) {
          await ctx.interaction.reply(resultReply("Voice disconnect", "Member is not in a voice channel.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const channelName = member.voice.channel.name;
        const channelId = member.voice.channel.id;
        markForcedVoiceAction(ctx.interaction.guildId!, member.id);
        await member.voice.disconnect();
        await sendModerationLog(
          ctx.interaction.client,
          ctx.guildConfig,
          buildVoiceForceDisconnectLog({
            target: { id: member.id, name: member.user.username, avatarUrl: member.displayAvatarURL({ size: 128 }) },
            mod: { id: auth.member.id, name: auth.member.user.username, avatarUrl: auth.member.displayAvatarURL({ size: 128 }) },
            channel: { id: channelId, name: channelName },
          }),
        );
        await ctx.interaction.reply(
          resultReply(
            "Voice disconnect",
            trimLines(`
              Member: **${member.displayName}**
              Disconnected from: **${channelName}**
            `),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
      }
    },
  },
];

export const nicknameCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_nickname",
    data: new SlashCommandBuilder()
      .setName("nickname")
      .setDescription("Manage member nicknames")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set a member's nickname")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
          .addStringOption((o) => o.setName("name").setDescription("New nickname (2-32 chars)").setRequired(true).setMinLength(2).setMaxLength(32)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reset")
          .setDescription("Reset a member's nickname")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("View a member's nickname")
          .addUserOption((o) => o.setName("member").setDescription("Member")),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_nickname");
      if (!auth) return;

      const sub = ctx.interaction.options.getSubcommand();
      const user = ctx.interaction.options.getUser("member") ?? ctx.interaction.user;
      const member = await ctx.interaction.guild!.members.fetch(user.id);

      if (sub === "view") {
        const nick = member.nickname ?? member.user.username;
        await ctx.interaction.reply(
          resultReply(
            "Nickname",
            trimLines(`
              Member: **${member.displayName}**
              Nickname: **${nick}**
            `),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (user.id !== ctx.interaction.user.id) {
        if (!(await requireDiscordPerm(ctx.interaction, ManageNicknames, "Manage Nicknames", ctx.ephemeral, ctx.guildConfig))) return;
        if (!canActOn(auth.member, member, ctx.guildConfig)) {
          await ctx.interaction.reply(resultReply("Nickname", "You cannot act on this member.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
      }

      if (sub === "set") {
        const name = ctx.interaction.options.getString("name", true);
        await member.setNickname(name);
        await ctx.interaction.reply(
          resultReply(
            "Nickname",
            trimLines(`
              Member: **${member.displayName}**
              New nickname: **${name}**
            `),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "reset") {
        await member.setNickname(null);
        await ctx.interaction.reply(
          resultReply("Nickname", `Reset nickname for **${member.displayName}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
