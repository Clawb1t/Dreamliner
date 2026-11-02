import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { zWelcomeRichMessage } from "../config/schemas/welcome.js";
import { ANALYTICS_RANGES, buildAnalytics, recentJoinTotals, type AnalyticsRange } from "../plugins/invite_tracker/functions/analytics.js";
import { cachedInviteCodes, getCacheState, isCached, warmGuild } from "../plugins/invite_tracker/functions/cache.js";
import { MAX_TRACKED_LINKS, type FakeReason, type InviteCounts, type JoinSource, type JoinStatus } from "../plugins/invite_tracker/functions/config.js";
import { sampleInviteVars, type InviteMessageKind } from "../plugins/invite_tracker/functions/messages.js";
import { clampPauseMinutes } from "../plugins/invite_tracker/functions/raid.js";
import { invitesPausedUntil, pauseInvites, resumeInvites } from "../plugins/invite_tracker/functions/raidActions.js";
import {
  addBonus,
  getCounts,
  getGuildCounts,
  getLatestJoin,
  getTrackedLinksById,
  guildTotals,
  listInvitedBy,
  listMemberJoins,
  listTrackedLinks,
  parseRoleIds,
  resetGuildCounts,
  resetMemberCounts,
  trackedLinkStats,
  type InviteJoin,
  type TrackedLinkRow,
} from "../plugins/invite_tracker/functions/store.js";
import { createTrackedLink, deleteTrackedLink, isLinkActive, trackedLinkUrl } from "../plugins/invite_tracker/functions/trackedLinks.js";
import { buildWelcomePreview } from "./webWelcome.js";

// Response shapes are the bot ⇄ website contract for the Invite Tracker pages; keep them in step
// with the website's src/lib/botBridge.ts.

export type InvitePerson = { userId: string; name: string; avatarUrl: string | null; inGuild: boolean };

export type InviteJoinRow = {
  id: number;
  member: InvitePerson;
  inviter: InvitePerson | null;
  code: string | null;
  source: JoinSource;
  trackedLinkId: number | null;
  trackedLinkName: string | null;
  joinedAt: string;
  leftAt: string | null;
  status: JoinStatus;
  fakeReason: FakeReason | null;
};

export type TrackedLink = {
  id: number;
  code: string;
  url: string;
  name: string;
  channelId: string;
  roleIds: string[];
  maxUses: number;
  maxAgeSeconds: number;
  createdBy: InvitePerson | null;
  createdAt: string;
  active: boolean;
  joins: number;
  stayed: number;
  left: number;
  fake: number;
};

export class InviteBridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Users the bridge will look up over REST per request when they aren't in the server or cached. */
const MAX_USER_FETCHES = 25;

/** Names and avatars for a set of user IDs: members first, then cached/fetched users. */
async function resolvePeople(guild: Guild, ids: Iterable<string | null | undefined>): Promise<Map<string, InvitePerson>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const people = new Map<string, InvitePerson>();
  if (unique.length === 0) return people;

  const missing = unique.filter((id) => !guild.members.cache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    await guild.members.fetch({ user: missing.slice(i, i + 100) }).catch(() => null);
  }

  let fetches = 0;
  for (const id of unique) {
    const member = guild.members.cache.get(id);
    if (member) {
      people.set(id, {
        userId: id,
        name: member.displayName,
        avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }),
        inGuild: true,
      });
      continue;
    }
    let user = guild.client.users.cache.get(id) ?? null;
    if (!user && fetches < MAX_USER_FETCHES) {
      fetches += 1;
      user = await guild.client.users.fetch(id).catch(() => null);
    }
    people.set(id, {
      userId: id,
      name: user?.displayName ?? user?.username ?? `Unknown user (${id.slice(-4)})`,
      avatarUrl: user?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
      inGuild: false,
    });
  }
  return people;
}

async function toJoinRows(guild: Guild, joins: InviteJoin[]): Promise<InviteJoinRow[]> {
  const people = await resolvePeople(guild, joins.flatMap((join) => [join.memberId, join.inviterId]));
  const links = getTrackedLinksById(
    guild.id,
    [...new Set(joins.map((join) => join.trackedLinkId).filter((id): id is number => id !== null))],
  );
  return joins.map((join) => ({
    id: join.id,
    member: people.get(join.memberId)!,
    inviter: join.inviterId ? people.get(join.inviterId)! : null,
    code: join.code,
    source: join.source as JoinSource,
    trackedLinkId: join.trackedLinkId,
    trackedLinkName: join.trackedLinkId ? links.get(join.trackedLinkId)?.name ?? null : null,
    joinedAt: join.joinedAt.toISOString(),
    leftAt: join.leftAt?.toISOString() ?? null,
    status: join.status as JoinStatus,
    fakeReason: (join.fakeReason as FakeReason | null) ?? null,
  }));
}

