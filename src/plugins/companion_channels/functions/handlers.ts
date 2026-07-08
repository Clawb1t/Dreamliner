import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type VoiceBasedChannel, type VoiceState } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zCompanionChannelsConfig } from "../../../config/schemas/plugins.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { renderTemplate } from "../../../core/templates.js";
import {
  getCompanionByChannelId,
  getUserCompanion,
  isHubChannel,
  removeUserCompanion,
  setUserCompanion,
} from "./store.js";

async function deleteEmptyCompanionChannel(guild: Guild, channelId: string, ownerId: string): Promise<void> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isVoiceBased()) {
    await removeUserCompanion(guild.id, ownerId);
    return;
  }

  if (channel.members.size === 0) {
    await channel.delete("Companion channel empty").catch(() => null);
    await removeUserCompanion(guild.id, ownerId);
  }
}

async function createCompanionChannel(member: GuildMember, hub: VoiceBasedChannel, nameTemplate: string): Promise<void> {
  const guild = member.guild;
  const existing = await getUserCompanion(guild.id, member.id);
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (existingChannel?.isVoiceBased()) {
      await member.voice.setChannel(existingChannel).catch(() => null);
      return;
    }
    await removeUserCompanion(guild.id, member.id);
  }

  const channelName = renderTemplate(nameTemplate, { member, guild }).slice(0, 100);
  const created = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: hub.parent,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect],
      },
      {
        id: member.id,
        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers],
      },
    ],
    reason: `Companion channel for ${member.user.tag}`,
  });

  await setUserCompanion(guild.id, member.id, created.id);
  await member.voice.setChannel(created).catch(() => null);
}

export async function handleCompanionVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "companion_channels")) return;

  const pluginConfig = zCompanionChannelsConfig.parse(
    resolvePluginConfig(guildConfig, "companion_channels", getPluginDefaultOverrides("companion_channels")),
  );

  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  if (newState.channelId && (await isHubChannel(guild.id, newState.channelId))) {
    const hub = newState.channel;
    if (hub?.isVoiceBased()) {
      await createCompanionChannel(member, hub, pluginConfig.name_template);
    }
    return;
  }

  const leftChannelId = oldState.channelId;
  if (!leftChannelId || leftChannelId === newState.channelId) return;

  const companion = await getCompanionByChannelId(guild.id, leftChannelId);
  if (companion) {
    await deleteEmptyCompanionChannel(guild, leftChannelId, companion.ownerId);
  }
}
