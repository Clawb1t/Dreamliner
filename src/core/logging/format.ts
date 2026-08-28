import type { InfractionRecord } from "../../plugins/infraction/functions/embeds.js";
import { formatDurationShort } from "../../plugins/infraction/functions/duration.js";
import { trimLines } from "../embeds.js";
import type { LogEmojiCategory } from "./emojis.js";
import type { LogButton, LogCard, LogFile, LogRef } from "./types.js";

export type { LogCard, LogRef, LogButton, LogFile, LogEmojiCategory } from "./types.js";

const CONTENT_INLINE_LIMIT = 800;

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

function absoluteTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

function relativeTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function userMention(userId: string): string {
  return `<@${userId}>`;
}

/** Member/user line, plus optional account-age / join-date / bot tag lines when the ref carries them. */
function userLines(ref: LogRef, label = "Member"): string[] {
  const botTag = ref.bot ? " `[BOT]`" : "";
  const lines = [`${label}: ${userMention(ref.id)} (\`${ref.id}\`)${botTag}`];
  if (ref.createdAt) {
    lines.push(`Account created: ${relativeTimestamp(ref.createdAt)} (${absoluteTimestamp(ref.createdAt)})`);
  }
  if (ref.joinedAt) {
    lines.push(`Joined server: ${relativeTimestamp(ref.joinedAt)}`);
  }
  return lines;
}

function userLine(ref: LogRef, label = "Member"): string {
  return userLines(ref, label)[0]!;
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
  return `${label} (${roles.length}):\n${items}`;
}

/**
 * Formats a text field (message content, before/after, etc). Short content is inlined; long
 * content is handed off as an attached file (pushed onto `files`) with a short preview left
 * inline, so the card stays readable instead of dumping a wall of text into it.
 */
function contentField(label: string, content: string, filename: string, files: LogFile[]): string {
  const text = content?.trim() ? content : "(empty)";
  if (text.length <= CONTENT_INLINE_LIMIT) {
    return `**${label}**\n${text}`;
  }
  files.push({ name: filename, content: text });
  return `**${label}** (${text.length} chars — attached as \`${filename}\`)\n${truncate(text, 300)}`;
}

function card(
  title: string,
  information: string[],
  options?: {
    avatarUrl?: string | null;
    extra?: string;
    buttons?: LogButton[];
    files?: LogFile[];
    emojiCategory?: LogEmojiCategory;
  },
): LogCard {
  return {
    title,
    avatarUrl: options?.avatarUrl,
    information: information.filter(Boolean),
    extra: options?.extra,
    buttons: options?.buttons,
    files: options?.files,
    emojiCategory: options?.emojiCategory ?? "action",
  };
}

const CASE_META: Record<string, { category: LogEmojiCategory; label: string }> = {
  warn: { category: "modModerate", label: "Warn" },
  note: { category: "modDefault", label: "Note" },
  mute: { category: "modModerate", label: "Mute" },
  tempmute: { category: "modModerate", label: "Temp Mute" },
  unmute: { category: "modDefault", label: "Unmute" },
  kick: { category: "modSevere", label: "Kick" },
  ban: { category: "modSevere", label: "Ban" },
  tempban: { category: "modSevere", label: "Temp Ban" },
  unban: { category: "unban", label: "Unban" },
  softban: { category: "modSevere", label: "Softban" },
  clean: { category: "delete", label: "Clean" },
};

export function buildCaseCreateLog(
  record: InfractionRecord,
  options?: {
    durationLabel?: string | null;
    user?: LogRef;
    mod?: LogRef;
    priorCaseCount?: number;
  },
): LogCard {
  const meta = CASE_META[record.type] ?? { category: "modDefault" as LogEmojiCategory, label: record.type };
  const duration =
    options?.durationLabel ??
    (record.expiresAt ? formatDurationShort(record.expiresAt.getTime() - record.createdAt.getTime()) : null);
  const mod = options?.mod ?? { id: record.modId };
  const user = options?.user ?? { id: record.userId };
  const title = `${meta.label} #${record.id}`;
  const information = [
    `Time: ${logTimestamp()} (${absoluteTimestamp(record.createdAt.getTime())})`,
    record.type !== "clean" ? userLine(user, "Target") : null,
    userLine(mod, "Moderator"),
    duration && (record.type === "tempmute" || record.type === "tempban") ? `Duration: ${bold(duration)}` : null,
    record.expiresAt ? `Expires: ${relativeTimestamp(record.expiresAt.getTime())}` : null,
    options?.priorCaseCount != null ? `Prior cases for this member: ${bold(String(options.priorCaseCount))}` : null,
    record.reason?.trim() ? `Reason: ${truncate(record.reason, 500)}` : "Reason: *(none given)*",
  ].filter((line): line is string => Boolean(line));

  if (record.type === "clean") {
    return card(title, information, { avatarUrl: mod.avatarUrl, emojiCategory: meta.category });
  }

  return card(title, information, { avatarUrl: user.avatarUrl ?? mod.avatarUrl, emojiCategory: meta.category });
}

