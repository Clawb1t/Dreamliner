/** Fixtures shared by the Server Autopilot tests (not shipped behaviour). */
import { PermissionFlagsBits } from "discord.js";
import { DEFAULT_NAMING } from "./naming.js";
import type { GuildSnapshot, SnapChannel, SnapRole } from "./snapshot.js";
import type { SAChannel, SARole, SATemplate } from "./types.js";

export const GUILD_ID = "100000000000000000";
export const BOT_ID = "200000000000000000";
export const BOT_ROLE_ID = "300000000000000000";

let seq = 400000000000000000n;
export const nextId = (): string => (seq++).toString();

export function role(name: string, patch: Partial<SnapRole> = {}): SnapRole {
  return { id: nextId(), name, color: 0, hoist: false, mentionable: false, permissions: "0", position: 1, managed: false, isEveryone: false, isBooster: false, members: 0, ...patch };
}

export function channel(name: string, kind: SnapChannel["kind"], patch: Partial<SnapChannel> = {}): SnapChannel {
  return { id: nextId(), name, kind, rawType: 0, parentId: null, position: 0, topic: "", nsfw: false, slowmode: 0, bitrate: 0, userLimit: 0, hasMessages: false, overwrites: [], ...patch };
}

export function snapshot(patch: Partial<GuildSnapshot> & { channels?: SnapChannel[]; roles?: SnapRole[] } = {}): GuildSnapshot {
  const everyone = role("@everyone", { id: GUILD_ID, isEveryone: true, position: 0 });
  const botRole = role("Dreamliner", { id: BOT_ROLE_ID, managed: true, position: 10 });
  return {
    id: GUILD_ID,
    name: "Test Server",
    ownerId: "500000000000000000",
    community: true,
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    systemChannelId: null,
    safetyAlertsChannelId: null,
    logChannelIds: [],
    ...patch,
    channels: patch.channels ?? [],
    roles: [everyone, botRole, ...(patch.roles ?? [])],
    bot: patch.bot ?? {
      userId: BOT_ID,
      roleId: BOT_ROLE_ID,
      highestPosition: 10,
      permissions: (PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ManageThreads | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.CreatePrivateThreads | PermissionFlagsBits.AddReactions).toString(),
      administrator: false,
    },
  };
}

export function ch(key: string, base: string, patch: Partial<SAChannel> = {}): SAChannel {
  return { key, base, emoji: "", type: "text", topic: "", slowmode: 0, nsfw: false, user_limit: 0, access: "everyone", role_keys: [], rules: [], purpose: "other", ...patch };
}

export function tRole(key: string, name: string, preset: SARole["preset"], patch: Partial<SARole> = {}): SARole {
  return { key, name, color: null, hoist: false, mentionable: false, preset, extra_permissions: [], self_assignable: false, group: "", ...patch };
}

export function template(patch: Partial<SATemplate> = {}): SATemplate {
  return {
    id: "t1",
    name: "Test Layout",
    tagline: "",
    summary: "",
    highlights: [],
    naming: { ...DEFAULT_NAMING },
    roles: [tRole("admin", "Admin", "admin", { hoist: true }), tRole("mod", "Moderator", "moderator", { hoist: true }), tRole("member", "Member", "member")],
    categories: [
      {
        key: "info",
        base: "information",
        emoji: "📌",
        access: "everyone",
        role_keys: [],
        rules: [],
        channels: [ch("rules", "rules", { purpose: "rules", access: "read_only" }), ch("announcements", "announcements", { purpose: "announcements", access: "read_only" })],
      },
      {
        key: "community",
        base: "community",
        emoji: "💬",
        access: "everyone",
        role_keys: [],
        rules: [],
        channels: [ch("general", "general", { purpose: "general" }), ch("memes", "memes", { purpose: "memes" }), ch("lounge", "lounge", { type: "voice", purpose: "voice_lounge" })],
      },
      {
        key: "staff",
        base: "staff",
        emoji: "🛡️",
        access: "staff_only",
        role_keys: [],
        rules: [],
        channels: [ch("staff_chat", "staff chat", { purpose: "staff_chat" }), ch("mod_logs", "mod logs", { purpose: "mod_logs" })],
      },
    ],
    uncategorized: [],
    plugins: [],
    messages: [],
    ...patch,
  };
}
