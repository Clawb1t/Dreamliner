/**
 * Everything that changes a giveaway's state, shared by the slash commands, the buttons, the
 * dashboard bridge and the scheduler, so each action behaves the same wherever it's started.
 *
 * Every transition is a conditional UPDATE (store.transitionGiveaway / claimGiveawayForEnding), so
 * two callers racing (a click and the poller, two staff members) can never both act. Discord
 * problems (channel deleted, message deleted, missing permissions) never stop the state change:
 * they're recorded on the giveaway as `lastError` and shown on the dashboard.
 */
import type { Client, Guild, Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { emitLog } from "../../../core/logging/send.js";
import { getLogger } from "../../../core/logger.js";
import { fetchGuildChannel, fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { drawWinners, expireUnclaimedWinners, rerollWinners, type RerollResult } from "./draw.js";
import { leaveGiveaway } from "./entries.js";
import {
  GIVEAWAY_EMOJI,
  asEdit,
  buildAnnouncementV2,
  cancelledPayload,
  endedPayload,
  livePayload,
  messageUrl,
  type GiveawayPayload,
} from "./message.js";
import { nextOccurrence } from "./recurrence.js";
import * as store from "./store.js";
import type { Giveaway } from "./store.js";

const log = getLogger("giveaways");

export type ActionResult = { ok: true; giveaway: Giveaway; note?: string } | { ok: false; error: string };

/** DMs are best effort and capped, so a huge giveaway can't queue thousands of DMs. */
const MAX_DMS = 500;
export const MAX_EXTEND_MINUTES = 60 * 24 * 60;

function ts(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

async function recordError(giveaway: Giveaway, error: string | null): Promise<void> {
  if (giveaway.lastError === error) return;
  giveaway.lastError = error;
  await store.updateGiveaway(giveaway.id, { lastError: error }).catch(() => null);
  if (error) await store.addEvent(giveaway.id, "error", null, error).catch(() => null);
}

async function fetchPost(client: Client, giveaway: Giveaway): Promise<Message | null | "no_channel"> {
  if (!giveaway.messageId) return null;
  const channel = await fetchGuildChannel(client, giveaway.guildId, giveaway.channelId);
  if (!channel?.isTextBased() || !("messages" in channel)) return "no_channel";
  return channel.messages.fetch(giveaway.messageId).catch(() => null);
}

/** Edits the giveaway post. Never throws; a missing channel or message is recorded, not fatal. */
async function editPost(client: Client, giveaway: Giveaway, payload: GiveawayPayload): Promise<boolean> {
  if (!giveaway.messageId) return false;
  const message = await fetchPost(client, giveaway);
  if (message === "no_channel") {
    await recordError(giveaway, "The giveaway's channel was deleted or Dreamliner can't see it.");
    return false;
  }
  if (!message) {
    await recordError(giveaway, "The giveaway message was deleted.");
    return false;
  }
  try {
    await message.edit(asEdit(payload) as Parameters<Message["edit"]>[0]);
    if (giveaway.lastError) await recordError(giveaway, null);
    return true;
  } catch (error) {
    log.warn(`Could not edit giveaway #${giveaway.id}'s message:`, error);
    await recordError(giveaway, "Dreamliner couldn't edit the giveaway message.");
    return false;
  }
}

/** Posts in the giveaway's channel, as a reply to the post when it still exists. */
async function postInChannel(client: Client, giveaway: Giveaway, payload: GiveawayPayload): Promise<Message | null> {
  const channel = await fetchGuildTextChannel(client, giveaway.guildId, giveaway.channelId);
  if (!channel) return null;
  return channel
    .send({
      ...payload,
      ...(giveaway.messageId ? { reply: { messageReference: giveaway.messageId, failIfNotExists: false } } : {}),
    } as Parameters<typeof channel.send>[0])
    .catch((error) => {
      log.warn(`Could not post in giveaway #${giveaway.id}'s channel:`, error);
      return null;
    });
}

async function dmUsers(client: Client, userIds: string[], content: string): Promise<void> {
  for (const userId of userIds.slice(0, MAX_DMS)) {
    const user = await client.users.fetch(userId).catch(() => null);
    await user?.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => null);
  }
}

function winnerDm(giveaway: Giveaway, guildName: string, kind: "draw" | "reroll" | "auto_reroll"): string {
  const lines = [
    `${GIVEAWAY_EMOJI.tada} You won **${giveaway.prize.slice(0, 200)}** in **${guildName}**!`,
    kind === "auto_reroll" ? "The previous winner didn't claim in time, so it's yours now." : "",
    giveaway.claimWindowMinutes > 0
      ? `Claim it ${ts(new Date(Date.now() + giveaway.claimWindowMinutes * 60_000))} with the Claim prize button on the giveaway, or it goes to someone else.`
      : "",
    messageUrl(giveaway) ?? "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function log_(client: Client, giveaway: Giveaway, title: string, information: string[], eventType: string, summary: string, actorId: string | null) {
  const guildConfig = await configManager.getEffectiveConfig(giveaway.guildId);
  await emitLog(
    client,
    guildConfig,
    { title, information, emojiCategory: "action" },
    {
      guildId: giveaway.guildId,
      eventType: eventType as "giveaway_start",
      caseLogOverride: guildConfig.plugins.giveaways?.config?.log_channel_id,
      summary,
      ...(actorId ? { actorId } : {}),
      channelId: giveaway.channelId,
      messageId: giveaway.messageId,
    },
  ).catch(() => null);
}

async function endedSummary(giveaway: Giveaway) {
  const [winners, stats, draw] = await Promise.all([store.listWinners(giveaway.id), store.getEntryStats(giveaway.id), store.getInitialDraw(giveaway.id)]);
  return { winners, entrants: stats.entrants, totalWeight: stats.totalWeight, draw };
}

// -- Posting and refreshing ------------------------------------------------------------------------

/**
 * Posts a giveaway whose start has come, and flips it to "active". Claims the start first
 * (scheduled -> active) so two ticks can't post twice; if posting fails it goes back to
 * scheduled, except when the channel is gone, which cancels it.
 */
export async function startGiveaway(guild: Guild, giveaway: Giveaway): Promise<Giveaway | null> {
  const channel = await fetchGuildTextChannel(guild.client, guild.id, giveaway.channelId);
  if (!channel) {
    const exists = await fetchGuildChannel(guild.client, guild.id, giveaway.channelId);
    if (!exists) {
      const cancelled = await store.transitionGiveaway(giveaway.id, ["scheduled"], {
        status: "cancelled",
        cancelledAt: new Date(),
        lastError: "The giveaway's channel was deleted before it started.",
      });
      if (cancelled) await store.addEvent(giveaway.id, "error", null, "The channel was deleted before it started, so it was cancelled.");
      return null;
    }
    await recordError(giveaway, "Dreamliner can't post in the giveaway's channel. Check its permissions there.");
    return null;
  }

  const claimed = await store.transitionGiveaway(giveaway.id, ["scheduled"], { status: "active" });
  if (!claimed) return null;

  const message = await channel.send(livePayload(claimed, 0, guild, { ping: true }) as Parameters<typeof channel.send>[0]).catch((error) => {
    log.warn(`Could not post giveaway #${giveaway.id}:`, error);
    return null;
  });
  if (!message) {
    await store.updateGiveaway(giveaway.id, { status: "scheduled" });
    await recordError(claimed, "Dreamliner couldn't post the giveaway. Check its permissions in that channel.");
    return null;
  }
  if (claimed.entryMethod === "reaction") await message.react(claimed.reactionEmoji).catch(() => null);

  const updated = (await store.updateGiveaway(giveaway.id, { messageId: message.id, lastError: null })) ?? { ...claimed, messageId: message.id };
  await store.addEvent(giveaway.id, "started").catch(() => null);
  await log_(
    guild.client,
    updated,
    "Giveaway started",
    [`**Prize:** ${updated.prize}`, `**Channel:** <#${updated.channelId}>`, `**Ends:** ${ts(updated.endsAt)}`],
    "giveaway_start",
    `${updated.title || updated.prize} started in <#${updated.channelId}>.`,
    null,
  );
  return updated;
}

/** Re-renders the live post (entry count, pause state, edits). */
export async function refreshGiveawayMessage(guild: Guild, giveaway: Giveaway): Promise<void> {
  if (!giveaway.messageId) return;
  if (giveaway.status === "active" || giveaway.status === "paused") {
    const entryCount = await store.getEntryCount(giveaway.id);
    await editPost(guild.client, giveaway, livePayload(giveaway, entryCount, guild, { ping: true }));
  } else if (giveaway.status === "ended") {
    await editPost(guild.client, giveaway, endedPayload(giveaway, await endedSummary(giveaway), guild));
  } else if (giveaway.status === "cancelled") {
    await editPost(guild.client, giveaway, cancelledPayload(giveaway, guild));
  }
}

// -- Ending ----------------------------------------------------------------------------------------

/**
 * Draws (once), marks the giveaway ended (once), then edits the post, announces the winners, DMs
 * and logs. Only the caller that moves it from "ending" to "ended" announces, so a restart or a
 * race never pings twice. Also schedules the next occurrence of a recurring giveaway.
 */
export async function finishGiveaway(client: Client, giveaway: Giveaway, actorId: string | null = null): Promise<Giveaway> {
  const result = await drawWinners(giveaway, actorId);
  const ended = await store.transitionGiveaway(giveaway.id, ["ending"], { status: "ended", endedAt: new Date(), pausedAt: null });
  if (!ended) return (await store.getGiveaway(giveaway.guildId, giveaway.id)) ?? giveaway;

  const guild = await client.guilds.fetch(ended.guildId).catch(() => null);
  if (guild) {
    await editPost(client, ended, endedPayload(ended, await endedSummary(ended), guild));
    const announcement = await postInChannel(client, ended, buildAnnouncementV2(ended, result.winnerIds, "draw", messageUrl(ended)));
    if (announcement) await store.updateGiveaway(ended.id, { announceMessageId: announcement.id });
    else if (!ended.lastError) await recordError(ended, "Dreamliner couldn't post the winners in the giveaway's channel.");

    if (ended.dmWinner && result.winnerIds.length) await dmUsers(client, result.winnerIds, winnerDm(ended, guild.name, "draw"));
    if (ended.dmNonWinners) {
      const winnerSet = new Set(result.winnerIds);
      const losers = (await store.listEntries(ended.id)).map((e) => e.userId).filter((id) => !winnerSet.has(id));
      await dmUsers(client, losers, `The giveaway for **${ended.prize.slice(0, 200)}** in **${guild.name}** has ended. You didn't win this time.`);
    }
  }

  await store.addEvent(ended.id, "ended", actorId, result.winnerIds.length ? `${result.winnerIds.length} winner(s)` : "No eligible entrants").catch(() => null);
  await log_(
    client,
    ended,
    "Giveaway ended",
    [
      `**Prize:** ${ended.prize}`,
      `**Channel:** <#${ended.channelId}>`,
      result.winnerIds.length ? `**Winner(s):** ${result.winnerIds.map((id) => `<@${id}>`).join(", ")}` : "**Winner(s):** No valid entries",
    ],
    "giveaway_end",
    `${ended.title || ended.prize} ended with ${result.winnerIds.length} winner(s).`,
    actorId,
  );

  await spawnNextOccurrence(ended).catch((error) => log.error(`Couldn't schedule the next occurrence of giveaway #${ended.id}:`, error));
  return (await store.getGiveaway(ended.guildId, ended.id)) ?? ended;
}

/** Schedules the next copy of a recurring giveaway, once. */
export async function spawnNextOccurrence(giveaway: Giveaway, now: Date = new Date()): Promise<Giveaway | null> {
  if (giveaway.recurrence === "none" || giveaway.recurrenceNextId) return null;
  const next = nextOccurrence(giveaway.startsAt, giveaway.endsAt, giveaway.recurrence, now);
  if (!next) return null;
  const created = await store.createGiveaway({
    guildId: giveaway.guildId,
    channelId: giveaway.channelId,
    title: giveaway.title,
    prize: giveaway.prize,
    status: "scheduled",
    entryMethod: giveaway.entryMethod,
    reactionEmoji: giveaway.reactionEmoji,
    buttonLabel: giveaway.buttonLabel,
    buttonEmoji: giveaway.buttonEmoji,
    buttonStyle: giveaway.buttonStyle,
    embedConfig: giveaway.embedConfig,
    winnerCount: giveaway.winnerCount,
    requireRoleIds: giveaway.requireRoleIds,
    requireRoleMode: giveaway.requireRoleMode,
    blacklistRoleIds: giveaway.blacklistRoleIds,
    bypassRoleIds: giveaway.bypassRoleIds,
    minAccountAgeDays: giveaway.minAccountAgeDays,
    minJoinAgeDays: giveaway.minJoinAgeDays,
    requirePassport: giveaway.requirePassport,
    bonusRoleWeights: giveaway.bonusRoleWeights,
    boosterBonusWeight: giveaway.boosterBonusWeight,
    entryCost: giveaway.entryCost,
    winBonus: giveaway.winBonus,
    pingRoleId: giveaway.pingRoleId,
    dmWinner: giveaway.dmWinner,
    dmNonWinners: giveaway.dmNonWinners,
    claimWindowMinutes: giveaway.claimWindowMinutes,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
    createdBy: giveaway.createdBy,
    minMessages: giveaway.minMessages,
    hostId: giveaway.hostId,
    sponsor: giveaway.sponsor,
    recurrence: giveaway.recurrence,
    recurrenceParentId: giveaway.id,
    messageFormat: "v2",
  });
  if (!(await store.linkNextOccurrence(giveaway.id, created.id))) {
    // Someone else scheduled it first.
    await store.deleteGiveaway(created.id);
    return null;
  }
  await store.addEvent(created.id, "created", null, `Next ${giveaway.recurrence} occurrence of #${giveaway.id}`).catch(() => null);
  return created;
}

export async function endGiveawayNow(client: Client, giveaway: Giveaway, actorId: string | null): Promise<ActionResult> {
  if (giveaway.status !== "active" && giveaway.status !== "paused") {
    return { ok: false, error: giveaway.status === "scheduled" ? "This giveaway hasn't started yet." : `This giveaway is already ${giveaway.status}.` };
  }
  const claimed = await store.claimGiveawayForEnding(giveaway.id);
  if (!claimed) return { ok: false, error: "This giveaway is already being ended." };
  return { ok: true, giveaway: await finishGiveaway(client, claimed, actorId) };
}

// -- Pause, resume, extend, cancel -----------------------------------------------------------------

export async function pauseGiveaway(guild: Guild, giveaway: Giveaway, actorId: string | null): Promise<ActionResult> {
  const paused = await store.transitionGiveaway(giveaway.id, ["active"], { status: "paused", pausedAt: new Date() });
  if (!paused) return { ok: false, error: "Only a running giveaway can be paused." };
  await store.addEvent(paused.id, "paused", actorId).catch(() => null);
  await refreshGiveawayMessage(guild, paused);
  return { ok: true, giveaway: paused };
}

/** Resumes and pushes the end back by however long it was paused. */
export async function resumeGiveaway(guild: Guild, giveaway: Giveaway, actorId: string | null): Promise<ActionResult> {
  const pausedMs = giveaway.pausedAt ? Math.max(0, Date.now() - giveaway.pausedAt.getTime()) : 0;
  const resumed = await store.transitionGiveaway(giveaway.id, ["paused"], {
    status: "active",
    pausedAt: null,
    endsAt: new Date(giveaway.endsAt.getTime() + pausedMs),
  });
  if (!resumed) return { ok: false, error: "Only a paused giveaway can be resumed." };
  await store.addEvent(resumed.id, "resumed", actorId, pausedMs >= 60_000 ? `Paused for ${formatMinutes(pausedMs / 60_000)}` : null).catch(() => null);
  await refreshGiveawayMessage(guild, resumed);
  return { ok: true, giveaway: resumed };
}

export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes || 0));
  if (m % 1440 === 0 && m >= 1440) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m % 60 === 0 && m >= 60) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export async function extendGiveaway(guild: Guild, giveaway: Giveaway, minutes: number, actorId: string | null): Promise<ActionResult> {
  const add = Math.round(Number(minutes));
  if (!Number.isFinite(add) || add < 1 || add > MAX_EXTEND_MINUTES) return { ok: false, error: "Extend by 1 minute to 60 days." };
  if (giveaway.status !== "active" && giveaway.status !== "paused" && giveaway.status !== "scheduled") {
    return { ok: false, error: "Only a giveaway that hasn't ended can be extended." };
  }
  const base = Math.max(giveaway.endsAt.getTime(), giveaway.status === "scheduled" ? giveaway.startsAt.getTime() : Date.now());
  const extended = await store.transitionGiveaway(giveaway.id, ["active", "paused", "scheduled"], { endsAt: new Date(base + add * 60_000) });
  if (!extended) return { ok: false, error: "This giveaway changed while you were extending it. Try again." };
  await store.addEvent(extended.id, "extended", actorId, `+${formatMinutes(add)}`).catch(() => null);
  await refreshGiveawayMessage(guild, extended);
  return { ok: true, giveaway: extended };
}