export function buildCaseUpdateLog(
  caseId: number,
  caseType: string,
  mod: LogRef,
  note: string,
  options?: { before?: string | null; after?: string | null },
): LogCard {
  const information = [
    `Time: ${logTimestamp()}`,
    `Type: ${bold(caseType)}`,
    userLine(mod, "Moderator"),
    `Change: ${truncate(note, 300)}`,
  ];
  const extra =
    options?.before != null || options?.after != null
      ? trimLines(`**Before**\n${truncate(options?.before ?? "(none)", 500)}\n\n**After**\n${truncate(options?.after ?? "(none)", 500)}`)
      : undefined;
  return card(`Case Update #${caseId}`, information, { avatarUrl: mod.avatarUrl, extra, emojiCategory: "edit" });
}

export function buildCaseDeleteLog(caseId: number, mod: LogRef, reason?: string | null): LogCard {
  return card(
    `Case Delete #${caseId}`,
    [`Time: ${logTimestamp()}`, userLine(mod, "Moderator"), reason?.trim() ? `Reason: ${truncate(reason, 300)}` : null].filter(
      (line): line is string => Boolean(line),
    ),
    { avatarUrl: mod.avatarUrl, emojiCategory: "delete" },
  );
}

export function buildMuteExpiredLog(user: LogRef): LogCard {
  return card("Mute Expired", [`Time: ${logTimestamp()}`, ...userLines(user)], {
    avatarUrl: user.avatarUrl,
    emojiCategory: "modDefault",
  });
}

export function buildTempbanExpiredLog(user: LogRef): LogCard {
  return card("Temp Ban Expired", [`Time: ${logTimestamp()}`, ...userLines(user)], {
    avatarUrl: user.avatarUrl,
    emojiCategory: "modDefault",
  });
}

export function buildDmFailedLog(user: LogRef, source: string): LogCard {
  return card(
    "DM Failed",
    [`Time: ${logTimestamp()}`, ...userLines(user), `Source: ${bold(source)}`],
    { avatarUrl: user.avatarUrl, emojiCategory: "action" },
  );
}

export function buildCleanLog(input: {
  mod: LogRef;
  channel: LogRef;
  count: number;
  archiveId?: string;
  targets?: LogRef[];
}): LogCard {
  return card(
    "Clean",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.mod, "Moderator"),
      channelLine(input.channel),
      `Deleted: ${bold(String(input.count))} message${input.count === 1 ? "" : "s"}`,
      input.targets?.length
        ? `Messages from: ${input.targets.map((t) => `<@${t.id}>`).join(", ")}`
        : null,
      input.archiveId ? `Archive ID: \`${input.archiveId}\`` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.mod.avatarUrl, emojiCategory: "delete" },
  );
}

export function buildVoiceForceMoveLog(input: {
  target: LogRef;
  mod: LogRef;
  fromChannel: LogRef | null;
  toChannel: LogRef;
}): LogCard {
  return card(
    "Voice Move",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.target),
      userLine(input.mod, "Moderator"),
      input.fromChannel ? channelLine(input.fromChannel, "From") : "From: **none**",
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.target.avatarUrl, emojiCategory: "modModerate" },
  );
}

export function buildVoiceForceMoveAllLog(input: {
  mod: LogRef;
  count: number;
  fromChannel: LogRef;
  toChannel: LogRef;
}): LogCard {
  return card(
    "Voice Move",
    [
      `Time: ${logTimestamp()}`,
      userLine(input.mod, "Moderator"),
      `Moved: ${bold(String(input.count))} member${input.count === 1 ? "" : "s"}`,
      channelLine(input.fromChannel, "From"),
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.mod.avatarUrl, emojiCategory: "modModerate" },
  );
}

