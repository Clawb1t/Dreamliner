import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type GuildChannel,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { CompanionChannelsConfig, CompanionSetup } from "../../../config/schemas/companion.js";
import { renderTemplate } from "../../../core/templates.js";
import { featureEnabled } from "./config.js";
import { ensureCompanionInterface, postCompanionInterface } from "./panel.js";
import { renderCompanionName } from "./names.js";
import { setVoiceChannelStatus } from "./voiceStatus.js";
import {
  getOwnedRoom,
  getRoomByChannel,
  insertRoom,
  listSetupRooms,
  nextSetupSeq,
  removeRoom,
  updateRoom,
  type CompanionRoomRow,
} from "./store.js";

const CONNECT = PermissionFlagsBits.Connect;
const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const READ = PermissionFlagsBits.ReadMessageHistory;

function bitrateBps(kbps: number, fallback?: number | null): number | undefined {
  if (kbps > 0) return Math.min(384_000, Math.max(8_000, kbps * 1000));
  if (fallback && fallback > 0) return fallback;
  return undefined;
}

function voiceLimit(limit: number, fallback?: number | null): number {
  if (limit > 0) return Math.min(99, limit);
  if (fallback && fallback > 0) return fallback;
  return 0;
}

function parentFor(setup: CompanionSetup, hub: VoiceBasedChannel): string | null {
  return setup.category_id.trim() || hub.parentId;
}

function ownerAllow(config: CompanionChannelsConfig) {
  const allow = [CONNECT, VIEW, SEND, READ];
  if (featureEnabled(config, "manage_channel")) allow.push(PermissionFlagsBits.ManageChannels);
  if (featureEnabled(config, "move_member")) allow.push(PermissionFlagsBits.MoveMembers);
  return allow;
}

async function copyOverwrites(source: GuildChannel): Promise<
  Array<{ id: string; allow: bigint; deny: bigint; type: OverwriteType }>
> {
  return [...source.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield,
    type: overwrite.type,
  }));
}

async function applyOwnerOverwrites(
  channel: GuildChannel,
  member: GuildMember,
  config: CompanionChannelsConfig,
): Promise<void> {
  await channel.permissionOverwrites
    .edit(member.id, {
      Connect: true,
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: featureEnabled(config, "manage_channel") || null,
      MoveMembers: featureEnabled(config, "move_member") || null,
    })
    .catch(() => null);
}

async function setLocked(channel: VoiceBasedChannel, locked: boolean, ownerId: string): Promise<void> {
  await channel.permissionOverwrites
    .edit(channel.guild.roles.everyone, { Connect: locked ? false : null })
    .catch(() => null);
  if (locked && ownerId) {
    await channel.permissionOverwrites.edit(ownerId, { Connect: true, ViewChannel: true }).catch(() => null);
    for (const member of channel.members.values()) {
      await channel.permissionOverwrites.edit(member.id, { Connect: true }).catch(() => null);
    }
  }
}

async function setGhosted(channel: VoiceBasedChannel, ghosted: boolean, ownerId: string): Promise<void> {
  await channel.permissionOverwrites
    .edit(channel.guild.roles.everyone, { ViewChannel: ghosted ? false : null })
    .catch(() => null);
  if (ghosted && ownerId) {
    await channel.permissionOverwrites.edit(ownerId, { ViewChannel: true, Connect: true }).catch(() => null);
    for (const member of channel.members.values()) {
      await channel.permissionOverwrites.edit(member.id, { ViewChannel: true }).catch(() => null);
    }
  }
}

export async function applyDefaultAccess(
  channel: VoiceBasedChannel,
  setup: CompanionSetup,
  ownerId: string,
): Promise<{ locked: boolean; ghosted: boolean }> {
  if (setup.default_lock) await setLocked(channel, true, ownerId);
  if (setup.default_ghost) await setGhosted(channel, true, ownerId);
  return { locked: setup.default_lock, ghosted: setup.default_ghost };
}

async function maybeStatus(channel: VoiceChannel, status: string): Promise<void> {
  const trimmed = status.trim();
  if (!trimmed) return;
  await setVoiceChannelStatus(channel, trimmed.slice(0, 500));
}