async function refundAll(giveaway: Giveaway): Promise<number> {
  let refunded = 0;
  for (const entry of await store.listEntries(giveaway.id)) {
    if (entry.paid > 0) refunded += await leaveGiveaway(giveaway, entry.userId);
  }
  return refunded;
}

/** Cancels without drawing, refunds entry costs and stops a recurring giveaway from repeating. */
export async function cancelGiveaway(guild: Guild, giveaway: Giveaway, actorId: string | null): Promise<ActionResult> {
  const cancelled = await store.transitionGiveaway(giveaway.id, ["scheduled", "active", "paused"], { status: "cancelled", cancelledAt: new Date(), pausedAt: null });
  if (!cancelled) return { ok: false, error: `This giveaway is already ${giveaway.status}.` };
  const refunded = await refundAll(cancelled);
  await store.addEvent(cancelled.id, "cancelled", actorId, refunded > 0 ? "Entry costs refunded" : null).catch(() => null);
  if (cancelled.messageId) await editPost(guild.client, cancelled, cancelledPayload(cancelled, guild));
  return { ok: true, giveaway: cancelled };
}

/** Deletes the giveaway, its post and everything stored about it. Refunds if it never ended. */
export async function deleteGiveawayFully(guild: Guild, giveaway: Giveaway): Promise<void> {
  if (giveaway.status !== "ended" && giveaway.status !== "cancelled") await refundAll(giveaway);
  for (const messageId of [giveaway.messageId, giveaway.announceMessageId]) {
    if (!messageId) continue;
    const channel = await fetchGuildTextChannel(guild.client, guild.id, giveaway.channelId);
    await channel?.messages.delete(messageId).catch(() => null);
  }
  await store.deleteGiveaway(giveaway.id);
}