export function buildVoiceForceDisconnectLog(input: {
  target: LogRef;
  mod: LogRef;
  channel: LogRef;
}): LogCard {
  return card(
    "Voice Disconnect",
    [`Time: ${logTimestamp()}`, ...userLines(input.target), userLine(input.mod, "Moderator"), channelLine(input.channel)],
    { avatarUrl: input.target.avatarUrl, emojiCategory: "modModerate" },
  );
}

export function buildMemberJoinLog(user: LogRef, options?: { memberCount?: number; inviteCode?: string | null }): LogCard {
  const accountAgeMs = user.createdAt ? Date.now() - user.createdAt : null;
  const isNewAccount = accountAgeMs != null && accountAgeMs < 7 * 24 * 60 * 60 * 1000;
  return card(
    isNewAccount ? "Join — New Account" : "Join",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(user),
      options?.memberCount != null ? `Member count: ${bold(String(options.memberCount))}` : null,
      options?.inviteCode ? `Invite used: \`${options.inviteCode}\`` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: user.avatarUrl, emojiCategory: "join" },
  );
}

export function buildMemberLeaveLog(user: LogRef, options?: { memberCount?: number; roles?: LogRef[] }): LogCard {
  return card(
    "Leave",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(user),
      options?.memberCount != null ? `Member count: ${bold(String(options.memberCount))}` : null,
      options?.roles?.length ? roleList("Had roles", options.roles) : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: user.avatarUrl, emojiCategory: "leave" },
  );
}

export function buildMessageEditLog(input: {
  user: LogRef;
  channel: LogRef;
  before: string;
  after: string;
  attachments?: string[];
}): LogCard {
  const files: LogFile[] = [];
  const beforeBlock = contentField("Before", input.before, "message-before.txt", files);
  const afterBlock = contentField("After", input.after, "message-after.txt", files);
  return card(
    "Edit Message",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      channelLine(input.channel),
      input.attachments?.length ? `Attachments: ${input.attachments.join(", ")}` : null,
    ].filter((line): line is string => Boolean(line)),
    {
      avatarUrl: input.user.avatarUrl,
      extra: trimLines(`${beforeBlock}\n\n${afterBlock}`),
      files,
      emojiCategory: "edit",
    },
  );
}

export function buildMessageDeleteLog(input: {
  user: LogRef;
  channel: LogRef;
  content: string;
  attachments?: string[];
  executor?: LogRef | null;
}): LogCard {
  const files: LogFile[] = [];
  const contentBlock = contentField("Content", input.content || "(no text content)", "message-content.txt", files);
  return card(
    "Delete Message",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user, "Author"),
      channelLine(input.channel),
      input.executor ? userLine(input.executor, "Deleted by") : null,
      input.attachments?.length ? `Attachments: ${input.attachments.join(", ")}` : null,
    ].filter((line): line is string => Boolean(line)),
    {
      avatarUrl: input.user.avatarUrl,
      extra: trimLines(contentBlock),
      files,
      emojiCategory: "delete",
    },
  );
}

export function buildVoiceJoinLog(user: LogRef, channel: LogRef): LogCard {
  return card("Voice Join", [`Time: ${logTimestamp()}`, ...userLines(user), channelLine(channel)], {
    avatarUrl: user.avatarUrl,
    emojiCategory: "join",
  });
}

export function buildVoiceLeaveLog(user: LogRef, channel: LogRef): LogCard {
  return card("Voice Leave", [`Time: ${logTimestamp()}`, ...userLines(user), channelLine(channel)], {
    avatarUrl: user.avatarUrl,
    emojiCategory: "leave",
  });
}

export function buildVoiceMoveLog(input: {
  user: LogRef;
  fromChannel: LogRef;
  toChannel: LogRef;
}): LogCard {
  return card(
    "Voice Move",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      channelLine(input.fromChannel, "From"),
      channelLine(input.toChannel, "To"),
    ],
    { avatarUrl: input.user.avatarUrl, emojiCategory: "voice" },
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
    ...userLines(input.user),
    input.mod ? userLine(input.mod, "Moderator") : null,
    `Before: ${bold(truncate(input.oldNick, 32))}`,
    `After: ${bold(truncate(input.newNick, 32))}`,
  ].filter((line): line is string => Boolean(line));

  return card("Nickname Change", information, { avatarUrl: input.user.avatarUrl, emojiCategory: "edit" });
}