function missingPermissions(guild: Guild): string[] {
  const me = guild.members.me;
  const missing: string[] = [];
  if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) missing.push("Manage Server");
  const needsRoles = listTrackedLinks(guild.id).some((link) => parseRoleIds(link.roleIds).length > 0);
  if (needsRoles && !me?.permissions.has(PermissionFlagsBits.ManageRoles)) missing.push("Manage Roles");
  return missing;
}

export async function getInviteTrackerStatus(guild: Guild) {
  // A guild that just turned the plugin on may not be warm yet; warming here makes the first
  // dashboard visit show the real permission state instead of "cold".
  if (!isCached(guild.id)) await warmGuild(guild).catch(() => null);
  const cache = getCacheState(guild.id);
  const paused = invitesPausedUntil(guild);
  return {
    ok: true as const,
    permOk: guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false,
    missingPermissions: missingPermissions(guild),
    cacheWarm: cache.warm,
    invitesPausedUntil: paused?.toISOString() ?? null,
    vanityCode: cache.vanityCode,
    linkCount: listTrackedLinks(guild.id).length,
    linkLimit: MAX_TRACKED_LINKS,
    totals: { ...guildTotals(guild.id), ...recentJoinTotals(guild.id) },
  };
}

export async function getInviteTrackerLeaderboard(guild: Guild, page: number, pageSize: number) {
  const size = Math.min(100, Math.max(1, Math.floor(pageSize) || 25));
  const { rows } = getGuildCounts(guild.id);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  const slice = rows.slice((current - 1) * size, current * size);
  const people = await resolvePeople(guild, slice.map((row) => row.userId));
  return {
    ok: true as const,
    page: current,
    pageSize: size,
    total: rows.length,
    rows: slice.map((row, i) => {
      const { userId, ...counts } = row;
      return { rank: (current - 1) * size + i + 1, user: people.get(userId)!, counts: counts satisfies InviteCounts };
    }),
  };
}

export async function getInviteTrackerMember(guild: Guild, memberId: string) {
  if (!/^\d{17,20}$/.test(memberId)) throw new InviteBridgeError("Invalid member ID.");
  const latest = getLatestJoin(guild.id, memberId);
  const joins = listMemberJoins(guild.id, memberId, 20);
  const invited = listInvitedBy(guild.id, memberId, 100);
  const people = await resolvePeople(guild, [memberId]);
  const [joinRows, invitedRows] = await Promise.all([toJoinRows(guild, joins), toJoinRows(guild, invited.rows)]);
  return {
    ok: true as const,
    user: people.get(memberId)!,
    counts: getCounts(guild.id, memberId),
    invitedBy: latest ? (joinRows.find((row) => row.id === latest.id) ?? (await toJoinRows(guild, [latest]))[0]!) : null,
    joins: joinRows,
    invited: invitedRows,
    invitedTotal: invited.total,
  };
}

export function postInviteTrackerBonus(guild: Guild, body: { memberId?: unknown; amount?: unknown }) {
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  if (!/^\d{17,20}$/.test(memberId)) throw new InviteBridgeError("memberId is required.");
  const amount = typeof body.amount === "number" ? Math.trunc(body.amount) : NaN;
  if (!Number.isFinite(amount) || amount === 0 || amount < -10_000 || amount > 10_000) {
    throw new InviteBridgeError("amount must be a non-zero number between -10000 and 10000.");
  }
  addBonus(guild.id, memberId, amount);
  return { ok: true as const, counts: getCounts(guild.id, memberId) };
}

export function postInviteTrackerReset(guild: Guild, body: { scope?: unknown; memberId?: unknown }) {
  if (body.scope === "all") {
    resetGuildCounts(guild.id);
    return { ok: true as const };
  }
  if (body.scope !== "member") throw new InviteBridgeError('scope must be "member" or "all".');
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  if (!/^\d{17,20}$/.test(memberId)) throw new InviteBridgeError("memberId is required.");
  resetMemberCounts(guild.id, memberId);
  return { ok: true as const };
}

