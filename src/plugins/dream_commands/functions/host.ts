import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type TextChannel,
  type User,
  type VoiceChannel,
} from "discord.js";
import type { DreamTrigger } from "./trigger.js";
import type { ActionHost, BoundActionArgs, DreamValue, SourcePos } from "../../../dreamcode/index.js";
import { DreamcodeError, parseDurationValue } from "../../../dreamcode/index.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { getMemberLevel } from "../../../core/permissions.js";
import { safeAddRole, safeRemoveRole, safeToggleRole } from "../../../core/roles.js";
import { renderTemplate } from "../../../core/templates.js";
import { discordTimestamp, snowflakeToTimestamp } from "../../../core/datetime.js";
import { markForcedVoiceAction } from "../../../core/logging/voice.js";
import {
  buildCleanLog,
  buildVoiceForceDisconnectLog,
  buildVoiceForceMoveAllLog,
  buildVoiceForceMoveLog,
} from "../../../core/logging/format.js";
import { sendModerationLog, sendServerLog } from "../../../core/logging/send.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import type { AdminConfig } from "../../../config/schemas/plugins.js";
import { canModerateTarget, formatReason } from "../../infraction/functions/moderation.js";
import { parseDuration, formatDurationShort } from "../../infraction/functions/duration.js";
import {
  applyTimeout,
  clearTimeout,
  clampTimeoutMs,
  countUserInfractions,
  createInfraction,
  deactivateInfractions,
  deleteInfraction,
  DISCORD_TIMEOUT_MAX_MS,
  getInfraction,
  postCaseLog,
  searchInfractions,
  updateInfractionReason,
} from "../../infraction/functions/infractions.js";
import { applyLockdown, applyUnlock } from "../../admin/functions/lockdown.js";
import { archiveMessages, collectMessagesForClean, serializeMessages } from "../../utility/functions/clean.js";
import { getGuildMessageCount } from "../../utility/functions/messageCounts.js";
import { createTag, deleteTag, getTag, updateTag } from "../../tags/functions/store.js";
import { getCounter, updateCounterValue } from "../../counters/functions/store.js";
import { refreshCounterDisplay } from "../../counters/functions/handlers.js";
import { cancelReminder, createReminder } from "../../reminders/functions/store.js";
import { createScheduledPost, deleteScheduledPost } from "../../post/functions/store.js";
import { getUserNameHistory } from "../../name_history/functions/store.js";
import { zAdminConfig } from "../../../config/schemas/plugins.js";
import { valueToId, valueToInt, valueToString } from "./ids.js";
import {
  caseObject,
  channelObject,
  guildObject,
  memberObject,
  messageObject,
  roleObject,
  userObject,
} from "./objects.js";

export type HostContext = {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  actor: GuildMember;
  trigger: DreamTrigger;
};