export function buildRoleChangeLog(input: {
  user: LogRef;
  added: LogRef[];
  removed: LogRef[];
  mod?: LogRef | null;
}): LogCard {
  const information = [
    `Time: ${logTimestamp()}`,
    ...userLines(input.user),
    input.mod ? userLine(input.mod, "Changed by") : null,
    roleList("Added", input.added),
    roleList("Removed", input.removed),
  ].filter((line): line is string => Boolean(line));

  return card("Role Change", information, { avatarUrl: input.user.avatarUrl, emojiCategory: "edit" });
}

export function buildThreadCreateLog(input: {
  user: LogRef;
  thread: LogRef;
  parentChannel: LogRef;
  type?: string;
}): LogCard {
  return card(
    "Thread Created",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user, "Owner"),
      channelLine(input.parentChannel, "Parent"),
      `Thread: ${bold(input.thread.name ?? input.thread.id)} (\`${input.thread.id}\`)`,
      input.type ? `Type: ${bold(input.type)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "create" },
  );
}

export function buildThreadArchiveLog(input: {
  thread: LogRef;
  parentChannel: LogRef;
  archived: boolean;
  mod?: LogRef | null;
}): LogCard {
  return card(
    input.archived ? "Thread Archived" : "Thread Unarchived",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.parentChannel, "Parent"),
      `Thread: ${bold(input.thread.name ?? input.thread.id)} (\`${input.thread.id}\`)`,
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "edit" },
  );
}

export function buildMessagePinLog(input: {
  user: LogRef;
  channel: LogRef;
  pinned: boolean;
}): LogCard {
  return card(
    input.pinned ? "Message Pinned" : "Message Unpinned",
    [`Time: ${logTimestamp()}`, ...userLines(input.user), channelLine(input.channel)],
    { avatarUrl: input.user.avatarUrl, emojiCategory: "action" },
  );
}

export function buildAutomodLog(input: {
  user: LogRef;
  channel: LogRef;
  reason: string;
  action: string;
  content?: string;
}): LogCard {
  const files: LogFile[] = [];
  const extra = input.content ? contentField("Triggering content", input.content, "automod-content.txt", files) : undefined;
  return card(
    "Automod",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      channelLine(input.channel),
      `Rule: ${bold(input.reason)}`,
      `Action: ${bold(input.action)}`,
    ],
    { avatarUrl: input.user.avatarUrl, extra: extra ? trimLines(extra) : undefined, files, emojiCategory: "modModerate" },
  );
}

export function buildCensorLog(input: {
  user: LogRef;
  channel: LogRef;
  pattern: string;
  action: string;
}): LogCard {
  return card(
    "Censor",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      channelLine(input.channel),
      `Pattern: \`${truncate(input.pattern, 100)}\``,
      `Action: ${bold(input.action)}`,
    ],
    { avatarUrl: input.user.avatarUrl, emojiCategory: "modModerate" },
  );
}

export function buildRaidDetectedLog(input: {
  user: LogRef;
  joinCount: number;
  windowMs: number;
  recentJoiners?: LogRef[];
}): LogCard {
  return card(
    "Raid Detected",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user, "Latest join"),
      `Threshold: ${bold(String(input.joinCount))} joins / ${Math.round(input.windowMs / 1000)}s`,
      input.recentJoiners?.length
        ? `Recent joiners (${input.recentJoiners.length}): ${input.recentJoiners.map((r) => `<@${r.id}>`).join(", ")}`
        : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "modSevere" },
  );
}

export function buildMemberKickLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
}): LogCard {
  return card(
    "Member Kicked",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      `Reason: ${input.reason?.trim() ? truncate(input.reason, 400) : "*(none given)*"}`,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "modSevere" },
  );
}

export function buildMemberBanLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
  deleteMessageDays?: number;
}): LogCard {
  return card(
    "Member Banned",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      input.deleteMessageDays != null ? `Message history purged: ${bold(`${input.deleteMessageDays}d`)}` : null,
      `Reason: ${input.reason?.trim() ? truncate(input.reason, 400) : "*(none given)*"}`,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "modSevere" },
  );
}

export function buildMemberUnbanLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  reason?: string | null;
}): LogCard {
  return card(
    "Member Unbanned",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 300)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "unban" },
  );
}

export function buildTimeoutChangeLog(input: {
  user: LogRef;
  mod?: LogRef | null;
  before: string | null;
  after: string | null;
  reason?: string | null;
}): LogCard {
  return card(
    "Timeout Change",
    [
      `Time: ${logTimestamp()}`,
      ...userLines(input.user),
      input.mod ? userLine(input.mod, "Moderator") : null,
      `Before: ${bold(input.before ?? "none")}`,
      `After: ${bold(input.after ?? "none")}`,
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 300)}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "modModerate" },
  );
}

