import type { Client, Guild } from "discord.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId, getServerLogChannelId } from "./channels.js";
import { LOG_EVENT_META, LOG_EVENT_TYPES, type LogEventType } from "./events.js";
import {
  buildAutomodLog,
  buildCaseCreateLog,
  buildCaseDeleteLog,
  buildCaseUpdateLog,
  buildCensorLog,
  buildChannelCreateLog,
  buildChannelDeleteLog,
  buildChannelUpdateLog,
  buildCleanLog,
  buildDmFailedLog,
  buildEmojiLog,
  buildGenericServerLog,
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
  buildMuteExpiredLog,
  buildNicknameChangeLog,
  buildRaidDetectedLog,
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
  buildVoiceForceMoveLog,
  buildVoiceJoinLog,
  buildVoiceLeaveLog,
  buildVoiceMoveLog,
  buildWebhookUpdateLog,
} from "./format.js";
import { emitLog } from "./send.js";
import type { LogCard, LogRef } from "./types.js";

const TEST_MARKER = "🧪 TEST — ";
const TEST_REASON = "Test log — safe to ignore";

type TestCtx = {
  actor: LogRef;
  target: LogRef;
  channel: LogRef;
  role: LogRef;
  guild: Guild;
};

function buildCtx(guild: Guild, actor: LogRef): TestCtx {
  const botMember = guild.members.me;
  const target: LogRef = botMember
    ? { id: botMember.id, name: botMember.user.username, avatarUrl: botMember.displayAvatarURL({ size: 128 }), bot: true }
    : { ...actor };

  const sampleChannel = guild.channels.cache.find((c) => c.isTextBased() && !c.isThread());
  const channel: LogRef = sampleChannel
    ? { id: sampleChannel.id, name: "name" in sampleChannel ? (sampleChannel.name ?? undefined) : undefined }
    : { id: guild.id, name: "general" };

  const sampleRole = guild.roles.cache.find((r) => r.id !== guild.id && !r.managed);
  const role: LogRef = sampleRole ? { id: sampleRole.id, name: sampleRole.name } : { id: guild.id, name: "Test Role" };

  return { actor, target, channel, role, guild };
}