export function createDiscordActionHost(ctx: HostContext): ActionHost {
  return {
    async run(action, args, pos) {
      switch (action) {
        case "reply":
          return actReply(ctx, args, pos);
        case "send":
          return actSend(ctx, args, pos);
        case "dm":
          return actDm(ctx, args, pos);
        case "react":
          return actReact(ctx, args, pos);
        case "react_message":
          return actReactMessage(ctx, args, pos);
        case "delete_trigger":
          await ctx.trigger.delete().catch(() => null);
          return null;
        case "edit_trigger":
          return actEditTrigger(ctx, args, pos);
        case "delete_message":
          return actDeleteMessage(ctx, args, pos);
        case "pin":
          return actPin(ctx, args, pos, true);
        case "unpin":
          return actPin(ctx, args, pos, false);
        case "send_tag":
          return actSendTag(ctx, args, pos);
        case "warn":
          return actWarnNote(ctx, args, pos, "warn");
        case "note":
          return actWarnNote(ctx, args, pos, "note");
        case "kick":
          return actKick(ctx, args, pos);
        case "ban":
          return actBan(ctx, args, pos, false);
        case "tempban":
          return actBan(ctx, args, pos, true);
        case "unban":
          return actUnban(ctx, args, pos);
        case "softban":
          return actSoftban(ctx, args, pos);
        case "mute":
          return actMute(ctx, args, pos);
        case "unmute":
          return actUnmute(ctx, args, pos);
        case "clean":
          return actClean(ctx, args, pos);
        case "case_get":
          return actCaseGet(ctx, args, pos);
        case "case_search":
          return actCaseSearch(ctx, args, pos);
        case "case_count":
          return actCaseCount(ctx, args, pos);
        case "case_reason":
          return actCaseReason(ctx, args, pos);
        case "case_delete":
          return actCaseDelete(ctx, args, pos);
        case "add_role":
          return actRole(ctx, args, pos, "add");
        case "remove_role":
          return actRole(ctx, args, pos, "remove");
        case "toggle_role":
          return actRole(ctx, args, pos, "toggle");
        case "has_role":
          return actHasRole(ctx, args, pos);
        case "nickname":
          return actNickname(ctx, args, pos);
        case "set_mentionable":
          return actSetMentionable(ctx, args, pos);
        case "voice_move":
          return actVoiceMove(ctx, args, pos);
        case "voice_disconnect":
          return actVoiceDisconnect(ctx, args, pos);
        case "voice_move_all":
          return actVoiceMoveAll(ctx, args, pos);
        case "slowmode":
          return actSlowmode(ctx, args, pos);
        case "lock_channel":
          return actLockChannel(ctx, args, pos, true);
        case "unlock_channel":
          return actLockChannel(ctx, args, pos, false);
        case "lockdown":
          return actLockdown(ctx, true);
        case "unlock":
          return actLockdown(ctx, false);
        case "create_invite":
          return actCreateInvite(ctx, args, pos);
        case "tag_get":
          return actTagGet(ctx, args, pos);
        case "tag_create":
          return actTagCreate(ctx, args, pos);
        case "tag_edit":
          return actTagEdit(ctx, args, pos);
        case "tag_delete":
          return actTagDelete(ctx, args, pos);
        case "counter_get":
          return actCounterGet(ctx, args, pos);
        case "counter_set":
          return actCounterSet(ctx, args, pos, false);
        case "counter_add":
          return actCounterSet(ctx, args, pos, true);
        case "economy_balance":
          return actEconomyBalance(ctx, args, pos);
        case "economy_add":
          return actEconomyMutate(ctx, args, pos, "add");
        case "economy_take":
          return actEconomyMutate(ctx, args, pos, "take");
        case "economy_has_item":
          return actEconomyHasItem(ctx, args, pos);
        case "remind":
          return actRemind(ctx, args, pos);
        case "remind_cancel":
          return actRemindCancel(ctx, args, pos);
        case "schedule_post":
          return actSchedulePost(ctx, args, pos);
        case "schedule_post_cancel":
          return actSchedulePostCancel(ctx, args, pos);
        case "log_mod":
          return actLog(ctx, args, pos, "mod");
        case "log_server":
          return actLog(ctx, args, pos, "server");
        case "get_member":
          return actGetMember(ctx, args, pos);
        case "get_user":
          return actGetUser(ctx, args, pos);
        case "get_role":
          return actGetRole(ctx, args, pos);
        case "get_channel":
          return actGetChannel(ctx, args, pos);
        case "get_message":
          return actGetMessage(ctx, args, pos);
        case "member_level":
          return actMemberLevel(ctx, args, pos);
        case "is_timed_out":
          return actIsTimedOut(ctx, args, pos);
        case "is_banned":
          return actIsBanned(ctx, args, pos);
        case "locate":
          return actLocate(ctx, args, pos);
        case "name_history":
          return actNameHistory(ctx, args, pos);
        case "snowflake_info":
          return actSnowflakeInfo(args, pos);
        case "message_count":
          return actMessageCount(ctx, args, pos);
        case "random":
          return actRandom(args, pos);
        case "choose":
          return actChoose(args, pos);
        case "length":
          return actLength(args, pos);
        case "contains":
          return actContains(args);
        case "replace":
          return actReplace(args, pos);
        case "upper":
          return valueToString(args.value).toUpperCase();
        case "lower":
          return valueToString(args.value).toLowerCase();
        case "trim":
          return valueToString(args.value).trim();
        case "now":
          return Date.now();
        case "format_time":
          return actFormatTime(args, pos);
        case "wait":
          return null;
        default:
          throw new DreamcodeError("runtime", `Unsupported action '${action}'`, pos);
      }
    },
  };
}

function pluginConfig(ctx: HostContext): InfractionConfig {
  return getInfractionPluginConfig(ctx.guildConfig) as InfractionConfig;
}

function adminConfig(ctx: HostContext): AdminConfig {
  const section = ctx.guildConfig.plugins.admin?.config ?? {};
  return zAdminConfig.parse(section);
}

async function resolveUser(ctx: HostContext, value: DreamValue | undefined, pos: SourcePos): Promise<User> {
  const id = valueToId(value);
  if (!id) throw new DreamcodeError("runtime", "Expected a user", pos);
  const user = await ctx.client.users.fetch(id).catch(() => null);
  if (!user) throw new DreamcodeError("runtime", "User not found", pos);
  return user;
}

async function resolveMember(ctx: HostContext, value: DreamValue | undefined, pos: SourcePos): Promise<GuildMember> {
  const user = await resolveUser(ctx, value, pos);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  if (!member) throw new DreamcodeError("runtime", "Member not found in this server", pos);
  return member;
}

async function resolveTextChannel(
  ctx: HostContext,
  value: DreamValue | undefined,
  pos: SourcePos,
  fallbackTrigger = false,
): Promise<TextChannel> {
  const id = valueToId(value) ?? (fallbackTrigger ? ctx.trigger.channel.id : null);
  if (!id) throw new DreamcodeError("runtime", "Expected a channel", pos);
  const channel = await ctx.guild.channels.fetch(id).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new DreamcodeError("runtime", "Channel is not a text channel in this server", pos);
  }
  return channel as TextChannel;
}

