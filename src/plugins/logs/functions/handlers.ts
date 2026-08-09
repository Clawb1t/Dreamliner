import {
  AuditLogEvent,
  ChannelType,
  type AnyThreadChannel,
  type Guild,
  type GuildBan,
  type GuildEmoji,
  type GuildMember,
  type Invite,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type Role,
  type Sticker,
  type VoiceState,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { findAuditExecutor, findKickOrBanReason } from "../../../core/logging/audit.js";
import {
  buildChannelCreateLog,
  buildChannelDeleteLog,
  buildChannelUpdateLog,
  buildEmojiLog,
  buildGuildUpdateLog,
  buildInviteCreateLog,
  buildInviteDeleteLog,
  buildMemberBanLog,
  buildMemberJoinLog,
  buildMemberKickLog,
  buildMemberLeaveLog,
  buildMemberUnbanLog,
  buildMessageBulkDeleteLog,
  buildMessageDeleteLog,
  buildMessageEditLog,
  buildMessagePinLog,
  buildNicknameChangeLog,
  buildRoleChangeLog,
  buildRoleCreateLog,
  buildRoleDeleteLog,
  buildRoleUpdateLog,
  buildStickerLog,
  buildThreadArchiveLog,
  buildThreadCreateLog,
  buildThreadDeleteLog,
  buildTimeoutChangeLog,
  buildVoiceFlagLog,
  buildVoiceJoinLog,
  buildVoiceLeaveLog,
  buildVoiceMoveLog,
  buildWebhookUpdateLog,
} from "../../../core/logging/format.js";
import { deleteLogMessage, getLogMessage, upsertLogMessage } from "../../../core/logging/messageStore.js";
import { getServerLogChannelId } from "../../../core/logging/channels.js";
import { sendServerLog } from "../../../core/logging/send.js";
import { isAnyMessageLogEnabled } from "../../../core/logging/toggles.js";
import { isForcedVoiceAction } from "../../../core/logging/voice.js";

function channelRef(channelId: string, name?: string | null) {
  return { id: channelId, name: name ?? undefined };
}

function userRef(userId: string, name?: string | null, avatarUrl?: string | null) {
  return { id: userId, name: name ?? undefined, avatarUrl: avatarUrl ?? undefined };
}

function channelTypeName(type: ChannelType | number): string {
  return ChannelType[type] ?? String(type);
}

function shouldStoreMessages(guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>): boolean {
  return Boolean(getServerLogChannelId(guildConfig)) || isAnyMessageLogEnabled(guildConfig);
}

function formatTimeout(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (!message.guild || message.author?.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!shouldStoreMessages(guildConfig)) return;
  await upsertLogMessage(message);
}

export async function handleMemberJoin(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  await sendServerLog(
    member.client,
    guildConfig,
    buildMemberJoinLog(userRef(member.id, member.user.username, member.displayAvatarURL({ size: 128 }))),
    {
      guildId: member.guild.id,
      eventType: "member_join",
      targetId: member.id,
      summary: `${member.user.username} joined`,
    },
  );
}

export async function handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  if (!member.guild) return;
  const user = member.user ?? (await member.client.users.fetch(member.id).catch(() => null));
  if (!user || user.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  const kick = await findKickOrBanReason(member.guild, AuditLogEvent.MemberKick, member.id);
  if (kick) {
    await sendServerLog(
      member.client,
      guildConfig,
      buildMemberKickLog({
        user: userRef(user.id, user.username, user.displayAvatarURL({ size: 128 })),
        mod: kick.executorId ? { id: kick.executorId } : null,
        reason: kick.reason,
      }),
      {
        guildId: member.guild.id,
        eventType: "member_kick",
        targetId: user.id,
        actorId: kick.executorId,
        summary: `${user.username} was kicked`,
        payload: { reason: kick.reason },
      },
    );
    return;
  }

  await sendServerLog(
    member.client,
    guildConfig,
    buildMemberLeaveLog(userRef(user.id, user.username, user.displayAvatarURL({ size: 128 }))),
    {
      guildId: member.guild.id,
      eventType: "member_leave",
      targetId: user.id,
      summary: `${user.username} left`,
    },
  );
}

export async function handleMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
  if (!newMember.guild || newMember.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(newMember.guild.id);
  const user = userRef(newMember.id, newMember.user.username, newMember.displayAvatarURL({ size: 128 }));

  const oldNick = oldMember.nickname ?? oldMember.user.username;
  const newNick = newMember.nickname ?? newMember.user.username;
  if (oldNick !== newNick) {
    const mod = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberUpdate, {
      targetId: newMember.id,
    });
    await sendServerLog(
      newMember.client,
      guildConfig,
      buildNicknameChangeLog({
        user,
        mod: mod ? { id: mod.id, name: mod.name ?? undefined } : undefined,
        oldNick,
        newNick,
      }),
      {
        guildId: newMember.guild.id,
        eventType: "member_nick",
        targetId: newMember.id,
        actorId: mod?.id,
        summary: `Nickname: ${oldNick} -> ${newNick}`,
        payload: { before: oldNick, after: newNick },
      },
    );
  }

  const added = newMember.roles.cache.filter(
    (role) => !oldMember.roles.cache.has(role.id) && role.id !== newMember.guild.id,
  );
  const removed = oldMember.roles.cache.filter(
    (role) => !newMember.roles.cache.has(role.id) && role.id !== newMember.guild.id,
  );
  if (added.size || removed.size) {
    const mod = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, {
      targetId: newMember.id,
    });
    await sendServerLog(
      newMember.client,
      guildConfig,
      buildRoleChangeLog({
        user,
        added: [...added.values()].map((role) => ({ id: role.id, name: role.name })),
        removed: [...removed.values()].map((role) => ({ id: role.id, name: role.name })),
      }),
      {
        guildId: newMember.guild.id,
        eventType: "member_roles",
        targetId: newMember.id,
        actorId: mod?.id,
        summary: `Roles updated for ${newMember.user.username}`,
        payload: {
          added: [...added.keys()],
          removed: [...removed.keys()],
        },
      },
    );
  }

  const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
  const newTimeout = newMember.communicationDisabledUntilTimestamp;
  if (oldTimeout !== newTimeout) {
    const mod = await findAuditExecutor(newMember.guild, AuditLogEvent.MemberUpdate, {
      targetId: newMember.id,
    });
    await sendServerLog(
      newMember.client,
      guildConfig,
      buildTimeoutChangeLog({
        user,
        mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
        before: formatTimeout(oldTimeout),
        after: formatTimeout(newTimeout),
      }),
      {
        guildId: newMember.guild.id,
        eventType: "member_timeout",
        targetId: newMember.id,
        actorId: mod?.id,
        summary: `Timeout changed for ${newMember.user.username}`,
        payload: { before: oldTimeout, after: newTimeout },
      },
    );
  }
}