const BUILDERS: Record<LogEventType, (ctx: TestCtx) => LogCard> = {
  member_join: (ctx) => buildMemberJoinLog(ctx.target, { memberCount: ctx.guild.memberCount }),
  member_leave: (ctx) => buildMemberLeaveLog(ctx.target, { memberCount: ctx.guild.memberCount }),
  member_kick: (ctx) => buildMemberKickLog({ user: ctx.target, mod: ctx.actor, reason: TEST_REASON }),
  member_ban: (ctx) => buildMemberBanLog({ user: ctx.target, mod: ctx.actor, reason: TEST_REASON, deleteMessageDays: 1 }),
  member_unban: (ctx) => buildMemberUnbanLog({ user: ctx.target, mod: ctx.actor, reason: TEST_REASON }),
  member_timeout: (ctx) =>
    buildTimeoutChangeLog({ user: ctx.target, mod: ctx.actor, before: null, after: "in 10 minutes", reason: TEST_REASON }),
  member_nick: (ctx) => buildNicknameChangeLog({ user: ctx.target, mod: ctx.actor, oldNick: "OldNickname", newNick: "NewNickname" }),
  member_roles: (ctx) =>
    buildRoleChangeLog({ user: ctx.target, added: [ctx.role], removed: [], mod: ctx.actor }),

  message_edit: (ctx) =>
    buildMessageEditLog({
      user: ctx.target,
      channel: ctx.channel,
      before: "This is the original test message content.",
      after: "This is the *edited* test message content.",
    }),
  message_delete: (ctx) =>
    buildMessageDeleteLog({ user: ctx.target, channel: ctx.channel, content: "This test message was deleted.", executor: ctx.actor }),
  message_bulk_delete: (ctx) =>
    buildMessageBulkDeleteLog({
      channel: ctx.channel,
      count: 12,
      mod: ctx.actor,
      authorCounts: [{ user: ctx.target, count: 12 }],
    }),
  message_pin: (ctx) => buildMessagePinLog({ user: ctx.target, channel: ctx.channel, pinned: true }),

  channel_create: (ctx) => buildChannelCreateLog({ channel: ctx.channel, type: "GuildText", mod: ctx.actor }),
  channel_delete: (ctx) => buildChannelDeleteLog({ channel: { id: "000000000000000000", name: "deleted-channel" }, type: "GuildText", mod: ctx.actor }),
  channel_update: (ctx) => buildChannelUpdateLog({ channel: ctx.channel, changes: ["Name: old-name -> new-name", "Slowmode: 0s -> 10s"], mod: ctx.actor }),
  thread_create: (ctx) => buildThreadCreateLog({ user: ctx.actor, thread: { id: ctx.channel.id, name: "Test Thread" }, parentChannel: ctx.channel, type: "PublicThread" }),
  thread_update: (ctx) => buildThreadArchiveLog({ thread: { id: ctx.channel.id, name: "Test Thread" }, parentChannel: ctx.channel, archived: true, mod: ctx.actor }),
  thread_delete: (ctx) => buildThreadDeleteLog({ thread: { id: "000000000000000000", name: "Test Thread" }, parentChannel: ctx.channel, mod: ctx.actor }),

  role_create: (ctx) => buildRoleCreateLog({ role: ctx.role, mod: ctx.actor, color: "#5865F2" }),
  role_delete: (ctx) => buildRoleDeleteLog({ role: ctx.role, mod: ctx.actor }),
  role_update: (ctx) => buildRoleUpdateLog({ role: ctx.role, changes: ["Color: #000000 -> #5865F2", "Hoist: false -> true"], mod: ctx.actor }),
  guild_update: (ctx) => buildGuildUpdateLog({ changes: ["Name: Old Server Name -> New Server Name"], mod: ctx.actor }),
  emoji_create: (ctx) => buildEmojiLog({ action: "create", name: "test_emoji", id: "000000000000000000", mod: ctx.actor, animated: false }),
  emoji_delete: (ctx) => buildEmojiLog({ action: "delete", name: "test_emoji", id: "000000000000000000", mod: ctx.actor }),
  emoji_update: (ctx) => buildEmojiLog({ action: "update", name: "old_name -> new_name", id: "000000000000000000", mod: ctx.actor }),
  sticker_create: (ctx) => buildStickerLog({ action: "create", name: "test_sticker", id: "000000000000000000", mod: ctx.actor, description: "A test sticker" }),
  sticker_delete: (ctx) => buildStickerLog({ action: "delete", name: "test_sticker", id: "000000000000000000", mod: ctx.actor }),
  sticker_update: (ctx) => buildStickerLog({ action: "update", name: "old_name -> new_name", id: "000000000000000000", mod: ctx.actor }),
  invite_create: (ctx) => buildInviteCreateLog({ code: "abc123", channel: ctx.channel, inviter: ctx.actor, maxUses: 0, maxAge: 0, temporary: false }),
  invite_delete: (ctx) => buildInviteDeleteLog({ code: "abc123", channel: ctx.channel, mod: ctx.actor }),
  webhook_update: (ctx) => buildWebhookUpdateLog({ channel: ctx.channel, mod: ctx.actor }),

  voice_join: (ctx) => buildVoiceJoinLog(ctx.target, ctx.channel),
  voice_leave: (ctx) => buildVoiceLeaveLog(ctx.target, ctx.channel),
  voice_move: (ctx) => buildVoiceMoveLog({ user: ctx.target, fromChannel: ctx.channel, toChannel: ctx.channel }),
  voice_server_mute: (ctx) => buildVoiceFlagLog({ title: "Server Muted", user: ctx.target, channel: ctx.channel, detail: "Server mute: on" }),
  voice_server_deafen: (ctx) => buildVoiceFlagLog({ title: "Server Deafened", user: ctx.target, channel: ctx.channel, detail: "Server deafen: on" }),
  voice_self_mute: (ctx) => buildVoiceFlagLog({ title: "Self Muted", user: ctx.target, channel: ctx.channel, detail: "Self mute: on" }),
  voice_self_deafen: (ctx) => buildVoiceFlagLog({ title: "Self Deafened", user: ctx.target, channel: ctx.channel, detail: "Self deafen: on" }),
  voice_stream: (ctx) => buildVoiceFlagLog({ title: "Stream Started", user: ctx.target, channel: ctx.channel, detail: "Streaming: on" }),
  voice_video: (ctx) => buildVoiceFlagLog({ title: "Camera On", user: ctx.target, channel: ctx.channel, detail: "Camera: on" }),

  case_create: (ctx) =>
    buildCaseCreateLog(
      {
        id: 999999,
        type: "warn",
        userId: ctx.target.id,
        modId: ctx.actor.id,
        reason: TEST_REASON,
        createdAt: new Date(),
        expiresAt: null,
      } as Parameters<typeof buildCaseCreateLog>[0],
      { user: ctx.target, mod: ctx.actor, priorCaseCount: 2 },
    ),
  case_update: (ctx) => buildCaseUpdateLog(999999, "warn", ctx.actor, "Updated the reason on this case."),
  case_delete: (ctx) => buildCaseDeleteLog(999999, ctx.actor, TEST_REASON),
  case_expire: (ctx) => buildMuteExpiredLog(ctx.target),
  automod: (ctx) => buildAutomodLog({ user: ctx.target, channel: ctx.channel, reason: "Spam detected", action: "Delete + Warn", content: "buy cheap discord nitro at bit.ly/totally-real" }),
  raid: (ctx) => buildRaidDetectedLog({ user: ctx.target, joinCount: 8, windowMs: 30_000, recentJoiners: [ctx.target, ctx.actor] }),
  censor: (ctx) => buildCensorLog({ user: ctx.target, channel: ctx.channel, pattern: "badword", action: "Delete" }),
  clean: (ctx) => buildCleanLog({ mod: ctx.actor, channel: ctx.channel, count: 25, targets: [ctx.target] }),
  voice_mod: (ctx) => buildVoiceForceMoveLog({ target: ctx.target, mod: ctx.actor, fromChannel: ctx.channel, toChannel: ctx.channel }),
  dm_failed: (ctx) => buildDmFailedLog(ctx.target, "warn"),
  dreamcode_mod: () =>
    buildGenericServerLog("Custom Command Mod Log", ["A custom command logged this test entry."], null, "modDefault"),
  dreamcode_server: () =>
    buildGenericServerLog("Custom Command Server Log", ["A custom command logged this test entry."], null, "serverUpdate"),
  passport_verify: (ctx) =>
    buildGenericServerLog(
      "Passport Verify",
      [`Member: <@${ctx.target.id}> (\`${ctx.target.id}\`)`, "Result: **Passed**"],
      ctx.target.avatarUrl,
      "modDefault",
    ),
  passport_kick: (ctx) =>
    buildGenericServerLog(
      "Passport Kick",
      [`Member: <@${ctx.target.id}> (\`${ctx.target.id}\`)`, "Reason: Verification timed out"],
      ctx.target.avatarUrl,
      "modSevere",
    ),
  economy_admin_change: (ctx) =>
    buildGenericServerLog(
      "Economy Settings Change",
      [`By: <@${ctx.actor.id}>`, "Currency: **Coins**", "Multiplier: **1.5x**"],
      null,
      "serverUpdate",
    ),
  ticket_open: (ctx) =>
    buildGenericServerLog("Ticket #1 Opened", [`Opened by: <@${ctx.actor.id}>`, "Category: **Test Category**", `Channel: <#${ctx.channel.id}>`], ctx.actor.avatarUrl, "create"),
  ticket_claim: (ctx) =>
    buildGenericServerLog("Ticket #1 Claimed", [`Claimed by: <@${ctx.actor.id}>`, `Channel: <#${ctx.channel.id}>`], ctx.actor.avatarUrl, "action"),
  ticket_close: (ctx) =>
    buildGenericServerLog("Ticket #1 Closed", [`Closed by: <@${ctx.actor.id}>`, `Channel: <#${ctx.channel.id}>`, `Reason: ${TEST_REASON}`], ctx.actor.avatarUrl, "delete"),

  dashboard_config: (ctx) =>
    buildGenericServerLog(
      "Config Update",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Updated server configuration."],
      null,
      "serverUpdate",
    ),
  dashboard_tag: (ctx) =>
    buildGenericServerLog("Tag Change", [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Created tag **welcome**."], null, "edit"),
  dashboard_command: (ctx) =>
    buildGenericServerLog(
      "Dream Command Change",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Created command **/greet**."],
      null,
      "edit",
    ),
  dashboard_suggestion: (ctx) =>
    buildGenericServerLog(
      "Suggestion Admin",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Approved suggestion #12."],
      null,
      "modDefault",
    ),
  dashboard_automod: (ctx) =>
    buildGenericServerLog(
      "Automod Update",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Updated automod rules."],
      null,
      "serverUpdate",
    ),
  dashboard_chart: (ctx) =>
    buildGenericServerLog("Custom Chart", [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Created a custom chart."], null, "edit"),
  dashboard_scam_protect: (ctx) =>
    buildGenericServerLog(
      "Scam Protect",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Enabled Scam Protect."],
      null,
      "serverUpdate",
    ),
  dashboard_welcome: (ctx) =>
    buildGenericServerLog(
      "Welcomer Asset",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Uploaded a welcome background."],
      null,
      "edit",
    ),
  dashboard_review: (ctx) =>
    buildGenericServerLog("Review Admin", [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Deleted a review."], null, "modDefault"),
  dashboard_bot_brand: (ctx) =>
    buildGenericServerLog(
      "Bot Brand",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Updated the bot's nickname."],
      null,
      "edit",
    ),
  dashboard_economy: (ctx) =>
    buildGenericServerLog(
      "Economy Change",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Adjusted the economy config."],
      null,
      "serverUpdate",
    ),
  dashboard_ticket: (ctx) =>
    buildGenericServerLog(
      "Ticket Admin",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Performed a ticket action."],
      null,
      "modDefault",
    ),
  dashboard_tts: (ctx) =>
    buildGenericServerLog(
      "TTS Admin",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Updated the TTS blacklist."],
      null,
      "modDefault",
    ),
  dashboard_permission_role: (ctx) =>
    buildGenericServerLog(
      "Dreamliner Role Change",
      [`Actor: <@${ctx.actor.id}>`, "Source: Web dashboard", "Changed a Dreamliner Role."],
      null,
      "serverUpdate",
    ),
};

export type TestLogResult = {
  eventType: LogEventType;
  ok: boolean;
  reason?: string;
};

/**
 * Sends a synthetic log card for one event type to whatever channel that event's category
 * (server/moderation) resolves to for this guild. Bypasses the per-event toggle and does not
 * write to the dashboard Logs history — this is a preview, not a real event.
 */
export async function sendLogEventTest(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  eventType: LogEventType,
  actorId: string,
): Promise<TestLogResult> {
  const category = LOG_EVENT_META[eventType].category;
  const channelId =
    category === "moderation" ? getModerationLogChannelId(guildConfig) : getServerLogChannelId(guildConfig);
  if (!channelId) {
    return { eventType, ok: false, reason: `No ${category} log channel configured for this server.` };
  }

  const actorMember = await guild.members.fetch(actorId).catch(() => null);
  const actor: LogRef = actorMember
    ? { id: actorMember.id, name: actorMember.user.username, avatarUrl: actorMember.displayAvatarURL({ size: 128 }) }
    : { id: actorId };

  const ctx = buildCtx(guild, actor);
  const build = BUILDERS[eventType];
  if (!build) {
    return { eventType, ok: false, reason: "No test template for this event type." };
  }

  const card = build(ctx);
  const logId = await emitLog(
    client,
    guildConfig,
    { ...card, title: `${TEST_MARKER}${card.title}` },
    { guildId: guild.id, eventType, actorId, summary: `Test send of ${LOG_EVENT_META[eventType].label}` },
    { skipToggleCheck: true, skipPersist: true },
  );

  return { eventType, ok: true, reason: logId == null ? "Sent, but the channel could not be reached." : undefined };
}

export async function sendAllLogTests(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  actorId: string,
  eventTypes?: LogEventType[],
): Promise<TestLogResult[]> {
  const types = eventTypes?.length ? eventTypes : [...LOG_EVENT_TYPES];
  const results: TestLogResult[] = [];
  for (const eventType of types) {
    // Sequential, not parallel — keeps delivery order sane in the log channel and avoids
    // hammering the Discord API with dozens of concurrent sends.
    results.push(await sendLogEventTest(client, guild, guildConfig, eventType, actorId));
  }
  return results;
}