function requireMod(ctx: HostContext, member: GuildMember | null, user: User, pos: SourcePos) {
  const err = canModerateTarget(ctx.actor, member, user, ctx.guild);
  if (err) throw new DreamcodeError("runtime", err, pos);
}

function asBool(value: DreamValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

async function actReply(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const content = valueToString(args.content);
  if (!content) throw new DreamcodeError("runtime", "reply requires content", pos);
  const msg = await ctx.trigger
    .reply({ content, allowedMentions: { parse: ["users", "roles"] } })
    .catch(async () => {
      if (ctx.trigger.channel.isTextBased()) {
        return (ctx.trigger.channel as TextChannel).send({
          content,
          allowedMentions: { parse: ["users", "roles"] },
        });
      }
      return null;
    });
  return msg ? messageObject(msg) : null;
}

async function actSend(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const content = valueToString(args.content);
  if (!content) throw new DreamcodeError("runtime", "send requires content", pos);
  const msg = await channel.send({ content, allowedMentions: { parse: ["users", "roles"] } });
  return messageObject(msg);
}

async function actDm(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  const content = valueToString(args.content);
  if (!content) throw new DreamcodeError("runtime", "dm requires content", pos);
  const ok = await member
    .send(content)
    .then(() => true)
    .catch(() => false);
  return ok;
}

async function actReact(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const emoji = valueToString(args.emoji);
  if (!emoji) throw new DreamcodeError("runtime", "react requires an emoji", pos);
  await ctx.trigger.react(emoji).catch(() => {
    throw new DreamcodeError("runtime", `Could not react with '${emoji}'`, pos);
  });
  return true;
}

async function actReactMessage(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const messageId = valueToId(args.message_id) ?? valueToString(args.message_id);
  const emoji = valueToString(args.emoji);
  if (!messageId || !emoji) throw new DreamcodeError("runtime", "react_message requires message_id and emoji", pos);
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) throw new DreamcodeError("runtime", "Message not found", pos);
  await msg.react(emoji);
  return true;
}

async function actEditTrigger(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const content = valueToString(args.content);
  if (!ctx.trigger.editable) throw new DreamcodeError("runtime", "Trigger message is not editable by the bot", pos);
  const msg = await ctx.trigger.edit(content);
  return messageObject(msg);
}

async function actDeleteMessage(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const messageId = valueToId(args.message_id) ?? valueToString(args.message_id);
  if (!messageId) throw new DreamcodeError("runtime", "delete_message requires message_id", pos);
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) throw new DreamcodeError("runtime", "Message not found", pos);
  await msg.delete();
  return true;
}

async function actPin(ctx: HostContext, args: BoundActionArgs, pos: SourcePos, pin: boolean): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const messageId = valueToId(args.message_id) ?? valueToString(args.message_id);
  if (!messageId) throw new DreamcodeError("runtime", "message_id required", pos);
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) throw new DreamcodeError("runtime", "Message not found", pos);
  if (pin) await msg.pin();
  else await msg.unpin();
  return true;
}

async function actSendTag(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  const tag = await getTag(ctx.guild.id, name);
  if (!tag) throw new DreamcodeError("runtime", `Tag '${name}' not found`, pos);
  const channel = args.channel
    ? await resolveTextChannel(ctx, args.channel, pos)
    : await resolveTextChannel(ctx, null, pos, true);
  const rendered = renderTemplate(tag.content, {
    member: ctx.actor,
    guild: ctx.guild,
    channel,
  });
  const msg = await channel.send({ content: rendered, allowedMentions: { parse: ["users", "roles"] } });
  return messageObject(msg);
}

async function actWarnNote(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  type: "warn" | "note",
): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  if (type === "warn") requireMod(ctx, member, user, pos);
  const reason = formatReason(valueToString(args.reason) || null);
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: user.id,
    modId: ctx.actor.id,
    type,
    reason,
    active: type === "warn",
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, user, ctx.actor.user);
  return caseObject(record);
}

async function actKick(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Kick Members permission", pos);
  }
  const member = await resolveMember(ctx, args.user, pos);
  requireMod(ctx, member, member.user, pos);
  const reason = formatReason(valueToString(args.reason) || null);
  await member.kick(reason);
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: member.id,
    modId: ctx.actor.id,
    type: "kick",
    reason,
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, member.user, ctx.actor.user);
  return caseObject(record);
}

async function actBan(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  temporary: boolean,
): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Ban Members permission", pos);
  }
  const user = await resolveUser(ctx, args.user, pos);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  requireMod(ctx, member, user, pos);

  let expiresAt: Date | null = null;
  let durationLabel: string | null = null;
  if (temporary) {
    const ms = parseDuration(valueToString(args.duration)) ?? parseDurationValue(args.duration, pos);
    expiresAt = new Date(Date.now() + ms);
    durationLabel = formatDurationShort(ms);
  }

  const reason = formatReason(valueToString(args.reason) || null);
  const deleteDays = Math.min(7, Math.max(0, valueToInt(args.delete_days, 0)));
  await ctx.guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 });

  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: user.id,
    modId: ctx.actor.id,
    type: temporary ? "tempban" : "ban",
    reason,
    expiresAt,
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, user, ctx.actor.user, { durationLabel });
  return caseObject(record);
}

