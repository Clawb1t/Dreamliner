import type { Client, Guild, VoiceBasedChannel, VoiceState } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { enabledSetups, loadCompanionConfig, setupByHub } from "./config.js";
import {
  addJoinRole,
  assignOrCreateRoom,
  claimIdleRoom,
  forgetMissingRoom,
  refillDynamicPool,
  removeJoinRoleIfIdle,
  resetOrDeleteRoom,
  restoreLiveRoom,
  syncTextAccess,
} from "./rooms.js";
import { getRoomByChannel, listGuildRooms, removeRoom } from "./store.js";

async function guildCompanion(guild: Guild): Promise<{
  config: ReturnType<typeof loadCompanionConfig>;
  setups: ReturnType<typeof enabledSetups>;
} | null> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "companion_channels")) return null;
  const config = loadCompanionConfig(guildConfig);
  return { config, setups: enabledSetups(config) };
}

function isUnknownChannelError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && Number(error.code) === 10003);
}

async function fetchTrackedChannel(
  guild: Guild,
  channelId: string,
): Promise<{ channel: VoiceBasedChannel | null; gone: boolean }> {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) return { channel: null, gone: Boolean(channel) };
    return { channel, gone: false };
  } catch (error) {
    return { channel: null, gone: isUnknownChannelError(error) };
  }
}

async function adoptHubWaiters(
  guild: Guild,
  config: ReturnType<typeof loadCompanionConfig>,
  setups: ReturnType<typeof enabledSetups>,
): Promise<void> {
  for (const setup of setups) {
    const hub = await guild.channels.fetch(setup.hub_channel_id).catch(() => null);
    if (!hub?.isVoiceBased()) continue;
    for (const member of hub.members.filter((item) => !item.user.bot).values()) {
      const room = await assignOrCreateRoom(member, hub, setup, config);
      if (room && member.voice.channelId !== room.id) {
        await member.voice.setChannel(room).catch(() => null);
      }
    }
  }
}

export async function handleCompanionVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const loaded = await guildCompanion(guild);
  if (!loaded) return;
  const { config, setups } = loaded;

  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const joinedId = newState.channelId;
  const leftId = oldState.channelId;

  if (joinedId && joinedId !== leftId) {
    const hubSetup = setupByHub(config, joinedId);
    if (hubSetup) {
      const room = await assignOrCreateRoom(member, newState.channel!, hubSetup, config);
      if (room && member.voice.channelId !== room.id) {
        await member.voice.setChannel(room).catch(() => null);
      }
      return;
    }

    const joinedRoom = await getRoomByChannel(guild.id, joinedId);
    if (joinedRoom) {
      if (!joinedRoom.ownerId && newState.channel?.isVoiceBased()) {
        const setup = setups.find((item) => item.hub_channel_id === joinedRoom.setupId);
        if (setup) {
          await claimIdleRoom(member, newState.channel, joinedRoom, setup, config);
        }
      } else {
        await addJoinRole(member, config.join_role_id.trim());
      }
      if (newState.channel) await syncTextAccess(guild, joinedRoom, newState.channel);
    }
  }

  if (leftId && leftId !== joinedId) {
    const leftRoom = await getRoomByChannel(guild.id, leftId);
    if (leftRoom) {
      await removeJoinRoleIfIdle(member, config, joinedId);
      const channel = oldState.channel ?? (await guild.channels.fetch(leftId).catch(() => null));
      if (channel?.isVoiceBased()) {
        await syncTextAccess(guild, leftRoom, channel);
        if (channel.members.filter((item) => !item.user.bot).size === 0) {
          await resetOrDeleteRoom(guild, leftRoom, config, setups);
          const setup = setups.find((item) => item.hub_channel_id === leftRoom.setupId);
          if (setup) await refillDynamicPool(guild, setup, config);
        }
      } else {
        await resetOrDeleteRoom(guild, leftRoom, config, setups);
      }
    }
  }
}

export async function handleCompanionChannelDelete(channel: { id: string; guild?: { id: string } | null }): Promise<void> {
  const guildId = channel.guild?.id;
  if (!guildId) return;
  const room = await getRoomByChannel(guildId, channel.id);
  if (room) await removeRoom(guildId, channel.id);
}

export async function syncGuildCompanion(client: Client, guildId: string, guildConfig?: GuildConfig): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild?.available) return;
  const config = guildConfig
    ? loadCompanionConfig(guildConfig)
    : (await guildCompanion(guild))?.config;
  if (!config) return;
  if (guildConfig && !pluginEnabled(guildConfig, "companion_channels")) return;

  const setups = enabledSetups(config);
  const rooms = await listGuildRooms(guild.id);

  for (const room of rooms) {
    const { channel, gone } = await fetchTrackedChannel(guild, room.channelId);
    if (gone) await forgetMissingRoom(guild, room);
    else if (!channel) continue;
  }

  await adoptHubWaiters(guild, config, setups);

  for (const room of await listGuildRooms(guild.id)) {
    const { channel, gone } = await fetchTrackedChannel(guild, room.channelId);
    if (gone) {
      await forgetMissingRoom(guild, room);
      continue;
    }
    if (!channel) continue;

    const occupants = channel.members.filter((member) => !member.user.bot);
    if (occupants.size > 0) {
      await restoreLiveRoom(guild, room, channel, config);
      continue;
    }

    const setup = setups.find((item) => item.hub_channel_id === room.setupId);
    if (setup?.type === "dynamic" && !room.ownerId) continue;
    await resetOrDeleteRoom(guild, room, config, setups);
  }

  for (const setup of setups) {
    await refillDynamicPool(guild, setup, config);
  }
}

export async function handleCompanionReady(client: Client): Promise<void> {
  const guilds = await client.guilds.fetch().catch(() => client.guilds.cache);
  for (const [guildId] of guilds) {
    await syncGuildCompanion(client, guildId).catch((error) => {
      console.error(`[companion] Failed to sync ${guildId}:`, error);
    });
  }
}
