import type { Client, Guild, GuildMember, Invite, PartialGuildMember } from "discord.js";
import type { InviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import { configManager } from "../../../config/manager.js";
import { getLogger } from "../../../core/logger.js";
import { hasMemberPassedPassport } from "../../passport/functions/gate.js";
import { attributeJoin, UNKNOWN_ATTRIBUTION, type Attribution } from "./attribution.js";
import {
  beforeSnapshot,
  cachedGuildIds,
  dropGuild,
  fetchSnapshot,
  isCached,
  onInviteCreated,
  onInviteDeleted,
  storeSnapshot,
  warmGuild,
} from "./cache.js";
import { classifyJoin, classifyLeave, classifyVerified } from "./classify.js";
import {
  EMPTY_COUNTS,
  isInviteTrackerEnabled,
  loadActiveInviteTrackerConfig,
  loadInviteTrackerConfig,
  type FakeReason,
  type JoinSource,
  type JoinStatus,
} from "./config.js";
import { postInviteLog, sendJoinMessage, sendLeaveMessage, type InviteMessageFacts } from "./messages.js";
import { joinQueue } from "./queue.js";
import { raidDetector, recordRaidJoin } from "./raidActions.js";
import {
  activeTrackedCodes,
  closeStaleJoins,
  countMemberJoins,
  expirePendingJoins,
  foldOldJoins,
  getCounts,
  getLatestJoin,
  getOpenJoin,
  getTrackedLink,
  insertJoin,
  listGuildsWithJoins,
  listPendingGuilds,
  updateJoin,
  type InviteJoin,
} from "./store.js";
import { grantLinkRoles } from "./trackedLinks.js";

const log = getLogger("invite_tracker");

/** With more joins than this queued behind one, the rest of the burst skips the refetch. */
const BURST_QUEUE_LIMIT = 5;
const WARM_BATCH_SIZE = 5;
const WARM_BATCH_DELAY_MS = 1_000;

export const PENDING_SWEEP_MS = 10 * 60_000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

// ── Cache lifecycle ──────────────────────────────────────────────────────────

/** Warms every enabled guild's invite cache, a few at a time so a big shard doesn't burst the API. */
export async function warmAllGuilds(client: Client): Promise<void> {
  const guilds: Guild[] = [];
  for (const guild of client.guilds.cache.values()) {
    const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
    if (guildConfig && isInviteTrackerEnabled(guildConfig)) guilds.push(guild);
  }
  for (let i = 0; i < guilds.length; i += WARM_BATCH_SIZE) {
    await Promise.all(guilds.slice(i, i + WARM_BATCH_SIZE).map((guild) => warmGuild(guild).catch(() => null)));
    if (i + WARM_BATCH_SIZE < guilds.length) await new Promise((resolve) => setTimeout(resolve, WARM_BATCH_DELAY_MS));
  }
  if (guilds.length > 0) log.info(`Warmed invite caches for ${guilds.length} guild(s).`);
}

/** Keeps the cache in step with the plugin's on/off switch. */
export async function syncGuildCache(guild: Guild): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
  const enabled = Boolean(guildConfig && isInviteTrackerEnabled(guildConfig));
  if (enabled && !isCached(guild.id)) await warmGuild(guild);
  if (!enabled) forgetGuild(guild.id);
}

export function forgetGuild(guildId: string): void {
  dropGuild(guildId);
  raidDetector.forget(guildId);
}

export function handleInviteCreate(invite: Invite): void {
  if (invite.guild?.id) onInviteCreated(invite.guild.id, invite);
}

export function handleInviteDelete(invite: Invite): void {
  if (invite.guild?.id) onInviteDeleted(invite.guild.id, invite.code);
}

// ── Joins ────────────────────────────────────────────────────────────────────

async function attribute(guild: Guild, isBot: boolean, behind: number, trackedCodes: ReadonlySet<string>): Promise<Attribution> {
  if (isBot) return attributeJoin({ before: null, after: null, isBot: true });
  const before = beforeSnapshot(guild.id);
  // Deep in a burst every refetch would show several codes going up anyway, so the queued joins
  // skip it and the one that reaches the front of a short queue refetches for the batch.
  if (behind > BURST_QUEUE_LIMIT) return UNKNOWN_ATTRIBUTION;
  const after = await fetchSnapshot(guild);
  storeSnapshot(guild.id, after);
  return attributeJoin({ before, after, isBot: false, trackedCodes });
}