async function createLinkedText(opts: {
  voice: VoiceChannel;
  member: GuildMember;
  config: CompanionChannelsConfig;
  setup: CompanionSetup;
}): Promise<string> {
  const { voice, member, config, setup } = opts;
  const parent = voice.parentId;
  const created = await voice.guild.channels.create({
    name: `${voice.name.slice(0, 90)}-chat`,
    type: ChannelType.GuildText,
    parent: parent ?? undefined,
    permissionOverwrites: [
      { id: voice.guild.roles.everyone.id, deny: [VIEW] },
      {
        id: member.id,
        allow: [VIEW, SEND, READ],
      },
      ...(config.text_access_role_id.trim()
        ? [{ id: config.text_access_role_id.trim(), allow: [VIEW, SEND, READ] }]
        : []),
    ],
    reason: `Companion text for ${member.user.tag}`,
  });

  for (const occupant of voice.members.values()) {
    await created.permissionOverwrites.edit(occupant.id, { ViewChannel: true, SendMessages: true }).catch(() => null);
  }

  const message = config.text_channel_message.trim();
  if (message) {
    const content = renderTemplate(message, {
      member,
      guild: voice.guild,
      extra: { channel: `<#${voice.id}>` },
    }).slice(0, 2000);
    if (content) await created.send(content).catch(() => null);
  }

  void setup;
  return created.id;
}

async function deleteLinkedText(guild: Guild, textChannelId: string): Promise<void> {
  if (!textChannelId) return;
  const channel = await guild.channels.fetch(textChannelId).catch(() => null);
  if (channel) await channel.delete("Companion text channel empty").catch(() => null);
}

export async function syncTextAccess(guild: Guild, room: CompanionRoomRow, voice: VoiceBasedChannel): Promise<void> {
  if (!room.textChannelId) return;
  const text = await guild.channels.fetch(room.textChannelId).catch(() => null);
  if (!text || !text.isTextBased() || text.isDMBased() || !("permissionOverwrites" in text)) return;
  const allowed = new Set(voice.members.map((member) => member.id));
  if (room.ownerId) allowed.add(room.ownerId);
  for (const overwrite of text.permissionOverwrites.cache.values()) {
    if (overwrite.type !== OverwriteType.Member) continue;
    if (!allowed.has(overwrite.id)) {
      await text.permissionOverwrites.delete(overwrite.id).catch(() => null);
    }
  }
  for (const id of allowed) {
    await text.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true }).catch(() => null);
  }
}

export async function addJoinRole(member: GuildMember, roleId: string): Promise<void> {
  if (!roleId) return;
  await member.roles.add(roleId, "Joined a companion channel").catch(() => null);
}

export async function removeJoinRoleIfIdle(
  member: GuildMember,
  config: CompanionChannelsConfig,
  nextChannelId: string | null,
): Promise<void> {
  const roleId = config.join_role_id.trim();
  if (!roleId) return;
  if (nextChannelId) {
    const next = await getRoomByChannel(member.guild.id, nextChannelId);
    if (next) return;
  }
  await member.roles.remove(roleId, "Left companion channels").catch(() => null);
}

async function logRoom(guild: Guild, config: CompanionChannelsConfig, text: string): Promise<void> {
  const channelId = config.log_channel_id.trim();
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased() && "send" in channel) {
    await channel.send(text.slice(0, 2000)).catch(() => null);
  }
}

async function createVoiceChannel(opts: {
  guild: Guild;
  member: GuildMember | null;
  hub: VoiceBasedChannel;
  setup: CompanionSetup;
  config: CompanionChannelsConfig;
  name: string;
  seq: number;
  ownerId: string;
}): Promise<VoiceChannel | null> {
  const { guild, member, hub, setup, config, name, seq, ownerId } = opts;
  const parentId = parentFor(setup, hub);
  const parent = parentId ? await guild.channels.fetch(parentId).catch(() => null) : null;
  const source =
    setup.permission_source === "hub"
      ? hub
      : parent && parent.type === ChannelType.GuildCategory
        ? (parent as CategoryChannel)
        : hub;

  const overwrites = await copyOverwrites(source as GuildChannel);
  if (member) {
    overwrites.push({
      id: member.id,
      allow: ownerAllow(config).reduce((bits, flag) => bits | flag, 0n),
      deny: 0n,
      type: OverwriteType.Member,
    });
  }

  const clonedLimit = hub.isVoiceBased() ? hub.userLimit : 0;
  const clonedBitrate = hub.isVoiceBased() ? hub.bitrate : null;
  const useClone = setup.type === "clone";

  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: parentId ?? undefined,
    userLimit: voiceLimit(setup.user_limit, useClone ? clonedLimit : 0),
    bitrate: bitrateBps(setup.bitrate, useClone ? clonedBitrate : null),
    nsfw: setup.default_nsfw,
    rtcRegion: setup.region.trim() || (useClone ? hub.rtcRegion ?? undefined : undefined),
    permissionOverwrites: overwrites,
    reason: member ? `Companion channel for ${member.user.tag}` : `Dynamic companion room #${seq}`,
  });

  if (!created.isVoiceBased()) return null;
  const voice = created as VoiceChannel;
  if (setup.default_status) await maybeStatus(voice, setup.default_status);
  await insertRoom({
    guildId: guild.id,
    channelId: voice.id,
    ownerId,
    setupId: setup.hub_channel_id,
    textChannelId: "",
    interfaceMessageId: "",
    locked: false,
    ghosted: false,
    seq,
  });
  return voice;
}

