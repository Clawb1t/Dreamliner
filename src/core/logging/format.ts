import type { InfractionRecord } from "../../plugins/infraction/functions/embeds.js";
import { formatDurationShort } from "../../plugins/infraction/functions/duration.js";
import { trimLines } from "../embeds.js";
import type { LogCard, LogRef } from "./types.js";

export type { LogCard, LogRef } from "./types.js";

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_~|])/g, "\\$1");
}

function bold(text: string): string {
  return `**${escapeInline(text)}**`;
}

function logTimestamp(): string {
  return `<t:${Math.floor(Date.now() / 1000)}:t>`;
}

function userMention(userId: string): string {
  return `<@${userId}>`;
}

function userLine(ref: LogRef, label = "Member"): string {
  return `${label}: ${userMention(ref.id)} (\`${ref.id}\`)`;
}

function channelMention(channelId: string): string {
  return `<#${channelId}>`;
}

function channelLine(ref: LogRef, label = "Channel"): string {
  return `${label}: ${channelMention(ref.id)} (\`${ref.id}\`)`;
}

function roleList(label: string, roles: LogRef[]): string {
  if (!roles.length) return "";
  const items = roles.map((role) => `<@&${role.id}> (\`${role.id}\`)`).join("\n");
  return `${label}:\n${items}`;
}

function card(title: string, information: string[], options?: { avatarUrl?: string | null; extra?: string }): LogCard {
  return {
    title,
    avatarUrl: options?.avatarUrl,
    information: information.filter(Boolean),
    extra: options?.extra,
  };
}

const CASE_META: Record<string, { emoji: string; label: string }> = {
  warn: { emoji: "⚠️", label: "Warn" },
  note: { emoji: "📝", label: "Note" },
  mute: { emoji: "🔇", label: "Mute" },
  tempmute: { emoji: "🔇", label: "Temp Mute" },
  unmute: { emoji: "🔊", label: "Unmute" },
  kick: { emoji: "👢", label: "Kick" },
  ban: { emoji: "🔨", label: "Ban" },
  tempban: { emoji: "🔨", label: "Temp Ban" },
  unban: { emoji: "✅", label: "Unban" },
  softban: { emoji: "🔨", label: "Softban" },
  clean: { emoji: "🧼", label: "Clean" },
};

export function buildCaseCreateLog(
  record: InfractionRecord,
  options?: {
    durationLabel?: string | null;
    user?: LogRef;
    mod?: LogRef;
  },
): LogCard {
  const meta = CASE_META[record.type] ?? { emoji: "📋", label: record.type };
  const duration =
    options?.durationLabel ??
    (record.expiresAt ? formatDurationShort(record.expiresAt.getTime() - record.createdAt.getTime()) : null);
  const mod = options?.mod ?? { id: record.modId };
  const user = options?.user ?? { id: record.userId };
  const title = `${meta.emoji} ${meta.label} #${record.id}`;
  const information = [
    `Time: ${logTimestamp()}`,
    record.type !== "clean" ? userLine(user, "Target") : null,
    userLine(mod, "Moderator"),
    duration && (record.type === "tempmute" || record.type === "tempban") ? `Duration: ${bold(duration)}` : null,
    record.reason?.trim() ? `Reason: ${truncate(record.reason, 300)}` : null,
  ].filter((line): line is string => Boolean(line));

  if (record.type === "clean") {
    return card(title, information, { avatarUrl: mod.avatarUrl });
  }

  return card(title, information, { avatarUrl: user.avatarUrl ?? mod.avatarUrl });
}

export function buildCaseUpdateLog(caseId: number, caseType: string, mod: LogRef, note: string): LogCard {
  return card(
    `📝 Case Update #${caseId}`,
    [`Time: ${logTimestamp()}`, `Type: ${bold(caseType)}`, userLine(mod, "Moderator"), `Change: ${truncate(note, 300)}`],
    { avatarUrl: mod.avatarUrl },
  );
}

export function buildCaseDeleteLog(caseId: number, mod: LogRef): LogCard {
  return card(
    `🔴 Case Delete #${caseId}`,
    [`Time: ${logTimestamp()}`, userLine(mod, "Moderator")],
    { avatarUrl: mod.avatarUrl },
  );
}

export function buildMuteExpiredLog(user: LogRef): LogCard {
  return card("🔊 Mute Expired", [`Time: ${logTimestamp()}`, userLine(user)], { avatarUrl: user.avatarUrl });
}

