import {
  ChannelType,
  type GuildMember,
  type Role,
  type User,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { CompanionChannelsConfig, CompanionFeatureKey, CompanionSetup } from "../../../config/schemas/companion.js";
import type { Translator } from "../../../i18n/index.js";
import { featureEnabled, setupByHub } from "./config.js";
import {
  clearLinkedText,
  ensureLinkedText,
  setGhosted,
  setLocked,
} from "./rooms.js";
import { getOwnedRoom, getRoomByChannel, updateRoom, type CompanionRoomRow } from "./store.js";
import { setVoiceChannelStatus } from "../../../core/voiceChannelStatus.js";

export type CompanionActor = {
  member: GuildMember;
  config: CompanionChannelsConfig;
};

export type CompanionActionResult = {
  ok: boolean;
  message: string;
  emoji?: string;
};

/** Icons for each distinct companion-channel action's success reply (see app-emojis.txt). */
const COMPANION_ICON = {
  rename: "<:icons_updatechannel:1544417815807922246>",
  limit: "<:icons_people:1544417371215626262>",
  bitrate: "<:icons_headphone:1544417301321875536>",
  status: "<:icons_pin:1544417374927716513>",
  region: "<:icons_globe:1544417296703815710>",
  nsfw: "<:icons_18:1544418077377171586>",
  lock: "<:icons_locked:1544417721612247171>",
  unlock: "<:icons_unlock:1544417749617610852>",
  ghost: "<:icons_offline:1544417569438433332>",
  unghost: "<:icons_online:1544417572152283136>",
  permit: "<:icons_invite:1544417309345710080>",
  reject: "<:icons_kick2:1544417325405437982>",
  transfer: "<:icons_transferownership:1544417451780079676>",
  claim: "<:icons_owner:1544417364307607563>",
  textLink: "<:icons_createchannel:1544417835932061766>",
  textUnlink: "<:icons_deletechannel:1544417846832930886>",
  lfm: "<:icons_friends:1544417709188587571>",
} as const;

function ok(message: string, emoji?: string): CompanionActionResult {
  return { ok: true, message, emoji };
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
  t: Translator,
  feature?: CompanionFeatureKey,
): Promise<ResolvedRoom | CompanionActionResult> {
  const resolved = await resolveCompanionRoom(actor, channel, t);
  if ("error" in resolved) return fail(resolved.error);
  const denied = canManageRoom(actor, resolved.room, t, feature);
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
  t: Translator,
): Promise<{ room: CompanionRoomRow; channel: VoiceBasedChannel; setup?: CompanionSetup } | { error: string }> {
  if (!channel?.isVoiceBased())
    return { error: t("companion_channels.error.useInTempVoiceChannel", "Use this in a temporary voice channel.") };
  const room = await getRoomByChannel(actor.member.guild.id, channel.id);
  if (!room) return { error: t("companion_channels.error.notCompanionChannel", "This is not a companion channel.") };
  const setup = room.setupId ? setupByHub(actor.config, room.setupId) : undefined;
  return { room, channel, setup };
}

export function canManageRoom(
  actor: CompanionActor,
  room: CompanionRoomRow,
  t: Translator,
  feature?: CompanionFeatureKey,
): string | null {
  if (feature && !featureEnabled(actor.config, feature) && !isStaff(actor)) {
    return t("companion_channels.error.controlDisabled", "That control is turned off for this server.");
  }
  if (isStaff(actor) || room.ownerId === actor.member.id) return null;
  if (feature && String(feature) === "claim") return null;
  return t("companion_channels.error.ownerOnly", "Only the room owner can do that.");
}

function asVoice(channel: VoiceBasedChannel): VoiceChannel | null {
  return channel.type === ChannelType.GuildVoice ? (channel as VoiceChannel) : null;
}

export async function setCompanionName(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  name: string,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "name");
  if (isActionResult(resolved)) return resolved;
  if (resolved.setup && !resolved.setup.editable && !isStaff(actor))
    return fail(t("companion_channels.error.renameNotAllowed", "This setup does not allow renaming."));
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) return fail(t("companion_channels.error.giveChannelName", "Give the channel a name."));
  await resolved.channel.setName(trimmed);
  return ok(
    t("companion_channels.success.renamed", "Renamed the room to **{name}**.", { name: trimmed }),
    COMPANION_ICON.rename,
  );
}