// -- Rerolls, claims, entrants -----------------------------------------------------------------

async function announceReroll(client: Client, giveaway: Giveaway, result: RerollResult, kind: "reroll" | "auto_reroll", actorId: string | null) {
  const guild = await client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (guild) {
    await editPost(client, giveaway, endedPayload(giveaway, await endedSummary(giveaway), guild));
    const announcement = await postInChannel(client, giveaway, buildAnnouncementV2(giveaway, result.newWinnerIds, kind, messageUrl(giveaway)));
    if (announcement) await store.updateGiveaway(giveaway.id, { announceMessageId: announcement.id });
    if (giveaway.dmWinner && result.newWinnerIds.length) await dmUsers(client, result.newWinnerIds, winnerDm(giveaway, guild.name, kind));
  }
  const detail =
    (kind === "auto_reroll" ? "Claim window expired. " : "") +
    (result.newWinnerIds.length ? `${result.oldWinnerIds.length} replaced, ${result.newWinnerIds.length} new` : "Nobody left to draw");
  await store.addEvent(giveaway.id, "rerolled", actorId, detail).catch(() => null);
  await log_(
    client,
    giveaway,
    kind === "auto_reroll" ? "Giveaway auto-rerolled" : "Giveaway rerolled",
    [
      `**Prize:** ${giveaway.prize}`,
      ...(kind === "auto_reroll" ? ["**Reason:** Claim window expired"] : actorId ? [`**By:** <@${actorId}>`] : []),
      `**Old winner(s):** ${result.oldWinnerIds.length ? result.oldWinnerIds.map((id) => `<@${id}>`).join(", ") : "none"}`,
      `**New winner(s):** ${result.newWinnerIds.length ? result.newWinnerIds.map((id) => `<@${id}>`).join(", ") : "No eligible entrants left"}`,
    ],
    "giveaway_reroll",
    `${giveaway.title || giveaway.prize}: ${result.newWinnerIds.length} winner(s) ${kind === "auto_reroll" ? "auto-rerolled" : "rerolled"}.`,
    actorId,
  );
}