export function buildTempbanExpiredLog(user: LogRef): LogCard {
  return card("✅ Temp Ban Expired", [`Time: ${logTimestamp()}`, userLine(user)], { avatarUrl: user.avatarUrl });
}

export function buildDmFailedLog(user: LogRef, source: string): LogCard {
  return card(
    "🚧 DM Failed",
    [`Time: ${logTimestamp()}`, userLine(user), `Source: ${bold(source)}`],
    { avatarUrl: user.avatarUrl },
  );
}

export function buildCleanLog(input: {
  mod: LogRef;
  channel: LogRef;
  count: number;
  archiveId?: string;
}): LogCard {
  return card(
    "🧼 Clean",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.mod, "Moderator"),
      channelLine(input.channel),
      `Deleted: ${bold(String(input.count))} message${input.count === 1 ? "" : "s"}`,
      input.archiveId ? `Archive ID: \`${input.archiveId}\`` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.mod.avatarUrl },
  );
}

export function buildVoiceForceMoveLog(input: {
  target: LogRef;
  mod: LogRef;
  fromChannel: LogRef | null;
  toChannel: LogRef;
}): LogCard {
  return card(
    "🔀 Voice Move",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.target),
      userLine(input.mod, "Moderator"),
      input.fromChannel ? channelLine(input.fromChannel, "From") : "From: **none**",
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.target.avatarUrl },
  );
}

export function buildVoiceForceMoveAllLog(input: {
  mod: LogRef;
  count: number;
  fromChannel: LogRef;
  toChannel: LogRef;
}): LogCard {
  return card(
    "🔀 Voice Move",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.mod, "Moderator"),
      `Moved: ${bold(String(input.count))} member${input.count === 1 ? "" : "s"}`,
      channelLine(input.fromChannel, "From"),
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.mod.avatarUrl },
  );
}

export function buildVoiceForceDisconnectLog(input: {
  target: LogRef;
  mod: LogRef;
  channel: LogRef;
}): LogCard {
  return card(
    "🔇 Voice Disconnect",
    [`Time: ${logTimestamp()}`, userLine(input.target), userLine(input.mod, "Moderator"), channelLine(input.channel)],
    { avatarUrl: input.target.avatarUrl },
  );
}

export function buildMemberJoinLog(user: LogRef): LogCard {
  return card("📥 Join", [`Time: ${logTimestamp()}`, userLine(user)], { avatarUrl: user.avatarUrl });
}

export function buildMemberLeaveLog(user: LogRef): LogCard {
  return card("📤 Leave", [`Time: ${logTimestamp()}`, userLine(user)], { avatarUrl: user.avatarUrl });
}

export function buildMessageEditLog(input: {
  user: LogRef;
  channel: LogRef;
  before: string;
  after: string;
}): LogCard {
  const before = truncate(input.before || "(empty)", 500);
  const after = truncate(input.after || "(empty)", 500);
  return card(
    "📝 Edit Message",
    [`Time: ${logTimestamp()}`, userLine(input.user), channelLine(input.channel)],
    {
      avatarUrl: input.user.avatarUrl,
      extra: trimLines(`**Before**\n${before}\n\n**After**\n${after}`),
    },
  );
}

export function buildMessageDeleteLog(input: {
  user: LogRef;
  channel: LogRef;
  content: string;
}): LogCard {
  const snippet = truncate(input.content || "(no text content)", 500);
  return card(
    "🗑️ Delete Message",
    [`Time: ${logTimestamp()}`, userLine(input.user), channelLine(input.channel)],
    {
      avatarUrl: input.user.avatarUrl,
      extra: trimLines(`**Content**\n${snippet}`),
    },
  );
}

export function buildVoiceJoinLog(user: LogRef, channel: LogRef): LogCard {
  return card("🔊 Voice Join", [`Time: ${logTimestamp()}`, userLine(user), channelLine(channel)], {
    avatarUrl: user.avatarUrl,
  });
}

export function buildVoiceLeaveLog(user: LogRef, channel: LogRef): LogCard {
  return card("🔇 Voice Leave", [`Time: ${logTimestamp()}`, userLine(user), channelLine(channel)], {
    avatarUrl: user.avatarUrl,
  });
}