export async function assignOrCreateRoom(
  member: GuildMember,
  hub: VoiceBasedChannel,
  setup: CompanionSetup,
  config: CompanionChannelsConfig,
): Promise<VoiceBasedChannel | null> {
  const existing = await getOwnedRoom(member.guild.id, member.id);
  if (existing) {
    const channel = await member.guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.isVoiceBased()) return channel;
    await removeRoom(member.guild.id, existing.channelId);
  }

  if (setup.type === "dynamic") {
    const idle = (await listSetupRooms(member.guild.id, setup.hub_channel_id)).find((room) => !room.ownerId);
    if (idle) {
      const channel = await member.guild.channels.fetch(idle.channelId).catch(() => null);
      if (channel?.isVoiceBased()) {
        await claimIdleRoom(member, channel, idle, setup, config);
        return channel;
      }
      await removeRoom(member.guild.id, idle.channelId);
    }
  }

  const seq = await nextSetupSeq(member.guild.id, setup.hub_channel_id);
  let name =
    setup.type === "clone"
      ? hub.name.slice(0, 100)
      : renderCompanionName(setup.name_template, { member, guild: member.guild, seq });
  if (setup.type === "sequential" && !setup.name_template.includes("{seq}")) {
    name = `${name} ${seq}`.slice(0, 100);
  }

  const voice = await createVoiceChannel({
    guild: member.guild,
    member,
    hub,
    setup,
    config,
    name,
    seq,
    ownerId: member.id,
  });
  if (!voice) return null;

  const access = await applyDefaultAccess(voice, setup, member.id);
  await updateRoom(member.guild.id, voice.id, access);

  const autoText = setup.auto_text || featureEnabled(config, "autotext");
  if (autoText) {
    const textId = await createLinkedText({ voice, member, config, setup }).catch(() => "");
    if (textId) await updateRoom(member.guild.id, voice.id, { textChannelId: textId });
  }

  if (featureEnabled(config, "interface")) {
    const messageId = await postCompanionInterface(voice, config).catch(() => "");
    if (messageId) await updateRoom(member.guild.id, voice.id, { interfaceMessageId: messageId });
  }

  await addJoinRole(member, config.join_role_id.trim());
  await logRoom(member.guild, config, `Created companion room ${voice} for ${member}.`);
  return voice;
}

export async function claimIdleRoom(
  member: GuildMember,
  channel: VoiceBasedChannel,
  room: CompanionRoomRow,
  setup: CompanionSetup,
  config: CompanionChannelsConfig,
): Promise<void> {
  const name =
    setup.type === "clone"
      ? channel.name
      : renderCompanionName(setup.name_template, { member, guild: member.guild, seq: room.seq });
  await channel.setName(name).catch(() => null);
  await applyOwnerOverwrites(channel, member, config);
  const access = await applyDefaultAccess(channel, setup, member.id);
  await updateRoom(member.guild.id, channel.id, {
    ownerId: member.id,
    locked: access.locked,
    ghosted: access.ghosted,
  });

  const autoText = setup.auto_text || featureEnabled(config, "autotext");
  if (autoText && !room.textChannelId && channel.type === ChannelType.GuildVoice) {
    const textId = await createLinkedText({
      voice: channel as VoiceChannel,
      member,
      config,
      setup,
    }).catch(() => "");
    if (textId) await updateRoom(member.guild.id, channel.id, { textChannelId: textId });
  }
  if (featureEnabled(config, "interface") && !room.interfaceMessageId && "send" in channel) {
    const messageId = await postCompanionInterface(channel as VoiceChannel, config).catch(() => "");
    if (messageId) await updateRoom(member.guild.id, channel.id, { interfaceMessageId: messageId });
  }
  await addJoinRole(member, config.join_role_id.trim());
}

