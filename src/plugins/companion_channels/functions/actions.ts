import {
  ChannelType,
  type GuildMember,
  type Role,
  type User,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { CompanionChannelsConfig, CompanionFeatureKey, CompanionSetup } from "../../../config/schemas/companion.js";
import { featureEnabled, setupByHub } from "./config.js";
import {
  clearLinkedText,
  ensureLinkedText,
  setGhosted,
  setLocked,
} from "./rooms.js";
import { getOwnedRoom, getRoomByChannel, updateRoom, type CompanionRoomRow } from "./store.js";

export type CompanionActor = {
  member: GuildMember;
  config: CompanionChannelsConfig;
};

export type CompanionActionResult = {
  ok: boolean;
  message: string;
};

function ok(message: string): CompanionActionResult {
  return { ok: true, message };
}

function fail(message: string): CompanionActionResult {
  return { ok: false, message };
}

type ResolvedRoom = {
  room: CompanionRoomRow;
  channel: VoiceBasedChannel;
  setup?: CompanionSetup;
};

async function requireManagedRoom(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  feature?: CompanionFeatureKey,
): Promise<ResolvedRoom | CompanionActionResult> {
  const resolved = await resolveCompanionRoom(actor, channel);
  if ("error" in resolved) return fail(resolved.error);
  const denied = canManageRoom(actor, resolved.room, feature);
  if (denied) return fail(denied);
  return resolved;
}

function isActionResult(value: ResolvedRoom | CompanionActionResult): value is CompanionActionResult {
  return "ok" in value;
}

function isStaff(actor: CompanionActor): boolean {
  const roleId = actor.config.staff_role_id.trim();
  return Boolean(roleId && actor.member.roles.cache.has(roleId));
}

export async function resolveCompanionRoom(
  actor: CompanionActor,
  channel: VoiceBasedChannel | null,
): Promise<{ room: CompanionRoomRow; channel: VoiceBasedChannel; setup?: CompanionSetup } | { error: string }> {
  if (!channel?.isVoiceBased()) return { error: "Use this in a temporary voice channel." };
  const room = await getRoomByChannel(actor.member.guild.id, channel.id);
  if (!room) return { error: "This is not a companion channel." };
  const setup = room.setupId ? setupByHub(actor.config, room.setupId) : undefined;
  return { room, channel, setup };
}

export function canManageRoom(actor: CompanionActor, room: CompanionRoomRow, feature?: CompanionFeatureKey): string | null {
  if (feature && !featureEnabled(actor.config, feature) && !isStaff(actor)) {
    return "That control is turned off for this server.";
  }
  if (isStaff(actor) || room.ownerId === actor.member.id) return null;
  if (feature && String(feature) === "claim") return null;
  return "Only the room owner can do that.";
}

type VoiceWithStatus = VoiceBasedChannel & {
  setStatus?: (status: string | null) => Promise<unknown>;
};

function asVoice(channel: VoiceBasedChannel): VoiceChannel | null {
  return channel.type === ChannelType.GuildVoice ? (channel as VoiceChannel) : null;
}

async function setVoiceStatus(channel: VoiceBasedChannel, status: string | null): Promise<boolean> {
  const voice = channel as VoiceWithStatus;
  if (typeof voice.setStatus !== "function") return false;
  await voice.setStatus(status);
  return true;
}

export async function setCompanionName(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  name: string,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "name");
  if (isActionResult(resolved)) return resolved;
  if (resolved.setup && !resolved.setup.editable && !isStaff(actor)) return fail("This setup does not allow renaming.");
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) return fail("Give the channel a name.");
  await resolved.channel.setName(trimmed);
  return ok(`Renamed the room to **${trimmed}**.`);
}

export async function setCompanionLimit(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  limit: number,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "limit");
  if (isActionResult(resolved)) return resolved;
  if (resolved.setup && !resolved.setup.editable && !isStaff(actor)) {
    return fail("This setup does not allow changing the limit.");
  }
  const value = Math.max(0, Math.min(99, Math.floor(limit)));
  await resolved.channel.setUserLimit(value);
  return ok(value === 0 ? "Removed the user limit." : `User limit set to **${value}**.`);
}