async function actUnban(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Ban Members permission", pos);
  }
  const user = await resolveUser(ctx, args.user, pos);
  const reason = formatReason(valueToString(args.reason) || null);
  await ctx.guild.members.unban(user.id, reason).catch(() => {
    throw new DreamcodeError("runtime", "Failed to unban (user may not be banned)", pos);
  });
  await deactivateInfractions(ctx.guild.id, user.id, ["ban", "tempban"]);
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: user.id,
    modId: ctx.actor.id,
    type: "unban",
    reason,
    active: false,
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, user, ctx.actor.user);
  return caseObject(record);
}

async function actSoftban(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Ban Members permission", pos);
  }
  const user = await resolveUser(ctx, args.user, pos);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  requireMod(ctx, member, user, pos);
  const cfg = pluginConfig(ctx);
  const deleteDays = Math.min(
    7,
    Math.max(0, args.delete_days !== undefined ? valueToInt(args.delete_days, 1) : cfg.softban_delete_message_days),
  );
  const reason = formatReason(valueToString(args.reason) || null);
  await ctx.guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
  await ctx.guild.members.unban(user.id, "Softban");
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: user.id,
    modId: ctx.actor.id,
    type: "softban",
    reason,
    active: false,
  });
  await postCaseLog(ctx.client, ctx.guildConfig, cfg, record, user, ctx.actor.user);
  return caseObject(record);
}

async function actMute(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Moderate Members permission", pos);
  }
  const member = await resolveMember(ctx, args.user, pos);
  requireMod(ctx, member, member.user, pos);
  const parsedMs = parseDuration(valueToString(args.duration)) ?? parseDurationValue(args.duration, pos);
  if (parsedMs > DISCORD_TIMEOUT_MAX_MS) throw new DreamcodeError("runtime", "Mute duration cannot exceed 28 days", pos);
  const durationMs = clampTimeoutMs(parsedMs);
  const reason = formatReason(valueToString(args.reason) || null);
  await applyTimeout(member, durationMs, reason);
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: member.id,
    modId: ctx.actor.id,
    type: "tempmute",
    reason,
    expiresAt: new Date(Date.now() + durationMs),
    metadata: { method: "timeout" },
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, member.user, ctx.actor.user, {
    durationLabel: formatDurationShort(durationMs),
  });
  return caseObject(record);
}

async function actUnmute(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  if (!ctx.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new DreamcodeError("runtime", "Bot lacks Moderate Members permission", pos);
  }
  const member = await resolveMember(ctx, args.user, pos);
  requireMod(ctx, member, member.user, pos);
  const reason = formatReason(valueToString(args.reason) || null);
  await clearTimeout(member, reason);
  await deactivateInfractions(ctx.guild.id, member.id, ["mute", "tempmute"]);
  const record = await createInfraction({
    guildId: ctx.guild.id,
    userId: member.id,
    modId: ctx.actor.id,
    type: "unmute",
    reason,
    active: false,
  });
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig(ctx), record, member.user, ctx.actor.user);
  return caseObject(record);
}

async function actClean(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const amount = Math.min(100, Math.max(1, valueToInt(args.amount, 0)));
  if (!amount) throw new DreamcodeError("runtime", "clean requires amount 1–100", pos);
  const channel = await resolveTextChannel(ctx, args.channel, pos, true);
  const userId = args.user ? valueToId(args.user) ?? undefined : undefined;
  const contains = valueToString(args.contains) || undefined;
  let messages = await collectMessagesForClean(channel, {
    limit: amount,
    userId,
    botsOnly: asBool(args.bots_only),
    regex: valueToString(args.regex) || undefined,
  });
  if (contains) {
    const lower = contains.toLowerCase();
    messages = messages.filter((m) => m.content.toLowerCase().includes(lower));
  }
  const list = [...messages.values()].filter((m) => m.bulkDeletable);
  if (!list.length) return { deleted: 0, archiveId: null };
  const archiveId = await archiveMessages(ctx.guild.id, serializeMessages(list));
  await channel.bulkDelete(list, true);
  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildCleanLog({
      mod: { id: ctx.actor.id, name: ctx.actor.user.username, avatarUrl: ctx.actor.displayAvatarURL({ size: 128 }) },
      channel: { id: channel.id, name: channel.name },
      count: list.length,
      archiveId,
    }),
    {
      guildId: ctx.guild.id,
      eventType: "clean",
      actorId: ctx.actor.id,
      targetId: userId ?? null,
      channelId: channel.id,
    },
  );
  return { deleted: list.length, archiveId };
}