function inviterName(guild: Guild, inviterId: string | null): string | null {
  if (!inviterId) return null;
  const member = guild.members.cache.get(inviterId);
  return member?.displayName ?? guild.client.users.cache.get(inviterId)?.username ?? null;
}

async function resolveInviterName(guild: Guild, inviterId: string | null): Promise<string | null> {
  if (!inviterId) return null;
  const cached = inviterName(guild, inviterId);
  if (cached) return cached;
  const user = await guild.client.users.fetch(inviterId).catch(() => null);
  return user?.displayName ?? user?.username ?? null;
}

async function factsFor(guild: Guild, join: InviteJoin, linkName: string | null): Promise<InviteMessageFacts> {
  return {
    inviterId: join.inviterId,
    inviterName: await resolveInviterName(guild, join.inviterId),
    counts: join.inviterId ? getCounts(guild.id, join.inviterId) : { ...EMPTY_COUNTS },
    code: join.code,
    linkName,
    source: join.source as JoinSource,
    joinCount: countMemberJoins(guild.id, join.memberId),
    accountCreatedAt: join.accountCreatedAt.getTime(),
  };
}

/** Roles, join message and log for a join that now counts (straight away, or after Passport). */
async function announceJoin(member: GuildMember, config: InviteTrackerConfig, join: InviteJoin): Promise<void> {
  const link = join.trackedLinkId ? getTrackedLink(member.guild.id, join.trackedLinkId) : null;
  if (link) await grantLinkRoles(member, link);
  const facts = await factsFor(member.guild, join, link?.name ?? null);
  await sendJoinMessage(member, config, facts);
  const status = join.status === "fake" ? ` · counted as fake (${join.fakeReason})` : "";
  await postInviteLog(
    member.client,
    member.guild,
    config,
    "Member joined",
    `<@${member.id}> joined via ${facts.inviterId ? `<@${facts.inviterId}>'s invite` : describeSourceShort(join)}${status}.` +
      (facts.inviterId ? `\nThey now have **${facts.counts.total}** invites.` : ""),
  );
}

function describeSourceShort(join: Pick<InviteJoin, "source" | "code">): string {
  if (join.source === "tracked") return `tracked link \`${join.code}\``;
  if (join.source === "vanity") return "the vanity URL";
  if (join.source === "oauth") return "a bot invite";
  return "an unknown invite";
}

export async function handleMemberAdd(member: GuildMember): Promise<void> {
  const config = await loadActiveInviteTrackerConfig(member.guild.id);
  if (!config) return;
  const guild = member.guild;
  if (!isCached(guild.id)) {
    // First join since the plugin was turned on (or the bot restarted mid-warm): this one can't be
    // attributed, but warming now means the next one can.
    void warmGuild(guild).catch(() => null);
  }

  const join = await joinQueue.run(guild.id, async (behind) => {
    const tracked = activeTrackedCodes(guild.id);
    const attribution = await attribute(guild, member.user.bot, behind, new Set(tracked.keys())).catch(() => UNKNOWN_ATTRIBUTION);
    const link = attribution.code ? tracked.get(attribution.code) ?? null : null;
    const now = Date.now();
    const isRejoin = getLatestJoin(guild.id, member.id) !== null;
    if (isRejoin) closeStaleJoins(guild.id, member.id, new Date(now));
    const inviter = attribution.inviterId ? guild.members.cache.get(attribution.inviterId) : undefined;
    const awaitingVerification =
      config.count_on === "verified" && !member.user.bot && !(await hasMemberPassedPassport(member).catch(() => true));
    const classified = classifyJoin(
      {
        memberId: member.id,
        inviterId: attribution.inviterId,
        isBot: member.user.bot,
        accountCreatedAt: member.user.createdTimestamp,
        joinedAt: now,
        isRejoin,
        inviterRoleIds: inviter ? inviter.roles.cache.keys() : undefined,
        awaitingVerification,
      },
      config,
    );
    return insertJoin({
      guildId: guild.id,
      memberId: member.id,
      inviterId: attribution.inviterId,
      code: attribution.code,
      source: attribution.source,
      trackedLinkId: link?.id ?? null,
      joinedAt: new Date(now),
      status: classified.status,
      fakeReason: classified.fakeReason,
      counted: classified.counted,
      accountCreatedAt: new Date(member.user.createdTimestamp),
    });
  });

  void recordRaidJoin(guild, config, { code: join.code, source: join.source }).catch((error) => {
    log.warn(`Raid check failed in ${guild.id}: ${error instanceof Error ? error.message : error}`);
  });
  // Pending joins wait for Passport: onInviteMemberVerified gives the roles and message then.
  if (join.status !== "pending") await announceJoin(member, config, join);
}