export async function setCompanionLimit(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  limit: number,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "limit");
  if (isActionResult(resolved)) return resolved;
  if (resolved.setup && !resolved.setup.editable && !isStaff(actor)) {
    return fail(t("companion_channels.error.limitNotAllowed", "This setup does not allow changing the limit."));
  }
  const value = Math.max(0, Math.min(99, Math.floor(limit)));
  await resolved.channel.setUserLimit(value);
  return ok(
    value === 0
      ? t("companion_channels.success.limitRemoved", "Removed the user limit.")
      : t("companion_channels.success.limitSet", "User limit set to **{value}**.", { value }),
    COMPANION_ICON.limit,
  );
}

export async function setCompanionBitrate(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  kbps: number,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "bitrate");
  if (isActionResult(resolved)) return resolved;
  const value = Math.max(8, Math.min(384, Math.floor(kbps)));
  await resolved.channel.setBitrate(value * 1000);
  return ok(
    t("companion_channels.success.bitrateSet", "Bitrate set to **{value} kbps**.", { value }),
    COMPANION_ICON.bitrate,
  );
}

export async function setCompanionStatus(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  status: string,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "status");
  if (isActionResult(resolved)) return resolved;
  const trimmed = status.trim().slice(0, 500);
  const applied = await setVoiceChannelStatus(resolved.channel, trimmed || null);
  if (!applied) return fail(t("companion_channels.error.statusFailed", "Could not set a status on this channel."));
  return ok(
    trimmed
      ? t("companion_channels.success.statusSet", "Status set to **{status}**.", { status: trimmed })
      : t("companion_channels.success.statusCleared", "Cleared the channel status."),
    COMPANION_ICON.status,
  );
}

export async function setCompanionRegion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  region: string,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "region");
  if (isActionResult(resolved)) return resolved;
  const value = region.trim().toLowerCase();
  await resolved.channel.setRTCRegion(value && value !== "automatic" ? value : null);
  return ok(
    value && value !== "automatic"
      ? t("companion_channels.success.regionSet", "Region set to **{region}**.", { region: value })
      : t("companion_channels.success.regionAutomatic", "Region set to automatic."),
    COMPANION_ICON.region,
  );
}

export async function toggleCompanionNsfw(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "nsfw");
  if (isActionResult(resolved)) return resolved;
  const next = !resolved.channel.nsfw;
  await resolved.channel.setNSFW(next);
  return ok(
    next
      ? t("companion_channels.success.nsfwMarked", "Marked the room as NSFW.")
      : t("companion_channels.success.nsfwRemoved", "Removed the NSFW mark."),
    COMPANION_ICON.nsfw,
  );
}

export async function lockCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  locked: boolean,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "lock");
  if (isActionResult(resolved)) return resolved;
  await setLocked(resolved.channel, locked, resolved.room.ownerId || actor.member.id);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { locked });
  return ok(
    locked
      ? t("companion_channels.success.locked", "Locked the room. New people cannot join.")
      : t("companion_channels.success.unlocked", "Unlocked the room."),
    locked ? COMPANION_ICON.lock : COMPANION_ICON.unlock,
  );
}

export async function ghostCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  ghosted: boolean,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "ghost");
  if (isActionResult(resolved)) return resolved;
  await setGhosted(resolved.channel, ghosted, resolved.room.ownerId || actor.member.id);
  await updateRoom(actor.member.guild.id, resolved.channel.id, { ghosted });
  return ok(
    ghosted
      ? t("companion_channels.success.ghosted", "Ghosted the room. It is hidden from the channel list.")
      : t("companion_channels.success.unghosted", "The room is visible again."),
    ghosted ? COMPANION_ICON.ghost : COMPANION_ICON.unghost,
  );
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
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "permit");
  if (isActionResult(resolved)) return resolved;
  await resolved.channel.permissionOverwrites
    .edit(target.id, { Connect: true, ViewChannel: true })
    .catch(() => null);
  const label = targetLabel(target);
  return ok(
    t("companion_channels.success.permitted", "Permitted **{target}** to join.", { target: label }),
    COMPANION_ICON.permit,
  );
}