async function actCaseGet(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToInt(args.id, 0);
  if (!id) throw new DreamcodeError("runtime", "case_get requires id", pos);
  const record = await getInfraction(ctx.guild.id, id);
  return record ? caseObject(record) : null;
}

async function actCaseSearch(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const query = valueToString(args.query);
  if (!query) throw new DreamcodeError("runtime", "case_search requires query", pos);
  const type = valueToString(args.type) || undefined;
  const rows = await searchInfractions(ctx.guild.id, query, 15, type);
  return rows.map(caseObject);
}

async function actCaseCount(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  return countUserInfractions(ctx.guild.id, user.id);
}

async function actCaseReason(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToInt(args.id, 0);
  const reason = valueToString(args.reason);
  if (!id || !reason) throw new DreamcodeError("runtime", "case_reason requires id and reason", pos);
  const existing = await getInfraction(ctx.guild.id, id);
  if (!existing) return null;
  await updateInfractionReason(ctx.guild.id, id, reason);
  const updated = await getInfraction(ctx.guild.id, id);
  return updated ? caseObject(updated) : null;
}

async function actCaseDelete(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToInt(args.id, 0);
  if (!id) throw new DreamcodeError("runtime", "case_delete requires id", pos);
  await deleteInfraction(ctx.guild.id, id);
  return true;
}

async function actRole(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  mode: "add" | "remove" | "toggle",
): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  const roleId = valueToId(args.role);
  if (!roleId) throw new DreamcodeError("runtime", "role required", pos);
  const reason = valueToString(args.reason, "Dreamcode");
  if (mode === "add") {
    const result = await safeAddRole(member, roleId, reason);
    if (!result.ok) throw new DreamcodeError("runtime", result.reason, pos);
    return true;
  }
  if (mode === "remove") {
    const result = await safeRemoveRole(member, roleId, reason);
    if (!result.ok) throw new DreamcodeError("runtime", result.reason, pos);
    return true;
  }
  const result = await safeToggleRole(member, roleId, reason);
  if (!result.ok) throw new DreamcodeError("runtime", result.reason, pos);
  return Boolean(result.added);
}

async function actHasRole(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  const roleId = valueToId(args.role);
  if (!roleId) throw new DreamcodeError("runtime", "role required", pos);
  return member.roles.cache.has(roleId);
}

async function actNickname(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  if (!member.manageable && member.id !== ctx.guild.members.me?.id) {
    throw new DreamcodeError("runtime", "Cannot change that member's nickname", pos);
  }
  const nick = valueToString(args.nick);
  await member.setNickname(nick || null, valueToString(args.reason, "Dreamcode nickname"));
  return true;
}

async function actSetMentionable(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const roleId = valueToId(args.role);
  if (!roleId) throw new DreamcodeError("runtime", "role required", pos);
  const role = ctx.guild.roles.cache.get(roleId);
  if (!role) throw new DreamcodeError("runtime", "Role not found", pos);
  await role.setMentionable(asBool(args.enabled), "Dreamcode set_mentionable");
  return true;
}

async function actVoiceMove(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  if (!member.voice.channelId) throw new DreamcodeError("runtime", "Member is not in a voice channel", pos);
  const channelId = valueToId(args.channel);
  if (!channelId) throw new DreamcodeError("runtime", "voice channel required", pos);
  const dest = await ctx.guild.channels.fetch(channelId).catch(() => null);
  if (!dest?.isVoiceBased()) {
    throw new DreamcodeError("runtime", "Destination must be a voice channel", pos);
  }
  const fromChannelId = member.voice.channelId;
  const fromChannelName = member.voice.channel?.name;
  markForcedVoiceAction(ctx.guild.id, member.id);
  await member.voice.setChannel(dest.id, valueToString(args.reason, "Dreamcode voice_move"));
  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildVoiceForceMoveLog({
      target: { id: member.id, name: member.user.username, avatarUrl: member.displayAvatarURL({ size: 128 }) },
      mod: { id: ctx.actor.id, name: ctx.actor.user.username, avatarUrl: ctx.actor.displayAvatarURL({ size: 128 }) },
      fromChannel: fromChannelId ? { id: fromChannelId, name: fromChannelName } : null,
      toChannel: { id: dest.id, name: dest.name },
    }),
    {
      guildId: ctx.guild.id,
      eventType: "voice_mod",
      actorId: ctx.actor.id,
      targetId: member.id,
      channelId: dest.id,
    },
  );
  return true;
}

async function actVoiceDisconnect(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  if (!member.voice.channelId) throw new DreamcodeError("runtime", "Member is not in a voice channel", pos);
  const from = { id: member.voice.channelId, name: member.voice.channel?.name };
  markForcedVoiceAction(ctx.guild.id, member.id);
  await member.voice.disconnect(valueToString(args.reason, "Dreamcode voice_disconnect"));
  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildVoiceForceDisconnectLog({
      target: { id: member.id, name: member.user.username, avatarUrl: member.displayAvatarURL({ size: 128 }) },
      mod: { id: ctx.actor.id, name: ctx.actor.user.username, avatarUrl: ctx.actor.displayAvatarURL({ size: 128 }) },
      channel: from,
    }),
    {
      guildId: ctx.guild.id,
      eventType: "voice_mod",
      actorId: ctx.actor.id,
      targetId: member.id,
      channelId: from.id,
    },
  );
  return true;
}