export async function setCompanionBitrate(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  kbps: number,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "bitrate");
  if (isActionResult(resolved)) return resolved;
  const value = Math.max(8, Math.min(384, Math.floor(kbps)));
  await resolved.channel.setBitrate(value * 1000);
  return ok(`Bitrate set to **${value} kbps**.`);
}

export async function setCompanionStatus(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  status: string,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "status");
  if (isActionResult(resolved)) return resolved;
  const trimmed = status.trim().slice(0, 500);
  const applied = await setVoiceStatus(resolved.channel, trimmed || null);
  if (!applied) return fail("Could not set a status on this channel.");
  return ok(trimmed ? `Status set to **${trimmed}**.` : "Cleared the channel status.");
}

export async function setCompanionRegion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  region: string,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "region");
  if (isActionResult(resolved)) return resolved;
  const value = region.trim().toLowerCase();
  await resolved.channel.setRTCRegion(value && value !== "automatic" ? value : null);
  return ok(value && value !== "automatic" ? `Region set to **${value}**.` : "Region set to automatic.");
}

export async function toggleCompanionNsfw(actor: CompanionActor, channel: VoiceBasedChannel): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "nsfw");
  if (isActionResult(resolved)) return resolved;
  const next = !resolved.channel.nsfw;
  await resolved.channel.setNSFW(next);
  return ok(next ? "Marked the room as NSFW." : "Removed the NSFW mark.");
}

export async function lockCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  locked: boolean,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "lock");
  if (isActionResult(resolved)) return resolved;
  await setLocked(resolved.channel, locked, resolved.room.ownerId || actor.member.id);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { locked });
  return ok(locked ? "Locked the room. New people cannot join." : "Unlocked the room.");
}

export async function ghostCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  ghosted: boolean,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "ghost");
  if (isActionResult(resolved)) return resolved;
  await setGhosted(resolved.channel, ghosted, resolved.room.ownerId || actor.member.id);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { ghosted });
  return ok(ghosted ? "Ghosted the room. It is hidden from the channel list." : "The room is visible again.");
}

function targetLabel(target: User | Role | GuildMember): string {
  if ("username" in target) return target.username;
  if ("user" in target) return target.user.username;
  return target.name;
}

export async function permitTarget(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  target: User | Role | GuildMember,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "permit");
  if (isActionResult(resolved)) return resolved;
  await resolved.channel.permissionOverwrites
    .edit(target.id, { Connect: true, ViewChannel: true })
    .catch(() => null);
  return ok(`Permitted **${targetLabel(target)}** to join.`);
}

export async function rejectTarget(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  target: User | Role | GuildMember,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "reject");
  if (isActionResult(resolved)) return resolved;
  await resolved.channel.permissionOverwrites
    .edit(target.id, { Connect: false, ViewChannel: resolved.room.ghosted ? false : null })
    .catch(() => null);

  if ("username" in target || "user" in target) {
    const userId = "user" in target ? target.user.id : target.id;
    const member = await actor.member.guild.members.fetch(userId).catch(() => null);
    if (member?.voice.channelId === resolved.channel.id) {
      await member.voice.disconnect("Rejected from companion channel").catch(() => null);
    }
    return ok(`Rejected **${targetLabel(target)}**.`);
  }

  for (const member of resolved.channel.members.values()) {
    if (member.roles.cache.has(target.id) && member.id !== resolved.room.ownerId) {
      await member.voice.disconnect("Rejected from companion channel").catch(() => null);
    }
  }
  return ok(`Rejected **${target.name}**.`);
}

