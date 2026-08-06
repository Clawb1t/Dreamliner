import type { Guild, GuildChannel, GuildMember, Role, User } from "discord.js";
import type { DreamObject } from "../../../dreamcode/index.js";
import { getMemberLevel } from "../../../core/permissions.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { InfractionRecord } from "../../infraction/functions/embeds.js";

export function memberObject(member: GuildMember, guildConfig: GuildConfig): DreamObject {
  const level = getMemberLevel(member, guildConfig.levels);
  const roles = [...member.roles.cache.values()]
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => roleObject(r));

  return {
    __type: "member",
    id: member.id,
    name: member.user.username,
    displayName: member.displayName,
    nick: member.nickname,
    mention: `<@${member.id}>`,
    tag: member.user.tag,
    bot: member.user.bot,
    level,
    timedOut: member.isCommunicationDisabled(),
    joinedAt: member.joinedAt?.getTime() ?? null,
    joinedAtIso: member.joinedAt?.toISOString() ?? null,
    avatarUrl: member.displayAvatarURL({ size: 128 }),
    roles,
    roleIds: roles.map((r) => String(r.id)),
    highestRole: roles[0] ?? null,
    voiceChannelId: member.voice.channelId,
    voiceChannel: member.voice.channel ? channelObject(member.voice.channel as GuildChannel) : null,
  };
}

export function userObject(user: User, level = 0): DreamObject {
  return {
    __type: "user",
    id: user.id,
    name: user.username,
    mention: `<@${user.id}>`,
    tag: user.tag,
    bot: user.bot,
    level,
    avatarUrl: user.displayAvatarURL({ size: 128 }),
    createdAt: user.createdAt.getTime(),
    createdAtIso: user.createdAt.toISOString(),
  };
}

export function roleObject(role: Role): DreamObject {
  return {
    __type: "role",
    id: role.id,
    name: role.name,
    mention: `<@&${role.id}>`,
    color: role.hexColor,
    position: role.position,
    mentionable: role.mentionable,
    managed: role.managed,
    hoist: role.hoist,
    members: role.members.size,
  };
}

export function channelObject(channel: GuildChannel | { id: string; name?: string | null; type?: number }): DreamObject {
  const name = "name" in channel && channel.name ? String(channel.name) : channel.id;
  const type = "type" in channel && typeof channel.type === "number" ? channel.type : null;
  const parentId =
    "parentId" in channel && typeof (channel as { parentId?: string | null }).parentId === "string"
      ? (channel as { parentId: string }).parentId
      : null;
  const topic =
    "topic" in channel && typeof (channel as { topic?: string | null }).topic === "string"
      ? (channel as { topic: string }).topic
      : null;
  const nsfw = "nsfw" in channel ? Boolean((channel as { nsfw?: boolean }).nsfw) : false;
  const rateLimit =
    "rateLimitPerUser" in channel && typeof (channel as { rateLimitPerUser?: number }).rateLimitPerUser === "number"
      ? (channel as { rateLimitPerUser: number }).rateLimitPerUser
      : 0;

  return {
    __type: "channel",
    id: channel.id,
    name,
    mention: `<#${channel.id}>`,
    type,
    parentId,
    topic,
    nsfw,
    slowmode: rateLimit,
  };
}

export function messageObject(message: {
  id: string;
  content: string;
  channel: { id: string };
  author: { id: string };
  createdAt?: Date | number | null;
  pinned?: boolean;
  url?: string;
}): DreamObject {
  const createdAt =
    message.createdAt instanceof Date
      ? message.createdAt.getTime()
      : typeof message.createdAt === "number"
        ? message.createdAt
        : Date.now();
  return {
    __type: "message",
    id: message.id,
    content: message.content,
    channelId: message.channel.id,
    authorId: message.author.id,
    createdAt,
    pinned: Boolean(message.pinned),
    url: message.url ?? "",
  };
}

export function caseObject(record: InfractionRecord): DreamObject {
  return {
    __type: "case",
    id: record.id,
    type: record.type,
    userId: record.userId,
    modId: record.modId,
    reason: record.reason ?? "",
    active: record.active,
    expiresAt: record.expiresAt?.getTime() ?? null,
    createdAt: record.createdAt.getTime(),
  };
}

export function guildObject(guild: Guild): DreamObject {
  return {
    __type: "guild",
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    ownerId: guild.ownerId,
    iconUrl: guild.iconURL({ size: 128 }),
    createdAt: guild.createdAt.getTime(),
  };
}