async function actVoiceMoveAll(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const fromId = valueToId(args.from);
  const toId = valueToId(args.to);
  if (!fromId || !toId) throw new DreamcodeError("runtime", "voice_move_all requires from and to", pos);
  const from = await ctx.guild.channels.fetch(fromId).catch(() => null);
  const to = await ctx.guild.channels.fetch(toId).catch(() => null);
  if (!from?.isVoiceBased() || !to?.isVoiceBased()) {
    throw new DreamcodeError("runtime", "from/to must be voice channels", pos);
  }
  let moved = 0;
  for (const member of (from as VoiceChannel).members.values()) {
    markForcedVoiceAction(ctx.guild.id, member.id);
    await member.voice.setChannel(to.id).catch(() => null);
    moved++;
  }
  await sendModerationLog(
    ctx.client,
    ctx.guildConfig,
    buildVoiceForceMoveAllLog({
      mod: { id: ctx.actor.id, name: ctx.actor.user.username, avatarUrl: ctx.actor.displayAvatarURL({ size: 128 }) },
      fromChannel: { id: from.id, name: from.name },
      toChannel: { id: to.id, name: to.name },
      count: moved,
    }),
    {
      guildId: ctx.guild.id,
      eventType: "voice_mod",
      actorId: ctx.actor.id,
      channelId: to.id,
    },
  );
  return moved;
}

async function actSlowmode(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const seconds = Math.min(21600, Math.max(0, valueToInt(args.seconds, -1)));
  if (seconds < 0) throw new DreamcodeError("runtime", "slowmode requires seconds", pos);
  const channel = await resolveTextChannel(ctx, args.channel, pos, true);
  await channel.setRateLimitPerUser(seconds, "Dreamcode slowmode");
  return seconds;
}

async function actLockChannel(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  lock: boolean,
): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos, true);
  const roleId = adminConfig(ctx).lockdown_role_id ?? ctx.guild.id;
  await channel.permissionOverwrites.edit(
    roleId,
    { SendMessages: lock ? false : null },
    { reason: lock ? "Dreamcode lock_channel" : "Dreamcode unlock_channel" },
  );
  return true;
}

async function actLockdown(ctx: HostContext, lock: boolean): Promise<DreamValue> {
  const cfg = adminConfig(ctx);
  const result = lock ? await applyLockdown(ctx.guild, cfg) : await applyUnlock(ctx.guild, cfg);
  return { updated: result.updated, target: result.target };
}

async function actCreateInvite(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos, true);
  const invite = await channel.createInvite({
    maxAge: valueToInt(args.max_age, 86400),
    maxUses: valueToInt(args.max_uses, 0),
    reason: "Dreamcode create_invite",
  });
  return invite.url;
}

async function actTagGet(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  if (!name) throw new DreamcodeError("runtime", "tag name required", pos);
  const tag = await getTag(ctx.guild.id, name);
  return tag ? { name: tag.name, content: tag.content } : null;
}

async function actTagCreate(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  const content = valueToString(args.content);
  if (!name || !content) throw new DreamcodeError("runtime", "tag_create requires name and content", pos);
  if (await getTag(ctx.guild.id, name)) throw new DreamcodeError("runtime", "Tag already exists", pos);
  const tag = await createTag({ guildId: ctx.guild.id, name, content, createdBy: ctx.actor.id });
  return { name: tag.name, content: tag.content };
}

async function actTagEdit(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  const content = valueToString(args.content);
  if (!name || !content) throw new DreamcodeError("runtime", "tag_edit requires name and content", pos);
  return updateTag(ctx.guild.id, name, content);
}

async function actTagDelete(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  if (!name) throw new DreamcodeError("runtime", "tag name required", pos);
  return deleteTag(ctx.guild.id, name);
}

async function actCounterGet(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const name = valueToString(args.name);
  if (!name) throw new DreamcodeError("runtime", "counter name required", pos);
  const row = await getCounter(ctx.guild.id, name);
  return row ? { name: row.name, value: row.value, channelId: row.channelId } : null;
}

async function actCounterSet(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  relative: boolean,
): Promise<DreamValue> {
  const name = valueToString(args.name);
  if (!name) throw new DreamcodeError("runtime", "counter name required", pos);
  const row = await getCounter(ctx.guild.id, name);
  if (!row) throw new DreamcodeError("runtime", `Counter '${name}' not found`, pos);
  const next = relative ? row.value + valueToInt(args.amount, 0) : valueToInt(args.value, 0);
  await updateCounterValue(ctx.guild.id, name, next);
  await refreshCounterDisplay(ctx.guild, { ...row, value: next }, next);
  return next;
}