export async function inviteUser(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  user: User,
  message?: string,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "invite");
  if (isActionResult(resolved)) return resolved;
  await resolved.channel.permissionOverwrites.edit(user.id, { Connect: true, ViewChannel: true }).catch(() => null);
  const invite = await resolved.channel
    .createInvite({ maxAge: 3600, maxUses: 1, unique: true, reason: `Companion invite from ${actor.member.user.tag}` })
    .catch(() => null);
  const note = message?.trim();
  const body = [
    `**${actor.member.displayName}** invited you to join ${resolved.channel} in **${actor.member.guild.name}**.`,
    note,
    invite?.url,
  ]
    .filter(Boolean)
    .join("\n");
  const sent = await user.send(body).catch(() => null);
  if (!sent) return fail("Could not DM that member. They may have DMs closed.");
  return ok(`Invited **${user.username}**.`);
}

export async function transferCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  user: User,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "transfer");
  if (isActionResult(resolved)) return resolved;
  const member = await actor.member.guild.members.fetch(user.id).catch(() => null);
  if (!member) return fail("Could not find that member.");
  if (resolved.room.ownerId) {
    await resolved.channel.permissionOverwrites.delete(resolved.room.ownerId).catch(() => null);
  }
  await resolved.channel.permissionOverwrites
    .edit(member.id, {
      Connect: true,
      ViewChannel: true,
      ManageChannels: featureEnabled(actor.config, "manage_channel") || null,
      MoveMembers: featureEnabled(actor.config, "move_member") || null,
    })
    .catch(() => null);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { ownerId: member.id });
  return ok(`Ownership transferred to **${member.displayName}**.`);
}

export async function claimCompanion(actor: CompanionActor, channel: VoiceBasedChannel): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "claim");
  if (isActionResult(resolved)) return resolved;
  if (resolved.room.ownerId === actor.member.id) return fail("You already own this room.");
  if (resolved.room.ownerId) {
    const ownerInChannel = resolved.channel.members.has(resolved.room.ownerId);
    if (ownerInChannel && !isStaff(actor)) return fail("The owner is still in the room.");
    await resolved.channel.permissionOverwrites.delete(resolved.room.ownerId).catch(() => null);
  }
  const already = await getOwnedRoom(actor.member.guild.id, actor.member.id);
  if (already && already.channelId !== resolved.channel.id) {
    return fail("You already own another companion room.");
  }
  await resolved.channel.permissionOverwrites
    .edit(actor.member.id, {
      Connect: true,
      ViewChannel: true,
      ManageChannels: featureEnabled(actor.config, "manage_channel") || null,
      MoveMembers: featureEnabled(actor.config, "move_member") || null,
    })
    .catch(() => null);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { ownerId: actor.member.id });
  return ok("You claimed this room.");
}

export async function toggleCompanionText(actor: CompanionActor, channel: VoiceBasedChannel): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "text");
  if (isActionResult(resolved)) return resolved;
  const voice = asVoice(resolved.channel);
  if (!voice) return fail("Text channels can only be linked to a voice room.");
  if (resolved.room.textChannelId) {
    await clearLinkedText(actor.member.guild, resolved.room);
    return ok("Removed the linked text channel.");
  }
  const textId = await ensureLinkedText(actor.member, voice, resolved.room, actor.config, resolved.setup);
  return ok(`Created a linked text channel: <#${textId}>.`);
}

export async function postLookingForMembers(actor: CompanionActor, channel: VoiceBasedChannel): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, "lfm");
  if (isActionResult(resolved)) return resolved;
  const lfmId = actor.config.lfm_channel_id.trim();
  if (!lfmId) return fail("No Looking for Members channel is configured.");
  const lfm = await actor.member.guild.channels.fetch(lfmId).catch(() => null);
  if (!lfm?.isTextBased() || !("send" in lfm)) return fail("The LFM channel is missing.");
  const invite = await resolved.channel
    .createInvite({ maxAge: 1800, maxUses: 0, unique: true })
    .catch(() => null);
  await lfm.send({
    content: `**${actor.member.displayName}** is looking for members in ${resolved.channel}.${invite ? `\n${invite.url}` : ""}`,
  });
  return ok("Posted in the Looking for Members channel.");
}