async function toTrackedLinks(guild: Guild, links: TrackedLinkRow[]): Promise<TrackedLink[]> {
  const stats = trackedLinkStats(guild.id);
  const people = await resolvePeople(guild, links.map((link) => link.createdBy));
  const live = cachedInviteCodes(guild.id);
  return links.map((link) => {
    const s = stats.get(link.id) ?? { joins: 0, stayed: 0, left: 0, fake: 0 };
    return {
      id: link.id,
      code: link.code,
      url: trackedLinkUrl(link.code),
      name: link.name,
      channelId: link.channelId,
      roleIds: parseRoleIds(link.roleIds),
      maxUses: link.maxUses,
      maxAgeSeconds: link.maxAge,
      createdBy: link.createdBy ? people.get(link.createdBy) ?? null : null,
      createdAt: link.createdAt.toISOString(),
      active: isLinkActive(guild, link, live),
      ...s,
    };
  });
}

export async function listInviteTrackerLinks(guild: Guild) {
  return { ok: true as const, links: await toTrackedLinks(guild, listTrackedLinks(guild.id)), limit: MAX_TRACKED_LINKS };
}

export async function createInviteTrackerLink(
  guild: Guild,
  userId: string,
  body: { name?: unknown; channelId?: unknown; roleIds?: unknown; maxUses?: unknown; maxAgeSeconds?: unknown },
) {
  const roleIds = Array.isArray(body.roleIds) ? body.roleIds.filter((id): id is string => typeof id === "string") : [];
  const result = await createTrackedLink(guild, {
    name: typeof body.name === "string" ? body.name : "",
    channelId: typeof body.channelId === "string" ? body.channelId : "",
    roleIds,
    maxUses: typeof body.maxUses === "number" ? body.maxUses : 0,
    maxAgeSeconds: typeof body.maxAgeSeconds === "number" ? body.maxAgeSeconds : 0,
    createdBy: userId,
  });
  if (!result.ok) throw new InviteBridgeError(result.error);
  return { ok: true as const, link: (await toTrackedLinks(guild, [result.link]))[0]! };
}

export async function deleteInviteTrackerLink(guild: Guild, linkId: number) {
  const result = await deleteTrackedLink(guild, linkId);
  if (!result.ok) throw new InviteBridgeError(result.error, 404);
  return { ok: true as const };
}

export async function getInviteTrackerAnalytics(guild: Guild, rawRange: string | null) {
  const range: AnalyticsRange = rawRange && rawRange in ANALYTICS_RANGES ? (rawRange as AnalyticsRange) : "30d";
  const analytics = buildAnalytics(guild.id, range);
  const people = await resolvePeople(guild, analytics.topInviters.map((row) => row.userId));
  return {
    ok: true as const,
    ...analytics,
    topInviters: analytics.topInviters.map(({ userId, ...counts }) => ({ user: people.get(userId)!, counts })),
  };
}

export async function postInviteTrackerRaid(guild: Guild, body: { action?: unknown; minutes?: unknown }) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new InviteBridgeError("Dreamliner needs Manage Server to pause invites.");
  }
  if (body.action === "pause") {
    const minutes = typeof body.minutes === "number" ? body.minutes : 60;
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 1440) throw new InviteBridgeError("minutes must be 15 to 1440.");
    const until = await pauseInvites(guild, clampPauseMinutes(minutes));
    return { ok: true as const, invitesPausedUntil: until.toISOString() };
  }
  if (body.action === "resume") {
    await resumeInvites(guild);
    return { ok: true as const, invitesPausedUntil: null };
  }
  throw new InviteBridgeError('action must be "pause" or "resume".');
}

/** Renders a join/leave/unknown message draft with sample inviter vars (same shape as the Activity Rewards preview). */
export async function previewInviteTrackerMessage(
  client: Client,
  guild: Guild,
  userId: string,
  body: { kind?: unknown; message?: unknown },
) {
  const kind: InviteMessageKind = body.kind === "leave" || body.kind === "unknown" ? body.kind : "join";
  const parsed = zWelcomeRichMessage.safeParse(body.message ?? {});
  if (!parsed.success) throw new InviteBridgeError(parsed.error.issues[0]?.message ?? "Invalid message.");
  const viewer = await guild.members.fetch(userId).catch(() => null);
  return buildWelcomePreview(client, guild, {
    content: parsed.data.content,
    embed: parsed.data.embed,
    card: parsed.data.card,
    sampleUserId: userId,
    extra: sampleInviteVars(kind, viewer?.displayName ?? "Dreamliner"),
  });
}