async function actRemind(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const ms = parseDuration(valueToString(args.duration)) ?? parseDurationValue(args.duration, pos);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const message = valueToString(args.message);
  if (!message) throw new DreamcodeError("runtime", "remind requires message", pos);
  const user = args.user ? await resolveUser(ctx, args.user, pos) : ctx.actor.user;
  const channel = args.channel
    ? await resolveTextChannel(ctx, args.channel, pos)
    : await resolveTextChannel(ctx, null, pos, true);
  const row = await createReminder({
    guildId: ctx.guild.id,
    userId: user.id,
    channelId: channel.id,
    message,
    delayMinutes: minutes,
  });
  return { id: row.id, remindAt: row.remindAt.getTime(), userId: row.userId, channelId: row.channelId };
}

async function actRemindCancel(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToInt(args.id, 0);
  if (!id) throw new DreamcodeError("runtime", "remind_cancel requires id", pos);
  const user = args.user ? await resolveUser(ctx, args.user, pos) : ctx.actor.user;
  return cancelReminder(ctx.guild.id, user.id, id);
}

async function actSchedulePost(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const content = valueToString(args.content);
  if (!content) throw new DreamcodeError("runtime", "schedule_post requires content", pos);
  const ms = parseDuration(valueToString(args.duration)) ?? parseDurationValue(args.duration, pos);
  const delayMinutes = Math.max(1, Math.round(ms / 60_000));
  const row = await createScheduledPost({
    guildId: ctx.guild.id,
    channelId: channel.id,
    content,
    delayMinutes,
    createdBy: ctx.actor.id,
  });
  return { id: row.id, nextRunAt: row.nextRunAt?.getTime() ?? null, channelId: row.channelId };
}

async function actSchedulePostCancel(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToInt(args.id, 0);
  if (!id) throw new DreamcodeError("runtime", "schedule_post_cancel requires id", pos);
  return deleteScheduledPost(ctx.guild.id, id);
}

async function actLog(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  kind: "mod" | "server",
): Promise<DreamValue> {
  const title = valueToString(args.title);
  const content = valueToString(args.content);
  if (!title || !content) throw new DreamcodeError("runtime", "log requires title and content", pos);
  const card = {
    title,
    information: [content],
    extra: valueToString(args.extra) || undefined,
    emojiCategory: kind === "mod" ? ("modDefault" as const) : ("serverUpdate" as const),
  };
  if (kind === "mod") {
    await sendModerationLog(ctx.client, ctx.guildConfig, card, {
      guildId: ctx.guild.id,
      eventType: "dreamcode_mod",
      actorId: ctx.actor.id,
    });
  } else {
    await sendServerLog(ctx.client, ctx.guildConfig, card, {
      guildId: ctx.guild.id,
      eventType: "dreamcode_server",
      actorId: ctx.actor.id,
    });
  }
  return true;
}

async function actGetMember(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  return memberObject(member, ctx.guildConfig);
}

async function actGetUser(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  const level = member ? getMemberLevel(member, ctx.guildConfig.levels) : 0;
  return userObject(user, level);
}

async function actGetRole(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const roleId = valueToId(args.role);
  if (!roleId) throw new DreamcodeError("runtime", "role required", pos);
  const role = ctx.guild.roles.cache.get(roleId) ?? (await ctx.guild.roles.fetch(roleId).catch(() => null));
  return role ? roleObject(role) : null;
}

async function actGetChannel(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const id = valueToId(args.channel);
  if (!id) throw new DreamcodeError("runtime", "channel required", pos);
  const channel = ctx.guild.channels.cache.get(id) ?? (await ctx.guild.channels.fetch(id).catch(() => null));
  return channel ? channelObject(channel) : null;
}

async function actGetMessage(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const channel = await resolveTextChannel(ctx, args.channel, pos);
  const messageId = valueToId(args.message_id) ?? valueToString(args.message_id);
  if (!messageId) throw new DreamcodeError("runtime", "message_id required", pos);
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  return msg ? messageObject(msg) : null;
}

async function actMemberLevel(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  return getMemberLevel(member, ctx.guildConfig.levels);
}

async function actIsTimedOut(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  return member.isCommunicationDisabled();
}

async function actIsBanned(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  const ban = await ctx.guild.bans.fetch(user.id).catch(() => null);
  return Boolean(ban);
}

async function actLocate(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const member = await resolveMember(ctx, args.user, pos);
  return member.voice.channel ? channelObject(member.voice.channel) : null;
}

async function actNameHistory(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  const entries = await getUserNameHistory(ctx.guild.id, user.id, 20);
  return entries.map((e) => ({
    oldName: e.oldName,
    newName: e.newName,
    changeType: e.changeType,
    changedAt: e.changedAt.getTime(),
  }));
}