export function buildVoiceMoveLog(input: {
  user: LogRef;
  fromChannel: LogRef;
  toChannel: LogRef;
}): LogCard {
  return card(
    "🔀 Voice Move",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      channelLine(input.fromChannel, "From"),
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildNicknameChangeLog(input: {
  user: LogRef;
  mod?: LogRef;
  oldNick: string;
  newNick: string;
}): LogCard {
  const information = [
    `Time: ${logTimestamp()}`,
    userLine(input.user),
    input.mod ? userLine(input.mod, "Moderator") : null,
    `Before: ${bold(truncate(input.oldNick, 32))}`,
    `After: ${bold(truncate(input.newNick, 32))}`,
  ].filter((line): line is string => Boolean(line));

  return card("📝 Nickname Change", information, { avatarUrl: input.user.avatarUrl });
}

export function buildRoleChangeLog(input: {
  user: LogRef;
  added: LogRef[];
  removed: LogRef[];
}): LogCard {
  const information = [
    `Time: ${logTimestamp()}`,
    userLine(input.user),
    roleList("Added", input.added),
    roleList("Removed", input.removed),
  ].filter(Boolean);

  return card("🎭 Role Change", information, { avatarUrl: input.user.avatarUrl });
}

export function buildThreadCreateLog(input: {
  user: LogRef;
  thread: LogRef;
  parentChannel: LogRef;
}): LogCard {
  return card(
    "🧵 Thread Created",
    [`Time: ${logTimestamp()}`, userLine(input.user), channelLine(input.parentChannel, "Parent"), `Thread: ${bold(input.thread.name ?? input.thread.id)}`],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildThreadArchiveLog(input: {
  thread: LogRef;
  parentChannel: LogRef;
  archived: boolean;
}): LogCard {
  return card(
    input.archived ? "📦 Thread Archived" : "📂 Thread Unarchived",
    [`Time: ${logTimestamp()}`, channelLine(input.parentChannel, "Parent"), `Thread: ${bold(input.thread.name ?? input.thread.id)}`],
  );
}

export function buildMessagePinLog(input: {
  user: LogRef;
  channel: LogRef;
  pinned: boolean;
}): LogCard {
  return card(
    input.pinned ? "📌 Message Pinned" : "📍 Message Unpinned",
    [`Time: ${logTimestamp()}`, userLine(input.user), channelLine(input.channel)],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildAutomodLog(input: {
  user: LogRef;
  channel: LogRef;
  reason: string;
  action: string;
}): LogCard {
  return card(
    "🤖 Automod",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      channelLine(input.channel),
      `Rule: ${bold(input.reason)}`,
      `Action: ${bold(input.action)}`,
    ],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildCensorLog(input: {
  user: LogRef;
  channel: LogRef;
  pattern: string;
  action: string;
}): LogCard {
  return card(
    "🚫 Censor",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      channelLine(input.channel),
      `Pattern: \`${truncate(input.pattern, 100)}\``,
      `Action: ${bold(input.action)}`,
    ],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildRaidDetectedLog(input: {
  user: LogRef;
  joinCount: number;
  windowMs: number;
}): LogCard {
  return card(
    "🚨 Raid Detected",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user, "Latest join"),
      `Threshold: ${bold(String(input.joinCount))} joins / ${Math.round(input.windowMs / 1000)}s`,
    ],
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildMemberKickLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
}): LogCard {
  return card(
    "👢 Member Kicked",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 300)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildMemberBanLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
}): LogCard {
  return card(
    "🔨 Member Banned",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 300)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildMemberUnbanLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
}): LogCard {
  return card(
    "✅ Member Unbanned",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 300)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildTimeoutChangeLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  before: string | null;
  after: string | null;
}): LogCard {
  return card(
    "⏳ Timeout Change",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      `Before: ${bold(input.before ?? "none")}`,
      `After: ${bold(input.after ?? "none")}`,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildChannelCreateLog(input: {
  channel: LogRef;
  type: string;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "📁 Channel Created",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      `Type: ${bold(input.type)}`,
      input.mod ? userLine(input.mod, "Created by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildChannelDeleteLog(input: {
  channel: LogRef;
  type: string;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🗑️ Channel Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Channel: ${bold(input.channel.name ?? input.channel.id)} (\`${input.channel.id}\`)`,
      `Type: ${bold(input.type)}`,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildChannelUpdateLog(input: {
  channel: LogRef;
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "✏️ Channel Updated",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      input.mod ? userLine(input.mod, "Updated by") : null,
      input.changes.length ? `Changes:\n${input.changes.map((c) => `• ${c}`).join("\n")}` : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildRoleCreateLog(input: { role: LogRef; mod?: LogRef | null }): LogCard {
  return card(
    "🎭 Role Created",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.mod ? userLine(input.mod, "Created by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildRoleDeleteLog(input: { role: LogRef; mod?: LogRef | null }): LogCard {
  return card(
    "🎭 Role Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildRoleUpdateLog(input: {
  role: LogRef;
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🎭 Role Updated",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.mod ? userLine(input.mod, "Updated by") : null,
      input.changes.length ? `Changes:\n${input.changes.map((c) => `• ${c}`).join("\n")}` : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildGuildUpdateLog(input: {
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🏠 Server Updated",
    [
      `Time: ${logTimestamp()}`,
      input.mod ? userLine(input.mod, "Updated by") : null,
      input.changes.length ? `Changes:\n${input.changes.map((c) => `• ${c}`).join("\n")}` : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildEmojiLog(input: {
  action: "create" | "delete" | "update";
  name: string;
  id: string;
  mod?: LogRef | null;
}): LogCard {
  const title =
    input.action === "create"
      ? "😀 Emoji Created"
      : input.action === "delete"
        ? "😀 Emoji Deleted"
        : "😀 Emoji Updated";
  return card(
    title,
    [
      `Time: ${logTimestamp()}`,
      `Emoji: ${bold(input.name)} (\`${input.id}\`)`,
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildStickerLog(input: {
  action: "create" | "delete" | "update";
  name: string;
  id: string;
  mod?: LogRef | null;
}): LogCard {
  const title =
    input.action === "create"
      ? "🏷️ Sticker Created"
      : input.action === "delete"
        ? "🏷️ Sticker Deleted"
        : "🏷️ Sticker Updated";
  return card(
    title,
    [
      `Time: ${logTimestamp()}`,
      `Sticker: ${bold(input.name)} (\`${input.id}\`)`,
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildInviteCreateLog(input: {
  code: string;
  channel?: LogRef | null;
  inviter?: LogRef | null;
  maxUses?: number | null;
  maxAge?: number | null;
}): LogCard {
  return card(
    "🔗 Invite Created",
    [
      `Time: ${logTimestamp()}`,
      `Code: \`${input.code}\``,
      input.channel ? channelLine(input.channel) : null,
      input.inviter ? userLine(input.inviter, "Inviter") : null,
      input.maxUses != null ? `Max uses: ${bold(String(input.maxUses || "unlimited"))}` : null,
      input.maxAge != null ? `Max age: ${bold(input.maxAge ? `${input.maxAge}s` : "forever")}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.inviter?.avatarUrl },
  );
}

export function buildInviteDeleteLog(input: {
  code: string;
  channel?: LogRef | null;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🔗 Invite Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Code: \`${input.code}\``,
      input.channel ? channelLine(input.channel) : null,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildWebhookUpdateLog(input: {
  channel: LogRef;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🪝 Webhooks Updated",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildVoiceFlagLog(input: {
  title: string;
  user: LogRef;
  channel?: LogRef | null;
  detail: string;
}): LogCard {
  return card(
    input.title,
    [
      `Time: ${logTimestamp()}`,
      userLine(input.user),
      input.channel ? channelLine(input.channel) : null,
      input.detail,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl },
  );
}

export function buildThreadDeleteLog(input: {
  thread: LogRef;
  parentChannel?: LogRef | null;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🧵 Thread Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Thread: ${bold(input.thread.name ?? input.thread.id)} (\`${input.thread.id}\`)`,
      input.parentChannel ? channelLine(input.parentChannel, "Parent") : null,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildMessageBulkDeleteLog(input: {
  channel: LogRef;
  count: number;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "🗑️ Bulk Delete",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      `Count: ${bold(String(input.count))}`,
      input.mod ? userLine(input.mod, "Moderator") : null,
    ].filter((line): line is string => Boolean(line)),
  );
}

export function buildGenericServerLog(title: string, lines: string[], avatarUrl?: string | null): LogCard {
  return card(title, [`Time: ${logTimestamp()}`, ...lines], { avatarUrl });
}
