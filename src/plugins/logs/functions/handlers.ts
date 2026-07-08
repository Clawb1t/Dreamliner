import type {
  AnyThreadChannel,
  GuildMember,
  Message,
  PartialMessage,
  VoiceState,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import {
  buildMemberJoinLog,
  buildMemberLeaveLog,
  buildMessageDeleteLog,
  buildMessageEditLog,
  buildMessagePinLog,
  buildNicknameChangeLog,
  buildRoleChangeLog,
  buildThreadArchiveLog,
  buildThreadCreateLog,
  buildVoiceJoinLog,
  buildVoiceLeaveLog,
  buildVoiceMoveLog,
} from "../../../core/logging/format.js";
import { deleteLogMessage, getLogMessage, upsertLogMessage } from "../../../core/logging/messageStore.js";
import { getServerLogChannelId } from "../../../core/logging/channels.js";
import { sendServerLog } from "../../../core/logging/send.js";
import { isForcedVoiceAction } from "../../../core/logging/voice.js";

function channelRef(channelId: string, name?: string | null) {
  return { id: channelId, name: name ?? undefined };
}

function userRef(userId: string, name?: string | null, avatarUrl?: string | null) {
  return { id: userId, name: name ?? undefined, avatarUrl: avatarUrl ?? undefined };
}

function hasServerLogging(guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>): boolean {
  return Boolean(getServerLogChannelId(guildConfig));
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (!message.guild || message.author?.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!hasServerLogging(guildConfig)) return;
  await upsertLogMessage(message);
}

export async function handleMemberJoin(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  await sendServerLog(
    member.client,
    guildConfig,
    buildMemberJoinLog(userRef(member.id, member.user.username, member.displayAvatarURL({ size: 128 }))),
  );
}

export async function handleMemberLeave(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  await sendServerLog(
    member.client,
    guildConfig,
    buildMemberLeaveLog(userRef(member.id, member.user.username, member.displayAvatarURL({ size: 128 }))),
  );
}

export async function handleMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
  if (!newMember.guild || newMember.user.bot) return;
  const guildConfig = await configManager.getEffectiveConfig(newMember.guild.id);

  const oldNick = oldMember.nickname ?? oldMember.user.username;
  const newNick = newMember.nickname ?? newMember.user.username;
  if (oldNick !== newNick) {
    await sendServerLog(
      newMember.client,
      guildConfig,
      buildNicknameChangeLog({
        user: userRef(newMember.id, newMember.user.username, newMember.displayAvatarURL({ size: 128 })),
        oldNick,
        newNick,
      }),
    );
  }

  const added = newMember.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id) && role.id !== newMember.guild.id);
  const removed = oldMember.roles.cache.filter((role) => !newMember.roles.cache.has(role.id) && role.id !== newMember.guild.id);
  if (added.size || removed.size) {
    await sendServerLog(
      newMember.client,
      guildConfig,
      buildRoleChangeLog({
        user: userRef(newMember.id, newMember.user.username, newMember.displayAvatarURL({ size: 128 })),
        added: [...added.values()].map((role) => ({ id: role.id, name: role.name })),
        removed: [...removed.values()].map((role) => ({ id: role.id, name: role.name })),
      }),
    );
  }
}

export async function handleMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
  if (!newMessage.guild || newMessage.author?.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(newMessage.guild.id);
  if (!hasServerLogging(guildConfig)) return;

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

  if (pinChanged && newMessage.author) {
    const channelName =
      newMessage.channel.isTextBased() && "name" in newMessage.channel
        ? newMessage.channel.name
        : storedBefore?.channelName;

    await sendServerLog(
      newMessage.client,
      guildConfig,
      buildMessagePinLog({
        user: userRef(newMessage.author.id, newMessage.author.username, newMessage.author.displayAvatarURL({ size: 128 })),
        channel: channelRef(newMessage.channelId, channelName),
        pinned: Boolean(newMessage.pinned),
      }),
    );
  }

  if (beforeContent === afterContent) {
    await upsertLogMessage(newMessage);
    return;
  }

  const channelName =
    newMessage.channel.isTextBased() && "name" in newMessage.channel
      ? newMessage.channel.name
      : storedBefore?.channelName;

  await sendServerLog(
    newMessage.client,
    guildConfig,
    buildMessageEditLog({
      user: userRef(newMessage.author.id, newMessage.author.username, newMessage.author.displayAvatarURL({ size: 128 })),
      channel: channelRef(newMessage.channelId, channelName),
      before: beforeContent,
      after: afterContent,
    }),
  );

  await upsertLogMessage(newMessage);
}

export async function handleMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!hasServerLogging(guildConfig)) return;

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
    (await resolved.client.users.fetch(authorId).then((u) => u.displayAvatarURL({ size: 128 })).catch(() => null));

  await sendServerLog(
    resolved.client,
    guildConfig,
    buildMessageDeleteLog({
      user: userRef(authorId, resolved.author?.username ?? stored?.authorName, authorAvatar),
      channel: channelRef(resolved.channelId, channelName),
      content: resolved.content ?? stored?.content ?? "",
    }),
  );

  await deleteLogMessage(message.guild.id, message.channelId, message.id);
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

  if (!oldChannelId && newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceJoinLog(user, channelRef(newChannelId, newState.channel?.name)),
    );
    return;
  }

  if (oldChannelId && !newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceLeaveLog(user, channelRef(oldChannelId, oldState.channel?.name)),
    );
    return;
  }

  if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    await sendServerLog(
      guild.client,
      guildConfig,
      buildVoiceMoveLog({
        user,
        fromChannel: channelRef(oldChannelId, oldState.channel?.name),
        toChannel: channelRef(newChannelId, newState.channel?.name),
      }),
    );
  }
}

export async function handleThreadCreate(thread: AnyThreadChannel): Promise<void> {
  if (!thread.guild) return;
  const guildConfig = await configManager.getEffectiveConfig(thread.guild.id);
  if (!hasServerLogging(guildConfig)) return;

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
  );
}

export async function handleThreadUpdate(oldThread: AnyThreadChannel, newThread: AnyThreadChannel): Promise<void> {
  if (!newThread.guild) return;
  if (oldThread.archived === newThread.archived) return;

  const guildConfig = await configManager.getEffectiveConfig(newThread.guild.id);
  if (!hasServerLogging(guildConfig)) return;

  const parent = newThread.parent;
  await sendServerLog(
    newThread.client,
    guildConfig,
    buildThreadArchiveLog({
      thread: { id: newThread.id, name: newThread.name },
      parentChannel: channelRef(parent?.id ?? newThread.parentId ?? newThread.id, parent?.name),
      archived: newThread.archived ?? false,
    }),
  );
}