export async function rejectTarget(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  target: User | Role | GuildMember,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "reject");
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
    const label = targetLabel(target);
    return ok(
      t("companion_channels.success.rejected", "Rejected **{target}**.", { target: label }),
      COMPANION_ICON.reject,
    );
  }

  for (const member of resolved.channel.members.values()) {
    if (member.roles.cache.has(target.id) && member.id !== resolved.room.ownerId) {
      await member.voice.disconnect("Rejected from companion channel").catch(() => null);
    }
  }
  return ok(
    t("companion_channels.success.rejected", "Rejected **{target}**.", { target: target.name }),
    COMPANION_ICON.reject,
  );
}

export async function transferCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  user: User,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "transfer");
  if (isActionResult(resolved)) return resolved;
  const member = await actor.member.guild.members.fetch(user.id).catch(() => null);
  if (!member) return fail(t("companion_channels.error.memberNotFound", "Could not find that member."));
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
  return ok(
    t(
      "companion_channels.success.transferred",
      "Ownership transferred to **{member}**.",
      { member: member.displayName },
    ),
    COMPANION_ICON.transfer,
  );
}

export async function claimCompanion(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "claim");
  if (isActionResult(resolved)) return resolved;
  if (resolved.room.ownerId === actor.member.id)
    return fail(t("companion_channels.error.alreadyOwnRoom", "You already own this room."));
  if (resolved.room.ownerId) {
    const ownerInChannel = resolved.channel.members.has(resolved.room.ownerId);
    if (ownerInChannel && !isStaff(actor))
      return fail(t("companion_channels.error.ownerStillPresent", "The owner is still in the room."));
    await resolved.channel.permissionOverwrites.delete(resolved.room.ownerId).catch(() => null);
  }
  const already = await getOwnedRoom(actor.member.guild.id, actor.member.id);
  if (already && already.channelId !== resolved.channel.id) {
    return fail(t("companion_channels.error.alreadyOwnAnotherRoom", "You already own another companion room."));
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
  return ok(t("companion_channels.success.claimed", "You claimed this room."), COMPANION_ICON.claim);
}

export async function toggleCompanionText(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "text");
  if (isActionResult(resolved)) return resolved;
  const voice = asVoice(resolved.channel);
  if (!voice)
    return fail(
      t("companion_channels.error.textLinkVoiceOnly", "Text channels can only be linked to a voice room."),
    );
  if (resolved.room.textChannelId) {
    await clearLinkedText(actor.member.guild, resolved.room);
    return ok(
      t("companion_channels.success.textRemoved", "Removed the linked text channel."),
      COMPANION_ICON.textUnlink,
    );
  }
  const textId = await ensureLinkedText(actor.member, voice, resolved.room, actor.config, resolved.setup);
  return ok(
    t(
      "companion_channels.success.textCreated",
      "Created a linked text channel: {channel}.",
      { channel: `<#${textId}>` },
    ),
    COMPANION_ICON.textLink,
  );
}

export async function postLookingForMembers(
  actor: CompanionActor,
  channel: VoiceBasedChannel,
  t: Translator,
): Promise<CompanionActionResult> {
  const resolved = await requireManagedRoom(actor, channel, t, "lfm");
  if (isActionResult(resolved)) return resolved;
  const lfmId = actor.config.lfm_channel_id.trim();
  if (!lfmId)
    return fail(
      t("companion_channels.error.lfmNotConfigured", "No Looking for Members channel is configured."),
    );
  const lfm = await actor.member.guild.channels.fetch(lfmId).catch(() => null);
  if (!lfm?.isTextBased() || !("send" in lfm))
    return fail(t("companion_channels.error.lfmChannelMissing", "The LFM channel is missing."));
  const invite = await resolved.channel
    .createInvite({ maxAge: 1800, maxUses: 0, unique: true })
    .catch(() => null);
  await lfm.send({
    content: t(
      "companion_channels.lfm.post",
      "**{member}** is looking for members in {channel}.{invite}",
      {
        member: actor.member.displayName,
        channel: String(resolved.channel),
        invite: invite ? `\n${invite.url}` : "",
      },
    ),
  });
  return ok(
    t("companion_channels.success.lfmPosted", "Posted in the Looking for Members channel."),
    COMPANION_ICON.lfm,
  );
}