export function buildChannelCreateLog(input: {
  channel: LogRef;
  type: string;
  mod?: LogRef | null;
  parent?: LogRef | null;
}): LogCard {
  return card(
    "Channel Created",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      `Type: ${bold(input.type)}`,
      input.parent ? channelLine(input.parent, "Category") : null,
      input.mod ? userLine(input.mod, "Created by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "create" },
  );
}

export function buildChannelDeleteLog(input: {
  channel: LogRef;
  type: string;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Channel Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Channel: ${bold(input.channel.name ?? input.channel.id)} (\`${input.channel.id}\`)`,
      `Type: ${bold(input.type)}`,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "delete" },
  );
}

export function buildChannelUpdateLog(input: {
  channel: LogRef;
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Channel Updated",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      input.mod ? userLine(input.mod, "Updated by") : null,
    ].filter((line): line is string => Boolean(line)),
    {
      extra: input.changes.length ? trimLines(`**Changes (${input.changes.length})**\n${input.changes.map((c) => `• ${c}`).join("\n")}`) : undefined,
      emojiCategory: "edit",
    },
  );
}

export function buildRoleCreateLog(input: { role: LogRef; mod?: LogRef | null; color?: string | null }): LogCard {
  return card(
    "Role Created",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.color ? `Color: ${bold(input.color)}` : null,
      input.mod ? userLine(input.mod, "Created by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "create" },
  );
}

export function buildRoleDeleteLog(input: { role: LogRef; mod?: LogRef | null }): LogCard {
  return card(
    "Role Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "delete" },
  );
}

export function buildRoleUpdateLog(input: {
  role: LogRef;
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Role Updated",
    [
      `Time: ${logTimestamp()}`,
      `Role: ${bold(input.role.name ?? input.role.id)} (\`${input.role.id}\`)`,
      input.mod ? userLine(input.mod, "Updated by") : null,
    ].filter((line): line is string => Boolean(line)),
    {
      extra: input.changes.length ? trimLines(`**Changes (${input.changes.length})**\n${input.changes.map((c) => `• ${c}`).join("\n")}`) : undefined,
      emojiCategory: "edit",
    },
  );
}

export function buildGuildUpdateLog(input: {
  changes: string[];
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Server Updated",
    [`Time: ${logTimestamp()}`, input.mod ? userLine(input.mod, "Updated by") : null].filter(
      (line): line is string => Boolean(line),
    ),
    {
      extra: input.changes.length ? trimLines(`**Changes (${input.changes.length})**\n${input.changes.map((c) => `• ${c}`).join("\n")}`) : undefined,
      emojiCategory: "serverUpdate",
    },
  );
}

export function buildEmojiLog(input: {
  action: "create" | "delete" | "update";
  name: string;
  id: string;
  mod?: LogRef | null;
  animated?: boolean;
}): LogCard {
  const title =
    input.action === "create" ? "Emoji Created" : input.action === "delete" ? "Emoji Deleted" : "Emoji Updated";
  return card(
    title,
    [
      `Time: ${logTimestamp()}`,
      `Emoji: ${bold(input.name)} (\`${input.id}\`)`,
      input.animated != null ? `Animated: ${bold(input.animated ? "yes" : "no")}` : null,
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "emojiSticker" },
  );
}

export function buildStickerLog(input: {
  action: "create" | "delete" | "update";
  name: string;
  id: string;
  mod?: LogRef | null;
  description?: string | null;
}): LogCard {
  const title =
    input.action === "create" ? "Sticker Created" : input.action === "delete" ? "Sticker Deleted" : "Sticker Updated";
  return card(
    title,
    [
      `Time: ${logTimestamp()}`,
      `Sticker: ${bold(input.name)} (\`${input.id}\`)`,
      input.description?.trim() ? `Description: ${truncate(input.description, 200)}` : null,
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "emojiSticker" },
  );
}

export function buildInviteCreateLog(input: {
  code: string;
  channel?: LogRef | null;
  inviter?: LogRef | null;
  maxUses?: number | null;
  maxAge?: number | null;
  temporary?: boolean;
}): LogCard {
  return card(
    "Invite Created",
    [
      `Time: ${logTimestamp()}`,
      `Code: \`${input.code}\``,
      input.channel ? channelLine(input.channel) : null,
      input.inviter ? userLine(input.inviter, "Inviter") : null,
      input.maxUses != null ? `Max uses: ${bold(String(input.maxUses || "unlimited"))}` : null,
      input.maxAge != null ? `Max age: ${bold(input.maxAge ? `${input.maxAge}s` : "forever")}` : null,
      input.temporary != null ? `Temporary membership: ${bold(input.temporary ? "yes" : "no")}` : null,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.inviter?.avatarUrl, emojiCategory: "create" },
  );
}

export function buildInviteDeleteLog(input: {
  code: string;
  channel?: LogRef | null;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Invite Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Code: \`${input.code}\``,
      input.channel ? channelLine(input.channel) : null,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "delete" },
  );
}