export async function handleMessageUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  if (!newMessage.guild || newMessage.author?.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(newMessage.guild.id);
  if (!shouldStoreMessages(guildConfig)) return;

  const storedBefore = await getLogMessage(newMessage.guild.id, newMessage.channelId, newMessage.id);

  if (!oldMessage.content && oldMessage.partial) {
    try {
      await oldMessage.fetch();
    } catch {
      // use stored content below
    }
  }
  if (newMessage.partial) {
    try {
      await newMessage.fetch();
    } catch {
      return;
    }
  }
  if (!newMessage.author) return;

  const beforeContent = oldMessage.content ?? storedBefore?.content ?? "";
  const afterContent = newMessage.content ?? "";
  const pinChanged = oldMessage.pinned !== newMessage.pinned;
  const channelName =
    newMessage.channel.isTextBased() && "name" in newMessage.channel
      ? newMessage.channel.name
      : storedBefore?.channelName;

  if (pinChanged && newMessage.author) {
    await sendServerLog(
      newMessage.client,
      guildConfig,
      buildMessagePinLog({
        user: userRef(
          newMessage.author.id,
          newMessage.author.username,
          newMessage.author.displayAvatarURL({ size: 128 }),
        ),
        channel: channelRef(newMessage.channelId, channelName),
        pinned: Boolean(newMessage.pinned),
      }),
      {
        guildId: newMessage.guild.id,
        eventType: "message_pin",
        targetId: newMessage.author.id,
        channelId: newMessage.channelId,
        messageId: newMessage.id,
        summary: newMessage.pinned ? "Message pinned" : "Message unpinned",
      },
    );
  }

  if (beforeContent === afterContent) {
    await upsertLogMessage(newMessage);
    return;
  }

  const attachments = [...newMessage.attachments.values()].map((a) => a.name).filter(Boolean);

  await sendServerLog(
    newMessage.client,
    guildConfig,
    buildMessageEditLog({
      user: userRef(
        newMessage.author.id,
        newMessage.author.username,
        newMessage.author.displayAvatarURL({ size: 128 }),
      ),
      channel: channelRef(newMessage.channelId, channelName),
      before: beforeContent,
      after: afterContent,
    }),
    {
      guildId: newMessage.guild.id,
      eventType: "message_edit",
      targetId: newMessage.author.id,
      channelId: newMessage.channelId,
      messageId: newMessage.id,
      summary: `Edited in #${channelName ?? newMessage.channelId}`,
      payload: { before: beforeContent, after: afterContent, attachments },
    },
  );

  await upsertLogMessage(newMessage);
}

