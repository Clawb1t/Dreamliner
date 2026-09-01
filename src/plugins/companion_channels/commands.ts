import { SlashCommandBuilder, type GuildMember, type VoiceBasedChannel } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import {
  claimCompanion,
  ghostCompanion,
  lockCompanion,
  permitTarget,
  postLookingForMembers,
  rejectTarget,
  setCompanionBitrate,
  setCompanionLimit,
  setCompanionName,
  setCompanionRegion,
  setCompanionStatus,
  toggleCompanionNsfw,
  toggleCompanionText,
  transferCompanion,
  type CompanionActionResult,
  type CompanionActor,
} from "./functions/actions.js";
import { loadCompanionConfig } from "./functions/config.js";
import { getRoomByChannel } from "./functions/store.js";

async function resolveVoice(
  member: GuildMember,
  interactionChannel: { isVoiceBased?: () => boolean; id?: string } | null,
): Promise<VoiceBasedChannel | null> {
  if (interactionChannel && "isVoiceBased" in interactionChannel && interactionChannel.isVoiceBased?.()) {
    const room = await getRoomByChannel(member.guild.id, interactionChannel.id!);
    if (room) return interactionChannel as VoiceBasedChannel;
  }
  const current = member.voice.channel;
  if (current) {
    const room = await getRoomByChannel(member.guild.id, current.id);
    if (room) return current;
  }
  return null;
}

export const companionChannelsCommands: SlashCommandDefinition[] = [
  {
    plugin: "companion_channels",
    data: new SlashCommandBuilder()
      .setName("companion")
      .setDescription("Manage your temporary voice channel")
      .addSubcommand((sub) =>
        sub
          .setName("name")
          .setDescription("Rename your room")
          .addStringOption((o) => o.setName("name").setDescription("New channel name").setRequired(true).setMaxLength(100)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("limit")
          .setDescription("Set a user limit")
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("0 = unlimited").setRequired(true).setMinValue(0).setMaxValue(99),
          ),
      )
      .addSubcommand((sub) => sub.setName("lock").setDescription("Lock your room"))
      .addSubcommand((sub) => sub.setName("unlock").setDescription("Unlock your room"))
      .addSubcommand((sub) => sub.setName("claim").setDescription("Claim a room after the owner left"))
      .addSubcommand((sub) =>
        sub
          .setName("permit")
          .setDescription("Allow a user or role to join")
          .addMentionableOption((o) => o.setName("target").setDescription("User or role").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reject")
          .setDescription("Block a user or role and kick them")
          .addMentionableOption((o) => o.setName("target").setDescription("User or role").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Set the voice channel status")
          .addStringOption((o) => o.setName("status").setDescription("Status text").setRequired(true).setMaxLength(500)),
      )
      .addSubcommand((sub) => sub.setName("lfm").setDescription("Post Looking for Members"))
      .addSubcommand((sub) => sub.setName("text").setDescription("Create or remove a linked text channel"))
      .addSubcommand((sub) =>
        sub
          .setName("bitrate")
          .setDescription("Change audio quality")
          .addIntegerOption((o) =>
            o.setName("bitrate").setDescription("Bitrate in kbps").setRequired(true).setMinValue(8).setMaxValue(384),
          ),
      )
      .addSubcommand((sub) => sub.setName("ghost").setDescription("Hide the room from the channel list"))
      .addSubcommand((sub) => sub.setName("unghost").setDescription("Show the room in the channel list"))
      .addSubcommand((sub) =>
        sub
          .setName("nsfw")
          .setDescription("Toggle NSFW on your room")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Mark as NSFW").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("transfer")
          .setDescription("Transfer ownership")
          .addUserOption((o) => o.setName("member").setDescription("New owner").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("region")
          .setDescription("Change the voice region")
          .addStringOption((o) =>
            o
              .setName("region")
              .setDescription("Voice region")
              .setRequired(true)
              .addChoices(
                { name: "Automatic", value: "automatic" },
                { name: "US East", value: "us-east" },
                { name: "US West", value: "us-west" },
                { name: "US Central", value: "us-central" },
                { name: "Europe", value: "rotterdam" },
                { name: "Brazil", value: "brazil" },
                { name: "Singapore", value: "singapore" },
                { name: "Japan", value: "japan" },
                { name: "Sydney", value: "sydney" },
                { name: "India", value: "india" },
              ),
          ),
      ),
    execute: async (ctx) => {
      if (!pluginEnabled(ctx.guildConfig, "companion_channels")) return;
      const member = ctx.interaction.member as GuildMember;
      const actor: CompanionActor = { member, config: loadCompanionConfig(ctx.guildConfig) };
      const channel = await resolveVoice(member, ctx.interaction.channel);
      if (!channel) {
        await ctx.interaction.reply(
          resultReply(
            "Companion",
            "Join your temporary voice channel first, or run this from that channel's chat.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const sub = ctx.interaction.options.getSubcommand();
      let result: CompanionActionResult = { ok: false, message: "Unknown action." };
      if (sub === "name") result = await setCompanionName(actor, channel, ctx.interaction.options.getString("name", true));
      else if (sub === "limit") result = await setCompanionLimit(actor, channel, ctx.interaction.options.getInteger("limit", true));
      else if (sub === "lock") result = await lockCompanion(actor, channel, true);
      else if (sub === "unlock") result = await lockCompanion(actor, channel, false);
      else if (sub === "claim") result = await claimCompanion(actor, channel);
      else if (sub === "permit") {
        const target = ctx.interaction.options.getMentionable("target", true);
        if (!("id" in target)) result = { ok: false, message: "Pick a user or role." };
        else result = await permitTarget(actor, channel, target as never);
      } else if (sub === "reject") {
        const target = ctx.interaction.options.getMentionable("target", true);
        if (!("id" in target)) result = { ok: false, message: "Pick a user or role." };
        else result = await rejectTarget(actor, channel, target as never);
      } else if (sub === "status") result = await setCompanionStatus(actor, channel, ctx.interaction.options.getString("status", true));
      else if (sub === "lfm") result = await postLookingForMembers(actor, channel);
      else if (sub === "text") result = await toggleCompanionText(actor, channel);
      else if (sub === "bitrate") result = await setCompanionBitrate(actor, channel, ctx.interaction.options.getInteger("bitrate", true));
      else if (sub === "ghost") result = await ghostCompanion(actor, channel, true);
      else if (sub === "unghost") result = await ghostCompanion(actor, channel, false);
      else if (sub === "nsfw") {
        const enabled = ctx.interaction.options.getBoolean("enabled", true);
        const current = channel.nsfw;
        if (enabled === current) {
          result = { ok: false, message: enabled ? "The room is already NSFW." : "The room is not NSFW." };
        } else result = await toggleCompanionNsfw(actor, channel);
      } else if (sub === "transfer") {
        result = await transferCompanion(actor, channel, ctx.interaction.options.getUser("member", true));
      } else if (sub === "region") {
        result = await setCompanionRegion(actor, channel, ctx.interaction.options.getString("region", true));
      }

      await ctx.interaction.reply(
        resultReply(
          "Companion",
          result.message,
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: result.ok ? "success" : "error", emoji: result.emoji }),
        ),
      );
    },
  },
];