export function buildWebhookUpdateLog(input: {
  channel: LogRef;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Webhooks Updated",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      input.mod ? userLine(input.mod, "By") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "serverUpdate" },
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
      ...userLines(input.user),
      input.channel ? channelLine(input.channel) : null,
      input.detail,
    ].filter((line): line is string => Boolean(line)),
    { avatarUrl: input.user.avatarUrl, emojiCategory: "voice" },
  );
}

export function buildThreadDeleteLog(input: {
  thread: LogRef;
  parentChannel?: LogRef | null;
  mod?: LogRef | null;
}): LogCard {
  return card(
    "Thread Deleted",
    [
      `Time: ${logTimestamp()}`,
      `Thread: ${bold(input.thread.name ?? input.thread.id)} (\`${input.thread.id}\`)`,
      input.parentChannel ? channelLine(input.parentChannel, "Parent") : null,
      input.mod ? userLine(input.mod, "Deleted by") : null,
    ].filter((line): line is string => Boolean(line)),
    { emojiCategory: "delete" },
  );
}

export function buildMessageBulkDeleteLog(input: {
  channel: LogRef;
  count: number;
  mod?: LogRef | null;
  authorCounts?: Array<{ user: LogRef; count: number }>;
}): LogCard {
  const files: LogFile[] = [];
  let extra: string | undefined;
  if (input.authorCounts?.length) {
    const lines = input.authorCounts
      .sort((a, b) => b.count - a.count)
      .map((entry) => `<@${entry.user.id}> — ${entry.count} message${entry.count === 1 ? "" : "s"}`)
      .join("\n");
    extra = contentField("By author", lines, "bulk-delete-authors.txt", files);
  }
  return card(
    "Bulk Delete",
    [
      `Time: ${logTimestamp()}`,
      channelLine(input.channel),
      `Count: ${bold(String(input.count))}`,
      input.mod ? userLine(input.mod, "Moderator") : null,
    ].filter((line): line is string => Boolean(line)),
    { extra: extra ? trimLines(extra) : undefined, files, emojiCategory: "delete" },
  );
}

export function buildTicketOpenLog(input: {
  ticketNumber: number;
  opener: LogRef;
  category: string;
  channel: LogRef;
}): LogCard {
  return card(
    `Ticket #${input.ticketNumber} Opened`,
    [`Time: ${logTimestamp()}`, userLine(input.opener, "Opened by"), `Category: ${bold(input.category)}`, channelLine(input.channel)],
    { avatarUrl: input.opener.avatarUrl, emojiCategory: "create" },
  );
}

export function buildTicketClaimLog(input: {
  ticketNumber: number;
  staff: LogRef;
  channel: LogRef;
}): LogCard {
  return card(
    `Ticket #${input.ticketNumber} Claimed`,
    [`Time: ${logTimestamp()}`, userLine(input.staff, "Claimed by"), channelLine(input.channel)],
    { avatarUrl: input.staff.avatarUrl, emojiCategory: "action" },
  );
}

export function buildTicketCloseLog(input: {
  ticketNumber: number;
  actor: LogRef;
  channel: LogRef;
  reason?: string | null;
}): LogCard {
  return card(
    `Ticket #${input.ticketNumber} Closed`,
    [
      `Time: ${logTimestamp()}`,
      userLine(input.actor, "Closed by"),
      channelLine(input.channel),
      input.reason?.trim() ? `Reason: ${truncate(input.reason, 400)}` : "Reason: *(none given)*",
    ],
    { avatarUrl: input.actor.avatarUrl, emojiCategory: "delete" },
  );
}

export function buildGenericServerLog(
  title: string,
  lines: string[],
  avatarUrl?: string | null,
  emojiCategory: LogEmojiCategory = "action",
): LogCard {
  return card(title, [`Time: ${logTimestamp()}`, ...lines], { avatarUrl, emojiCategory });
}