export async function handleMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!shouldStoreMessages(guildConfig)) return;

  const stored = await getLogMessage(message.guild.id, message.channelId, message.id);

  let resolved = message;
  if (message.partial) {
    try {
      resolved = await message.fetch();
    } catch {
      // fall back to stored snapshot
    }
  }

  const authorId = resolved.author?.id ?? stored?.authorId;
  if (!authorId) {
    await deleteLogMessage(message.guild.id, message.channelId, message.id);
    return;
  }

  if (resolved.author?.bot) {
    await deleteLogMessage(message.guild.id, message.channelId, message.id);
    return;
  }

  const channelName =
    resolved.channel.isTextBased() && "name" in resolved.channel
      ? resolved.channel.name
      : stored?.channelName;

  const authorAvatar =
    resolved.author?.displayAvatarURL({ size: 128 }) ??
    (await resolved.client.users
      .fetch(authorId)
      .then((u) => u.displayAvatarURL({ size: 128 }))
      .catch(() => null));

  const mod = await findAuditExecutor(message.guild, AuditLogEvent.MessageDelete, {
    targetId: authorId,
    maxAgeMs: 12_000,
  });

  const content = resolved.content ?? stored?.content ?? "";
  const attachments = resolved.attachments
    ? [...resolved.attachments.values()].map((a) => a.name).filter(Boolean)
    : [];

  await sendServerLog(
    resolved.client,
    guildConfig,
    buildMessageDeleteLog({
      user: userRef(authorId, resolved.author?.username ?? stored?.authorName, authorAvatar),
      channel: channelRef(resolved.channelId, channelName),
      content,
    }),
    {
      guildId: message.guild.id,
      eventType: "message_delete",
      targetId: authorId,
      actorId: mod?.id,
      channelId: resolved.channelId,
      messageId: resolved.id,
      summary: `Deleted in #${channelName ?? resolved.channelId}`,
      payload: { content, attachments, executorId: mod?.id ?? null },
    },
  );

  await deleteLogMessage(message.guild.id, message.channelId, message.id);
}