export async function resetOrDeleteRoom(
  guild: Guild,
  room: CompanionRoomRow,
  config: CompanionChannelsConfig,
  setups: CompanionSetup[],
): Promise<void> {
  const setup = setups.find((item) => item.hub_channel_id === room.setupId);
  const channel = await guild.channels.fetch(room.channelId).catch(() => null);

  if (setup?.type === "dynamic" && channel?.isVoiceBased()) {
    const idleCount = (await listSetupRooms(guild.id, setup.hub_channel_id)).filter(
      (item) => !item.ownerId && item.channelId !== room.channelId,
    ).length;
    if (idleCount < setup.dynamic_ready) {
      await deleteLinkedText(guild, room.textChannelId);
      const idleName = renderCompanionName(setup.name_template, {
        guild,
        seq: room.seq,
        idle: true,
      });
      await channel.setName(idleName).catch(() => null);
      if (room.ownerId) {
        await channel.permissionOverwrites.delete(room.ownerId).catch(() => null);
      }
      await setLocked(channel, false, "");
      await setGhosted(channel, false, "");
      await updateRoom(guild.id, room.channelId, {
        ownerId: "",
        textChannelId: "",
        interfaceMessageId: "",
        locked: false,
        ghosted: false,
      });
      return;
    }
  }

  await deleteLinkedText(guild, room.textChannelId);
  if (channel) await channel.delete("Companion channel empty").catch(() => null);
  await removeRoom(guild.id, room.channelId);
  await logRoom(guild, config, `Removed companion room <#${room.channelId}>.`);
}

export async function refillDynamicPool(
  guild: Guild,
  setup: CompanionSetup,
  config: CompanionChannelsConfig,
): Promise<void> {
  if (setup.type !== "dynamic" || !setup.enabled) return;
  const hub = await guild.channels.fetch(setup.hub_channel_id).catch(() => null);
  if (!hub?.isVoiceBased()) return;

  const rooms = await listSetupRooms(guild.id, setup.hub_channel_id);
  const idle = rooms.filter((room) => !room.ownerId);
  const missing = setup.dynamic_ready - idle.length;
  for (let i = 0; i < missing; i++) {
    const seq = await nextSetupSeq(guild.id, setup.hub_channel_id);
    const name = renderCompanionName(setup.name_template, { guild, seq, idle: true });
    await createVoiceChannel({
      guild,
      member: null,
      hub,
      setup,
      config,
      name,
      seq,
      ownerId: "",
    });
  }
}

export async function ensureLinkedText(
  member: GuildMember,
  voice: VoiceChannel,
  room: CompanionRoomRow,
  config: CompanionChannelsConfig,
  setup: CompanionSetup | undefined,
): Promise<string> {
  if (room.textChannelId) {
    const existing = await member.guild.channels.fetch(room.textChannelId).catch(() => null);
    if (existing) return existing.id;
  }
  const textId = await createLinkedText({
    voice,
    member,
    config,
    setup: setup ?? {
      enabled: true,
      name: "",
      hub_channel_id: room.setupId,
      type: "default",
      name_template: "{user_display}'s channel",
      user_limit: 0,
      bitrate: 0,
      category_id: "",
      permission_source: "category",
      editable: true,
      auto_text: true,
      default_lock: false,
      default_ghost: false,
      default_nsfw: false,
      default_status: "",
      region: "",
      dynamic_ready: 3,
    },
  });
  await updateRoom(member.guild.id, voice.id, { textChannelId: textId });
  return textId;
}

export async function clearLinkedText(guild: Guild, room: CompanionRoomRow): Promise<void> {
  await deleteLinkedText(guild, room.textChannelId);
  await updateRoom(guild.id, room.channelId, { textChannelId: "" });
}

export async function forgetMissingRoom(guild: Guild, room: CompanionRoomRow): Promise<void> {
  await deleteLinkedText(guild, room.textChannelId);
  await removeRoom(guild.id, room.channelId);
}

export async function restoreLiveRoom(
  guild: Guild,
  room: CompanionRoomRow,
  channel: VoiceBasedChannel,
  config: CompanionChannelsConfig,
): Promise<void> {
  const occupants = channel.members.filter((member) => !member.user.bot);
  for (const member of occupants.values()) {
    await addJoinRole(member, config.join_role_id.trim());
  }
  if (occupants.size === 0) return;

  const messageId = await ensureCompanionInterface(channel, room.interfaceMessageId, config).catch(() => "");
  if (messageId && messageId !== room.interfaceMessageId) {
    await updateRoom(guild.id, room.channelId, { interfaceMessageId: messageId });
  }
  await syncTextAccess(guild, room, channel);
}

export { setGhosted, setLocked };