/** Passport hook: a pending join now counts, and gets its held roles and join message. */
export async function onInviteMemberVerified(member: GuildMember): Promise<void> {
  const config = await loadActiveInviteTrackerConfig(member.guild.id);
  if (!config) return;
  const join = await joinQueue.run(member.guild.id, async () => {
    const open = getOpenJoin(member.guild.id, member.id);
    if (!open || open.status !== "pending") return null;
    const next = classifyVerified({ status: "pending", fakeReason: null });
    updateJoin(member.guild.id, open.id, next);
    return { ...open, ...next };
  });
  if (join) await announceJoin(member, config, join);
}

export async function handleMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
  const config = await loadActiveInviteTrackerConfig(member.guild.id);
  if (!config) return;
  const guild = member.guild;
  const join = await joinQueue.run(guild.id, async () => {
    const open = getOpenJoin(guild.id, member.id);
    if (!open) return null;
    const leftAt = Date.now();
    const next = classifyLeave(
      { status: open.status as JoinStatus, fakeReason: open.fakeReason as FakeReason | null, joinedAt: open.joinedAt.getTime() },
      leftAt,
      config,
    );
    updateJoin(guild.id, open.id, { ...next, leftAt: new Date(leftAt) });
    return { ...open, ...next, leftAt: new Date(leftAt) };
  });

  const link = join?.trackedLinkId ? getTrackedLink(guild.id, join.trackedLinkId) : null;
  const facts: InviteMessageFacts = join
    ? await factsFor(guild, join, link?.name ?? null)
    : {
        inviterId: null,
        inviterName: null,
        counts: { ...EMPTY_COUNTS },
        code: null,
        linkName: null,
        source: "unknown",
        joinCount: countMemberJoins(guild.id, member.id),
        accountCreatedAt: member.user.createdTimestamp,
      };
  await sendLeaveMessage(member, config, facts);
  if (join) {
    const status = join.status === "fake" && join.fakeReason === "quick_leave" ? " · counted as fake (quick leave)" : "";
    await postInviteLog(
      member.client,
      guild,
      config,
      "Member left",
      `<@${member.id}> left${facts.inviterId ? `, invited by <@${facts.inviterId}>` : ""}${status}.`,
    );
  }
}

// ── Scheduled ────────────────────────────────────────────────────────────────

/** Pending joins that never verified within the timeout become fake (unverified). */
export async function sweepPendingJoins(): Promise<void> {
  const now = Date.now();
  for (const guildId of listPendingGuilds()) {
    const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
    if (!guildConfig) continue;
    const config = loadInviteTrackerConfig(guildConfig);
    expirePendingJoins(guildId, new Date(now - config.passport.pending_timeout_hours * 3_600_000));
  }
}

/** Folds joins past each guild's retention into daily totals. */
export async function pruneOldJoins(): Promise<void> {
  const now = Date.now();
  let folded = 0;
  for (const guildId of listGuildsWithJoins()) {
    const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
    const retentionDays = guildConfig ? loadInviteTrackerConfig(guildConfig).retention_days : 365;
    folded += foldOldJoins(guildId, new Date(now - retentionDays * 86_400_000));
  }
  if (folded > 0) log.info(`Folded ${folded} old join(s) into daily invite stats.`);
}

/** Guilds whose cache exists but whose plugin has been turned off since (belt and braces for onSave). */
export async function pruneDisabledCaches(): Promise<void> {
  for (const guildId of cachedGuildIds()) {
    const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
    if (!guildConfig || !isInviteTrackerEnabled(guildConfig)) forgetGuild(guildId);
  }
}