export async function handleMessageBulkDelete(
  messages: ReadonlyMap<string, Message | PartialMessage>,
  channel: { id: string; name?: string | null; guild: Guild | null },
): Promise<void> {
  const guild = channel.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.MessageBulkDelete, {
    targetId: channel.id,
    maxAgeMs: 20_000,
  });

  await sendServerLog(
    guild.client,
    guildConfig,
    buildMessageBulkDeleteLog({
      channel: channelRef(channel.id, channel.name),
      count: messages.size,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "message_bulk_delete",
      actorId: mod?.id,
      channelId: channel.id,
      summary: `${messages.size} messages bulk deleted`,
      payload: { count: messages.size, messageIds: [...messages.keys()].slice(0, 100) },
    },
  );

  for (const message of messages.values()) {
    if (message.guild) {
      await deleteLogMessage(message.guild.id, message.channelId, message.id).catch(() => null);
    }
  }
}

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  if (!guild || !member || member.user.bot) return;
  if (isForcedVoiceAction(guild.id, member.id)) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const user = userRef(member.id, member.user.username, member.displayAvatarURL({ size: 128 }));
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;
  const activeChannelId = newChannelId ?? oldChannelId;
  const activeChannel = newState.channel ?? oldState.channel;

  if (!oldChannelId && newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceJoinLog(user, channelRef(newChannelId, newState.channel?.name)),
      {
        guildId: guild.id,
        eventType: "voice_join",
        targetId: member.id,
        channelId: newChannelId,
        summary: `${member.user.username} joined voice`,
      },
    );
  } else if (oldChannelId && !newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceLeaveLog(user, channelRef(oldChannelId, oldState.channel?.name)),
      {
        guildId: guild.id,
        eventType: "voice_leave",
        targetId: member.id,
        channelId: oldChannelId,
        summary: `${member.user.username} left voice`,
      },
    );
  } else if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceMoveLog({
        user,
        fromChannel: channelRef(oldChannelId, oldState.channel?.name),
        toChannel: channelRef(newChannelId, newState.channel?.name),
      }),
      {
        guildId: guild.id,
        eventType: "voice_move",
        targetId: member.id,
        channelId: newChannelId,
        summary: `${member.user.username} moved voice channels`,
        payload: { from: oldChannelId, to: newChannelId },
      },
    );
  }

  const flagChannel = activeChannelId
    ? channelRef(activeChannelId, activeChannel?.name)
    : null;

  const flags: Array<{
    changed: boolean;
    eventType:
      | "voice_server_mute"
      | "voice_server_deafen"
      | "voice_self_mute"
      | "voice_self_deafen"
      | "voice_stream"
      | "voice_video";
    title: string;
    detail: string;
  }> = [
    {
      changed: oldState.serverMute !== newState.serverMute,
      eventType: "voice_server_mute",
      title: newState.serverMute ? "🔇 Server Muted" : "🔊 Server Unmuted",
      detail: `Server mute: ${newState.serverMute ? "on" : "off"}`,
    },
    {
      changed: oldState.serverDeaf !== newState.serverDeaf,
      eventType: "voice_server_deafen",
      title: newState.serverDeaf ? "🔇 Server Deafened" : "🔊 Server Undeafened",
      detail: `Server deafen: ${newState.serverDeaf ? "on" : "off"}`,
    },
    {
      changed: oldState.selfMute !== newState.selfMute,
      eventType: "voice_self_mute",
      title: newState.selfMute ? "🔇 Self Muted" : "🔊 Self Unmuted",
      detail: `Self mute: ${newState.selfMute ? "on" : "off"}`,
    },
    {
      changed: oldState.selfDeaf !== newState.selfDeaf,
      eventType: "voice_self_deafen",
      title: newState.selfDeaf ? "🔇 Self Deafened" : "🔊 Self Undeafened",
      detail: `Self deafen: ${newState.selfDeaf ? "on" : "off"}`,
    },
    {
      changed: oldState.streaming !== newState.streaming,
      eventType: "voice_stream",
      title: newState.streaming ? "📡 Stream Started" : "📡 Stream Ended",
      detail: `Streaming: ${newState.streaming ? "on" : "off"}`,
    },
    {
      changed: oldState.selfVideo !== newState.selfVideo,
      eventType: "voice_video",
      title: newState.selfVideo ? "📷 Camera On" : "📷 Camera Off",
      detail: `Camera: ${newState.selfVideo ? "on" : "off"}`,
    },
  ];

  for (const flag of flags) {
    if (!flag.changed) continue;
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceFlagLog({
        title: flag.title,
        user,
        channel: flagChannel,
        detail: flag.detail,
      }),
      {
        guildId: guild.id,
        eventType: flag.eventType,
        targetId: member.id,
        channelId: activeChannelId,
        summary: flag.detail,
      },
    );
  }
}