/** Rerolls every current winner (`userIds` null) or just those members. */
export async function rerollGiveaway(client: Client, giveaway: Giveaway, userIds: string[] | null, actorId: string | null): Promise<ActionResult & { result?: RerollResult }> {
  if (giveaway.status !== "ended") return { ok: false, error: "Only an ended giveaway can be rerolled." };
  const current = await store.listCurrentWinners(giveaway.id);
  let rowIds: number[] | null = null;
  if (userIds) {
    const wanted = new Set(userIds);
    rowIds = current.filter((w) => wanted.has(w.userId)).map((w) => w.id);
    if (!rowIds.length) return { ok: false, error: "None of those members are current winners of this giveaway." };
  } else if (!current.length) {
    return { ok: false, error: "There are no current winners to reroll." };
  }
  const result = await rerollWinners(giveaway, rowIds, { actorId });
  if (!result.oldWinnerIds.length) return { ok: false, error: "Those winners were already rerolled." };
  await announceReroll(client, giveaway, result, "reroll", actorId);
  return { ok: true, giveaway: (await store.getGiveaway(giveaway.guildId, giveaway.id)) ?? giveaway, result };
}

export async function processExpiredClaims(client: Client, giveaway: Giveaway): Promise<void> {
  const result = await expireUnclaimedWinners(giveaway);
  if (!result.oldWinnerIds.length) return;
  await announceReroll(client, giveaway, result, "auto_reroll", null);
}

/** Takes a member out of a giveaway (refunding them), optionally blocking them from all giveaways here. */
export async function removeEntrant(
  guild: Guild,
  giveaway: Giveaway,
  userId: string,
  options: { blacklist?: boolean; reason?: string | null; actorId: string },
): Promise<ActionResult & { removed?: boolean }> {
  const entry = await store.getEntry(giveaway.id, userId);
  if (!entry && !options.blacklist) return { ok: false, error: "That member isn't entered in this giveaway." };
  if (entry) await leaveGiveaway(giveaway, userId);
  if (options.blacklist) await store.addToBlacklist({ guildId: guild.id, userId, reason: options.reason ?? null, createdBy: options.actorId });
  await store
    .addEvent(giveaway.id, "entrant_removed", options.actorId, `<@${userId}>${options.blacklist ? " (blocked from giveaways)" : ""}`)
    .catch(() => null);
  if (entry && (giveaway.status === "active" || giveaway.status === "paused")) await refreshGiveawayMessage(guild, giveaway);
  return { ok: true, giveaway, removed: Boolean(entry) };
}
