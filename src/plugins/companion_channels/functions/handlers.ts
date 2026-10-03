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
import { getLogger } from "../../../core/logger.js";
const log = getLogger("companion_channels");

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

// --- Grace period for empty rooms ----------------------------------------------------------------
// An empty room isn't removed straight away: it waits its hub's delete_after_seconds, so someone
// who disconnects or rejoins from another device comes back to the same room. Anyone joining the
// room cancels the wait. Timers live in memory only; on a restart syncGuildCompanion schedules a
// fresh wait for every empty room.

const pendingRemovals = new Map<string, NodeJS.Timeout>();
const pendingKey = (guildId: string, channelId: string) => `${guildId}:${channelId}`;

export function cancelPendingRemoval(guildId: string, channelId: string): void {
  const key = pendingKey(guildId, channelId);
  const timer = pendingRemovals.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingRemovals.delete(key);
}

function hasPendingRemoval(guildId: string, channelId: string): boolean {
  return pendingRemovals.has(pendingKey(guildId, channelId));
}

function graceSecondsFor(setups: ReturnType<typeof enabledSetups>, setupId: string): number {
  return setups.find((item) => item.hub_channel_id === setupId)?.delete_after_seconds ?? 15;
}

/** Removes (or, for dynamic hubs, resets) a room once its wait is over, if nobody came back. */
async function removeRoomIfStillEmpty(guild: Guild, channelId: string): Promise<void> {
  const loaded = await guildCompanion(guild);
  if (!loaded) return;
  const room = await getRoomByChannel(guild.id, channelId);
  if (!room) return;
  const { channel, gone } = await fetchTrackedChannel(guild, channelId);
  if (gone) {
    await forgetMissingRoom(guild, room);
    return;
  }
  if (!channel || channel.members.filter((member) => !member.user.bot).size > 0) return;
  await resetOrDeleteRoom(guild, room, loaded.config, loaded.setups);
  const setup = loaded.setups.find((item) => item.hub_channel_id === room.setupId);
  if (setup) await refillDynamicPool(guild, setup, loaded.config);
}

/** Starts (or restarts) the wait before an empty room is removed; 0 seconds removes it now. */
async function scheduleEmptyRoom(guild: Guild, channelId: string, seconds: number): Promise<void> {
  cancelPendingRemoval(guild.id, channelId);
  if (seconds <= 0) {
    await removeRoomIfStillEmpty(guild, channelId);
    return;
  }
  const key = pendingKey(guild.id, channelId);
  const timer = setTimeout(() => {
    pendingRemovals.delete(key);
    removeRoomIfStillEmpty(guild, channelId).catch((error: unknown) => {
      log.error(`[companion] Failed to remove empty room ${channelId} in ${guild.id}:`, error);
    });
  }, seconds * 1000);
  timer.unref?.();
  pendingRemovals.set(key, timer);
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
      // Someone's back: the room stays.
      cancelPendingRemoval(guild.id, joinedId);
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
          await scheduleEmptyRoom(guild, leftRoom.channelId, graceSecondsFor(setups, leftRoom.setupId));
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
  cancelPendingRemoval(guildId, channel.id);
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
      cancelPendingRemoval(guild.id, room.channelId);
      await restoreLiveRoom(guild, room, channel, config);
      continue;
    }

    const setup = setups.find((item) => item.hub_channel_id === room.setupId);
    if (setup?.type === "dynamic" && !room.ownerId) continue;
    // Runs on boot and on every dashboard save: an empty room still gets its grace period (and
    // one already waiting keeps its timer) rather than vanishing the moment config is saved.
    if (hasPendingRemoval(guild.id, room.channelId)) continue;
    await scheduleEmptyRoom(guild, room.channelId, graceSecondsFor(setups, room.setupId));
  }

  for (const setup of setups) {
    await refillDynamicPool(guild, setup, config);
  }
}

export async function handleCompanionReady(client: Client): Promise<void> {
  const guilds = await client.guilds.fetch().catch(() => client.guilds.cache);
  for (const [guildId] of guilds) {
    await syncGuildCompanion(client, guildId).catch((error) => {
      log.error(`[companion] Failed to sync ${guildId}:`, error);
    });
  }
}