export async function handleThreadCreate(thread: AnyThreadChannel): Promise<void> {
  if (!thread.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(thread.guild.id);
  const ownerId = thread.ownerId;
  const owner = ownerId ? await thread.client.users.fetch(ownerId).catch(() => null) : null;
  const parent = thread.parent;

  await sendServerLog(
    thread.client,
    guildConfig,
    buildThreadCreateLog({
      user: userRef(owner?.id ?? "unknown", owner?.username, owner?.displayAvatarURL({ size: 128 })),
      thread: { id: thread.id, name: thread.name },
      parentChannel: channelRef(parent?.id ?? thread.parentId ?? thread.id, parent?.name),
    }),
    {
      guildId: thread.guild.id,
      eventType: "thread_create",
      actorId: owner?.id,
      channelId: thread.id,
      summary: `Thread created: ${thread.name}`,
    },
  );
}

export async function handleThreadUpdate(
  oldThread: AnyThreadChannel,
  newThread: AnyThreadChannel,
): Promise<void> {
  if (!newThread.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(newThread.guild.id);
  const parent = newThread.parent;
  const changes: string[] = [];

  if (oldThread.archived !== newThread.archived) {
    await sendServerLog(
      newThread.client,
      guildConfig,
      buildThreadArchiveLog({
        thread: { id: newThread.id, name: newThread.name },
        parentChannel: channelRef(parent?.id ?? newThread.parentId ?? newThread.id, parent?.name),
        archived: newThread.archived ?? false,
      }),
      {
        guildId: newThread.guild.id,
        eventType: "thread_update",
        channelId: newThread.id,
        summary: newThread.archived ? "Thread archived" : "Thread unarchived",
        payload: { archived: newThread.archived },
      },
    );
  }

  if (oldThread.name !== newThread.name) changes.push(`Name: ${oldThread.name} -> ${newThread.name}`);
  if (oldThread.locked !== newThread.locked) {
    changes.push(`Locked: ${oldThread.locked ? "yes" : "no"} -> ${newThread.locked ? "yes" : "no"}`);
  }
  if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
    changes.push(`Slowmode: ${oldThread.rateLimitPerUser}s -> ${newThread.rateLimitPerUser}s`);
  }

  if (changes.length && oldThread.archived === newThread.archived) {
    await sendServerLog(
      newThread.client,
      guildConfig,
      buildChannelUpdateLog({
        channel: channelRef(newThread.id, newThread.name),
        changes,
      }),
      {
        guildId: newThread.guild.id,
        eventType: "thread_update",
        channelId: newThread.id,
        summary: `Thread updated: ${newThread.name}`,
        payload: { changes },
      },
    );
  }
}

export async function handleThreadDelete(thread: AnyThreadChannel): Promise<void> {
  if (!thread.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(thread.guild.id);
  const mod = await findAuditExecutor(thread.guild, AuditLogEvent.ThreadDelete, {
    targetId: thread.id,
  });
  const parent = thread.parent;
  await sendServerLog(
    thread.client,
    guildConfig,
    buildThreadDeleteLog({
      thread: { id: thread.id, name: thread.name },
      parentChannel: parent ? channelRef(parent.id, parent.name) : null,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: thread.guild.id,
      eventType: "thread_delete",
      actorId: mod?.id,
      channelId: thread.id,
      summary: `Thread deleted: ${thread.name}`,
    },
  );
}

export async function handleGuildBanAdd(ban: GuildBan): Promise<void> {
  if (ban.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(ban.guild.id);
  const detail = await findKickOrBanReason(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  await sendServerLog(
    ban.client,
    guildConfig,
    buildMemberBanLog({
      user: userRef(ban.user.id, ban.user.username, ban.user.displayAvatarURL({ size: 128 })),
      mod: detail?.executorId ? { id: detail.executorId } : null,
      reason: detail?.reason ?? ban.reason,
    }),
    {
      guildId: ban.guild.id,
      eventType: "member_ban",
      targetId: ban.user.id,
      actorId: detail?.executorId,
      summary: `${ban.user.username} banned`,
      payload: { reason: detail?.reason ?? ban.reason },
    },
  );
}

export async function handleGuildBanRemove(ban: GuildBan): Promise<void> {
  if (ban.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(ban.guild.id);
  const mod = await findAuditExecutor(ban.guild, AuditLogEvent.MemberBanRemove, {
    targetId: ban.user.id,
  });
  await sendServerLog(
    ban.client,
    guildConfig,
    buildMemberUnbanLog({
      user: userRef(ban.user.id, ban.user.username, ban.user.displayAvatarURL({ size: 128 })),
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: ban.guild.id,
      eventType: "member_unban",
      targetId: ban.user.id,
      actorId: mod?.id,
      summary: `${ban.user.username} unbanned`,
    },
  );
}

export async function handleChannelCreate(channel: GuildBasedChannel): Promise<void> {
  if (!channel.guild || channel.isThread()) return;
  const ch = channel as NonThreadGuildBasedChannel;
  const guildConfig = await configManager.getEffectiveConfig(channel.guild.id);
  const mod = await findAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, {
    targetId: ch.id,
  });
  await sendServerLog(
    channel.client,
    guildConfig,
    buildChannelCreateLog({
      channel: channelRef(ch.id, ch.name),
      type: channelTypeName(ch.type),
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: channel.guild.id,
      eventType: "channel_create",
      actorId: mod?.id,
      channelId: ch.id,
      summary: `Channel created: ${ch.name}`,
    },
  );
}

export async function handleChannelDelete(
  channel: GuildBasedChannel | { id: string; name?: string; type?: ChannelType; guild: Guild },
): Promise<void> {
  const guild = "guild" in channel ? channel.guild : null;
  if (!guild) return;
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.ChannelDelete, { targetId: channel.id });
  const name = "name" in channel ? channel.name : channel.id;
  const type = "type" in channel && channel.type != null ? channelTypeName(channel.type) : "unknown";
  await sendServerLog(
    guild.client,
    guildConfig,
    buildChannelDeleteLog({
      channel: channelRef(channel.id, name),
      type,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "channel_delete",
      actorId: mod?.id,
      channelId: channel.id,
      summary: `Channel deleted: ${name}`,
    },
  );
}

export async function handleChannelUpdate(
  oldChannel: GuildBasedChannel,
  newChannel: GuildBasedChannel,
): Promise<void> {
  if (!newChannel.guild || newChannel.isThread() || oldChannel.isThread()) return;
  const oldCh = oldChannel as NonThreadGuildBasedChannel;
  const newCh = newChannel as NonThreadGuildBasedChannel;
  const changes: string[] = [];
  if (oldCh.name !== newCh.name) changes.push(`Name: ${oldCh.name} -> ${newCh.name}`);
  if ("topic" in oldCh && "topic" in newCh && oldCh.topic !== newCh.topic) {
    changes.push("Topic changed");
  }
  if ("nsfw" in oldCh && "nsfw" in newCh && oldCh.nsfw !== newCh.nsfw) {
    changes.push(`NSFW: ${oldCh.nsfw ? "on" : "off"} -> ${newCh.nsfw ? "on" : "off"}`);
  }
  if (
    "rateLimitPerUser" in oldCh &&
    "rateLimitPerUser" in newCh &&
    oldCh.rateLimitPerUser !== newCh.rateLimitPerUser
  ) {
    changes.push(`Slowmode: ${oldCh.rateLimitPerUser}s -> ${newCh.rateLimitPerUser}s`);
  }
  if ("parentId" in oldCh && "parentId" in newCh && oldCh.parentId !== newCh.parentId) {
    changes.push(`Category: ${oldCh.parentId ?? "none"} -> ${newCh.parentId ?? "none"}`);
  }
  if (!changes.length) return;

  const guildConfig = await configManager.getEffectiveConfig(newChannel.guild.id);
  const mod = await findAuditExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, {
    targetId: newChannel.id,
  });
  await sendServerLog(
    newChannel.client,
    guildConfig,
    buildChannelUpdateLog({
      channel: channelRef(newChannel.id, newCh.name),
      changes,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: newChannel.guild.id,
      eventType: "channel_update",
      actorId: mod?.id,
      channelId: newChannel.id,
      summary: `Channel updated: ${newCh.name}`,
      payload: { changes },
    },
  );
}

export async function handleRoleCreate(role: Role): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(role.guild.id);
  const mod = await findAuditExecutor(role.guild, AuditLogEvent.RoleCreate, { targetId: role.id });
  await sendServerLog(
    role.client,
    guildConfig,
    buildRoleCreateLog({
      role: { id: role.id, name: role.name },
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: role.guild.id,
      eventType: "role_create",
      actorId: mod?.id,
      summary: `Role created: ${role.name}`,
      payload: { roleId: role.id, name: role.name },
    },
  );
}

export async function handleRoleDelete(role: Role): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(role.guild.id);
  const mod = await findAuditExecutor(role.guild, AuditLogEvent.RoleDelete, { targetId: role.id });
  await sendServerLog(
    role.client,
    guildConfig,
    buildRoleDeleteLog({
      role: { id: role.id, name: role.name },
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: role.guild.id,
      eventType: "role_delete",
      actorId: mod?.id,
      summary: `Role deleted: ${role.name}`,
      payload: { roleId: role.id, name: role.name },
    },
  );
}

export async function handleRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
  const changes: string[] = [];
  if (oldRole.name !== newRole.name) changes.push(`Name: ${oldRole.name} -> ${newRole.name}`);
  if (oldRole.color !== newRole.color) changes.push(`Color: #${oldRole.color.toString(16)} -> #${newRole.color.toString(16)}`);
  if (oldRole.hoist !== newRole.hoist) changes.push(`Hoist: ${oldRole.hoist} -> ${newRole.hoist}`);
  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(`Mentionable: ${oldRole.mentionable} -> ${newRole.mentionable}`);
  }
  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push("Permissions changed");
  if (!changes.length) return;

  const guildConfig = await configManager.getEffectiveConfig(newRole.guild.id);
  const mod = await findAuditExecutor(newRole.guild, AuditLogEvent.RoleUpdate, { targetId: newRole.id });
  await sendServerLog(
    newRole.client,
    guildConfig,
    buildRoleUpdateLog({
      role: { id: newRole.id, name: newRole.name },
      changes,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: newRole.guild.id,
      eventType: "role_update",
      actorId: mod?.id,
      summary: `Role updated: ${newRole.name}`,
      payload: { changes },
    },
  );
}

export async function handleGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
  const changes: string[] = [];
  if (oldGuild.name !== newGuild.name) changes.push(`Name: ${oldGuild.name} -> ${newGuild.name}`);
  if (oldGuild.icon !== newGuild.icon) changes.push("Icon changed");
  if (oldGuild.description !== newGuild.description) changes.push("Description changed");
  if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
    changes.push(`Verification: ${oldGuild.verificationLevel} -> ${newGuild.verificationLevel}`);
  }
  if (oldGuild.premiumTier !== newGuild.premiumTier) {
    changes.push(`Boost tier: ${oldGuild.premiumTier} -> ${newGuild.premiumTier}`);
  }
  if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) changes.push("Vanity URL changed");
  if (!changes.length) return;

  const guildConfig = await configManager.getEffectiveConfig(newGuild.id);
  const mod = await findAuditExecutor(newGuild, AuditLogEvent.GuildUpdate, {});
  await sendServerLog(
    newGuild.client,
    guildConfig,
    buildGuildUpdateLog({
      changes,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: newGuild.id,
      eventType: "guild_update",
      actorId: mod?.id,
      summary: "Server settings updated",
      payload: { changes },
    },
  );
}

export async function handleEmojiCreate(emoji: GuildEmoji): Promise<void> {
  if (!emoji.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(emoji.guild.id);
  const mod = await findAuditExecutor(emoji.guild, AuditLogEvent.EmojiCreate, { targetId: emoji.id });
  await sendServerLog(
    emoji.client,
    guildConfig,
    buildEmojiLog({
      action: "create",
      name: emoji.name ?? emoji.id,
      id: emoji.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: emoji.guild.id,
      eventType: "emoji_create",
      actorId: mod?.id,
      summary: `Emoji created: ${emoji.name}`,
      payload: { emojiId: emoji.id, name: emoji.name },
    },
  );
}

export async function handleEmojiDelete(emoji: GuildEmoji): Promise<void> {
  if (!emoji.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(emoji.guild.id);
  const mod = await findAuditExecutor(emoji.guild, AuditLogEvent.EmojiDelete, { targetId: emoji.id });
  await sendServerLog(
    emoji.client,
    guildConfig,
    buildEmojiLog({
      action: "delete",
      name: emoji.name ?? emoji.id,
      id: emoji.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: emoji.guild.id,
      eventType: "emoji_delete",
      actorId: mod?.id,
      summary: `Emoji deleted: ${emoji.name}`,
    },
  );
}

export async function handleEmojiUpdate(oldEmoji: GuildEmoji, newEmoji: GuildEmoji): Promise<void> {
  if (!newEmoji.guild || oldEmoji.name === newEmoji.name) return;
  const guildConfig = await configManager.getEffectiveConfig(newEmoji.guild.id);
  const mod = await findAuditExecutor(newEmoji.guild, AuditLogEvent.EmojiUpdate, {
    targetId: newEmoji.id,
  });
  await sendServerLog(
    newEmoji.client,
    guildConfig,
    buildEmojiLog({
      action: "update",
      name: `${oldEmoji.name} -> ${newEmoji.name}`,
      id: newEmoji.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: newEmoji.guild.id,
      eventType: "emoji_update",
      actorId: mod?.id,
      summary: `Emoji renamed: ${oldEmoji.name} -> ${newEmoji.name}`,
    },
  );
}

export async function handleStickerCreate(sticker: Sticker): Promise<void> {
  const guild = sticker.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.StickerCreate, { targetId: sticker.id });
  await sendServerLog(
    sticker.client,
    guildConfig,
    buildStickerLog({
      action: "create",
      name: sticker.name,
      id: sticker.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "sticker_create",
      actorId: mod?.id,
      summary: `Sticker created: ${sticker.name}`,
    },
  );
}

export async function handleStickerDelete(sticker: Sticker): Promise<void> {
  const guild = sticker.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.StickerDelete, { targetId: sticker.id });
  await sendServerLog(
    sticker.client,
    guildConfig,
    buildStickerLog({
      action: "delete",
      name: sticker.name,
      id: sticker.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "sticker_delete",
      actorId: mod?.id,
      summary: `Sticker deleted: ${sticker.name}`,
    },
  );
}

export async function handleStickerUpdate(oldSticker: Sticker, newSticker: Sticker): Promise<void> {
  const guild = newSticker.guild;
  if (!guild || oldSticker.name === newSticker.name) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.StickerUpdate, { targetId: newSticker.id });
  await sendServerLog(
    newSticker.client,
    guildConfig,
    buildStickerLog({
      action: "update",
      name: `${oldSticker.name} -> ${newSticker.name}`,
      id: newSticker.id,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "sticker_update",
      actorId: mod?.id,
      summary: `Sticker updated: ${newSticker.name}`,
    },
  );
}

export async function handleInviteCreate(invite: Invite): Promise<void> {
  const guild = invite.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await sendServerLog(
    invite.client,
    guildConfig,
    buildInviteCreateLog({
      code: invite.code,
      channel: invite.channel
        ? channelRef(invite.channel.id, "name" in invite.channel ? invite.channel.name : null)
        : null,
      inviter: invite.inviter
        ? userRef(invite.inviter.id, invite.inviter.username, invite.inviter.displayAvatarURL({ size: 128 }))
        : null,
      maxUses: invite.maxUses,
      maxAge: invite.maxAge,
    }),
    {
      guildId: guild.id,
      eventType: "invite_create",
      actorId: invite.inviter?.id,
      channelId: invite.channelId,
      summary: `Invite created: ${invite.code}`,
      payload: { code: invite.code, maxUses: invite.maxUses, maxAge: invite.maxAge },
    },
  );
}

export async function handleInviteDelete(invite: Invite): Promise<void> {
  const guild = invite.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild as Guild, AuditLogEvent.InviteDelete, {});
  await sendServerLog(
    invite.client,
    guildConfig,
    buildInviteDeleteLog({
      code: invite.code,
      channel: invite.channel
        ? channelRef(invite.channel.id, "name" in invite.channel ? invite.channel.name : null)
        : null,
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "invite_delete",
      actorId: mod?.id,
      channelId: invite.channelId,
      summary: `Invite deleted: ${invite.code}`,
      payload: { code: invite.code },
    },
  );
}

export async function handleWebhooksUpdate(channel: { id: string; name?: string | null; guild: Guild | null }): Promise<void> {
  const guild = channel.guild;
  if (!guild) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const mod = await findAuditExecutor(guild, AuditLogEvent.WebhookCreate, {
    targetId: channel.id,
    maxAgeMs: 20_000,
  });
  await sendServerLog(
    guild.client,
    guildConfig,
    buildWebhookUpdateLog({
      channel: channelRef(channel.id, channel.name),
      mod: mod ? { id: mod.id, name: mod.name ?? undefined } : null,
    }),
    {
      guildId: guild.id,
      eventType: "webhook_update",
      actorId: mod?.id,
      channelId: channel.id,
      summary: `Webhooks updated in #${channel.name ?? channel.id}`,
    },
  );
}