function actSnowflakeInfo(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const id = valueToId(args.id) ?? valueToString(args.id);
  if (!/^\d{17,20}$/.test(id)) throw new DreamcodeError("runtime", "Invalid snowflake", pos);
  const ts = snowflakeToTimestamp(id);
  return { id, timestamp: ts.getTime(), iso: ts.toISOString() };
}

async function actMessageCount(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const user = await resolveUser(ctx, args.user, pos);
  return getGuildMessageCount(ctx.guild.id, user.id);
}

function actRandom(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const min = valueToInt(args.min, NaN as unknown as number);
  const max = valueToInt(args.max, NaN as unknown as number);
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new DreamcodeError("runtime", "random requires min and max", pos);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function actChoose(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const raw = valueToString(args.options);
  if (!raw) throw new DreamcodeError("runtime", "choose requires options", pos);
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new DreamcodeError("runtime", "choose needs at least one option", pos);
  return parts[Math.floor(Math.random() * parts.length)]!;
}

function actLength(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const value = args.value;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  throw new DreamcodeError("runtime", "length expects a string or array", pos);
}

function actContains(args: BoundActionArgs): DreamValue {
  const haystack = valueToString(args.haystack);
  const needle = valueToString(args.needle);
  if (asBool(args.case_sensitive)) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function actReplace(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const value = valueToString(args.value);
  const search = valueToString(args.search);
  if (!search) throw new DreamcodeError("runtime", "replace requires search", pos);
  return value.split(search).join(valueToString(args.replacement));
}

function actFormatTime(args: BoundActionArgs, pos: SourcePos): DreamValue {
  const ms = valueToInt(args.ms, 0);
  if (!ms) throw new DreamcodeError("runtime", "format_time requires ms", pos);
  const style = (valueToString(args.style, "R") || "R") as "R" | "F" | "D" | "f" | "t" | "T";
  return discordTimestamp(new Date(ms), style);
}

async function actEconomyBalance(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const { loadEconomyConfig } = await import("../../economy/functions/config.js");
  const { getAccount, getPrimaryCurrencyKey, ensureGuildCurrencies } = await import("../../economy/functions/money.js");
  const config = await loadEconomyConfig(ctx.guild.id);
  if (!config) return null;
  ensureGuildCurrencies(ctx.guild.id, config);
  const user = await resolveUser(ctx, args.user, pos);
  const currencyKey = valueToString(args.currency) || getPrimaryCurrencyKey(ctx.guild.id, config);
  const bal = getAccount(ctx.guild.id, user.id, currencyKey);
  return { pocket: bal.pocket, bank: bal.bank, frozen: bal.frozen, currencyKey };
}

async function actEconomyMutate(
  ctx: HostContext,
  args: BoundActionArgs,
  pos: SourcePos,
  mode: "add" | "take",
): Promise<DreamValue> {
  const { loadEconomyConfig } = await import("../../economy/functions/config.js");
  const { mutateMoney, getPrimaryCurrencyKey, ensureGuildCurrencies, grantStartingBalance } = await import(
    "../../economy/functions/money.js"
  );
  const config = await loadEconomyConfig(ctx.guild.id);
  if (!config) throw new DreamcodeError("runtime", "Economy plugin is disabled", pos);
  if (getMemberLevel(ctx.actor, ctx.guildConfig.levels) < 50) {
    throw new DreamcodeError("runtime", "economy_add/take require level >= 50", pos);
  }
  ensureGuildCurrencies(ctx.guild.id, config);
  const user = await resolveUser(ctx, args.user, pos);
  grantStartingBalance(ctx.guild.id, user.id, config);
  const amount = Math.abs(valueToInt(args.amount, 0));
  if (amount <= 0) throw new DreamcodeError("runtime", "amount must be positive", pos);
  const currencyKey = valueToString(args.currency) || getPrimaryCurrencyKey(ctx.guild.id, config);
  const bal = mutateMoney(
    {
      guildId: ctx.guild.id,
      userId: user.id,
      currencyKey,
      deltaPocket: mode === "add" ? amount : -amount,
      reason: mode === "add" ? "dreamcode_add" : "dreamcode_take",
      actorId: ctx.actor.id,
    },
    { config, skipPauseCheck: true },
  );
  return bal.pocket;
}

async function actEconomyHasItem(ctx: HostContext, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue> {
  const { loadEconomyConfig } = await import("../../economy/functions/config.js");
  const { getItemByKey, getInventoryQty } = await import("../../economy/functions/inventory.js");
  const config = await loadEconomyConfig(ctx.guild.id);
  if (!config) return false;
  const user = await resolveUser(ctx, args.user, pos);
  const itemKey = valueToString(args.item);
  if (!itemKey) throw new DreamcodeError("runtime", "economy_has_item requires item", pos);
  const item = getItemByKey(ctx.guild.id, itemKey);
  if (!item) return false;
  const need = Math.max(1, valueToInt(args.quantity, 1));
  return getInventoryQty(ctx.guild.id, user.id, item.id) >= need;
}

export { guildObject, memberObject, channelObject, messageObject };
