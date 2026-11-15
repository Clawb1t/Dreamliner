import type { Client, Guild } from "discord.js";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { configManager } from "../config/manager.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { getLogger } from "../core/logger.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getDb } from "../db/client.js";
import { appeals, caseEvidenceFiles, evidenceMessages, modCases } from "../db/schema.js";
import { fetchUserCached } from "./people.js";
import { buildIdentityCard, currentGuildMember, type IdentityCardPayload } from "./webMemberIdentity.js";

const log = getLogger("member-hub");

/**
 * Member 360 (phase 1): everything this one server knows about one member, for staff only. The
 * bridge route checks Manage Server before calling this. Moderation data here never goes to the
 * public identity card, which any member of the server can open.
 */

const CASE_LIMIT = 100;
const TICKET_LIMIT = 25;
const APPEAL_LIMIT = 25;
const NAME_LIMIT = 25;

export type MemberHubCase = {
  id: number;
  type: string;
  reason: string | null;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
  modId: string;
  overturned: boolean;
  evidence: number;
};

export type MemberHubPayload = {
  ok: true;
  guild: { id: string; name: string };
  user: {
    id: string;
    username: string;
    globalName: string | null;
    displayName: string;
    avatarUrl: string | null;
    bot: boolean;
    inServer: boolean;
    joinedAt: string | null;
    accountCreatedAt: string;
  };
  identity: IdentityCardPayload["saved"];
  cases: {
    total: number;
    active: number;
    overturned: number;
    notes: number;
    evidence: number;
    recent: MemberHubCase[];
  };
  tickets: {
    enabled: boolean;
    total: number;
    open: number;
    recent: Array<{ id: number; number: number; status: string; createdAt: string; closedAt: string | null; closeReason: string | null }>;
  };
  appeals: {
    enabled: boolean;
    recent: Array<{ id: number; status: string; caseId: number | null; infractionType: string | null; reversed: boolean; createdAt: string; decidedAt: string | null }>;
  };
  passport: { enabled: boolean; state: "verified" | "pending" | "unverified" | "off"; verifiedAt: string | null };
  names: Array<{ id: number; oldName: string; newName: string; changeType: string; changedAt: string }>;
  inviter: {
    enabled: boolean;
    invitedBy: { userId: string; name: string; avatarUrl: string | null } | null;
    code: string | null;
    source: string | null;
    joinedAt: string | null;
    /** Invites this member made (Invite Tracker counts). */
    invites: { total: number; regular: number; left: number; fake: number; bonus: number } | null;
  };
  team: { enabled: boolean; onTeam: boolean; rankName: string | null; status: string | null; joinedAt: string | null; trialEndsAt: string | null } | null;
  activity: {
    enabled: boolean;
    messages: number;
    voiceSeconds: number;
    reached: number;
    total: number;
    next: { label: string; current: number; threshold: number } | null;
  };
  watchdog: { score: number; tier: string; reasons: Array<{ label: string; points: number }> } | null;
};

/** Runs one part of the hub; a failing source is logged and left empty rather than failing the page. */
async function part<T>(name: string, fallback: T, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log.warn(`Member hub: ${name} failed:`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Case types that undo another case, or are only staff notes: not counted as infractions. */
const NON_INFRACTION_TYPES = new Set(["note", "unmute", "unban"]);

function readCases(guildId: string, userId: string): MemberHubPayload["cases"] {
  const db = getDb();
  const rows = db
    .select({
      id: modCases.id,
      type: modCases.type,
      reason: modCases.reason,
      active: modCases.active,
      createdAt: modCases.createdAt,
      expiresAt: modCases.expiresAt,
      modId: modCases.modId,
    })
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.userId, userId)))
    .orderBy(desc(modCases.createdAt))
    .all();
  const ids = rows.map((r) => r.id);
  const overturned = new Set<number>();
  const evidenceByCase = new Map<number, number>();
  let manualEvidence = 0;
  // Batched: one query per source over every case id, never one per case.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .select({ caseId: appeals.caseId })
      .from(appeals)
      .where(and(eq(appeals.guildId, guildId), eq(appeals.reversed, true), inArray(appeals.caseId, chunk)))
      .all()) {
      if (r.caseId != null) overturned.add(r.caseId);
    }
    for (const r of db
      .select({ caseId: caseEvidenceFiles.caseId, n: count() })
      .from(caseEvidenceFiles)
      .where(and(eq(caseEvidenceFiles.guildId, guildId), inArray(caseEvidenceFiles.caseId, chunk)))
      .groupBy(caseEvidenceFiles.caseId)
      .all()) {
      evidenceByCase.set(r.caseId, (evidenceByCase.get(r.caseId) ?? 0) + r.n);
    }
  }
  // Message snapshots: one capture (a /warn, /ban or /evidence add) counts once.
  const captures = db
    .selectDistinct({ captureId: evidenceMessages.captureId, caseId: evidenceMessages.caseId })
    .from(evidenceMessages)
    .where(and(eq(evidenceMessages.guildId, guildId), eq(evidenceMessages.userId, userId)))
    .all();
  for (const c of captures) {
    if (c.caseId != null) evidenceByCase.set(c.caseId, (evidenceByCase.get(c.caseId) ?? 0) + 1);
    else manualEvidence += 1;
  }

  const infractions = rows.filter((r) => !NON_INFRACTION_TYPES.has(r.type));
  const counted = infractions.filter((r) => !overturned.has(r.id));
  let evidence = manualEvidence;
  for (const n of evidenceByCase.values()) evidence += n;
  return {
    total: counted.length,
    active: counted.filter((r) => r.active).length,
    overturned: infractions.length - counted.length,
    notes: rows.filter((r) => r.type === "note").length,
    evidence,
    recent: rows.slice(0, CASE_LIMIT).map((r) => ({
      id: r.id,
      type: r.type,
      reason: r.reason ? r.reason.slice(0, 300) : null,
      active: Boolean(r.active),
      createdAt: r.createdAt.toISOString(),
      expiresAt: iso(r.expiresAt),
      modId: r.modId,
      overturned: overturned.has(r.id),
      evidence: evidenceByCase.get(r.id) ?? 0,
    })),
  };
}

async function readTickets(guildConfig: GuildConfig, guildId: string, userId: string): Promise<MemberHubPayload["tickets"]> {
  const enabled = pluginEnabled(guildConfig, "tickets");
  const { queryTickets } = await import("../plugins/tickets/functions/tickets.js");
  const [{ tickets, total }, open] = await Promise.all([
    queryTickets(guildId, { openerId: userId, limit: TICKET_LIMIT }),
    queryTickets(guildId, { openerId: userId, status: "open", limit: 1 }),
  ]);
  return {
    enabled,
    total,
    open: open.total,
    recent: tickets.map((t) => ({
      id: t.id,
      number: t.number,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      closedAt: iso(t.closedAt),
      closeReason: t.closeReason ? t.closeReason.slice(0, 200) : null,
    })),
  };
}

function readAppeals(guildConfig: GuildConfig, guildId: string, userId: string): MemberHubPayload["appeals"] {
  const rows = getDb()
    .select({
      id: appeals.id,
      status: appeals.status,
      caseId: appeals.caseId,
      infractionType: appeals.infractionType,
      reversed: appeals.reversed,
      createdAt: appeals.createdAt,
      decidedAt: appeals.decidedAt,
    })
    .from(appeals)
    .where(and(eq(appeals.guildId, guildId), eq(appeals.userId, userId)))
    .orderBy(desc(appeals.id))
    .limit(APPEAL_LIMIT)
    .all();
  return {
    enabled: pluginEnabled(guildConfig, "appeals"),
    recent: rows.map((r) => ({
      id: r.id,
      status: r.status,
      caseId: r.caseId ?? null,
      infractionType: r.infractionType ?? null,
      reversed: Boolean(r.reversed),
      createdAt: r.createdAt.toISOString(),
      decidedAt: iso(r.decidedAt),
    })),
  };
}

async function readPassport(guildConfig: GuildConfig, guildId: string, userId: string): Promise<MemberHubPayload["passport"]> {
  // Passport is opt-in (off by default), so only an explicit enable counts.
  if (guildConfig.plugins.passport?.enabled !== true) return { enabled: false, state: "off", verifiedAt: null };
  const store = await import("../plugins/passport/functions/store.js");
  const verified = await store.getPassportVerification(guildId, userId);
  if (verified) return { enabled: true, state: "verified", verifiedAt: verified.verifiedAt.toISOString() };
  const pending = await store.getPassportPending(guildId, userId);
  return { enabled: true, state: pending ? "pending" : "unverified", verifiedAt: null };
}

async function readNames(guildId: string, userId: string): Promise<MemberHubPayload["names"]> {
  const { getUserNameHistory } = await import("../plugins/name_history/functions/store.js");
  const entries = await getUserNameHistory(guildId, userId, NAME_LIMIT);
  return entries.map((e) => ({
    id: e.id,
    oldName: e.oldName,
    newName: e.newName,
    changeType: e.changeType,
    changedAt: e.changedAt.toISOString(),
  }));
}

async function readInviter(guild: Guild, guildConfig: GuildConfig, userId: string): Promise<MemberHubPayload["inviter"]> {
  const enabled = pluginEnabled(guildConfig, "invite_tracker");
  const empty: MemberHubPayload["inviter"] = { enabled, invitedBy: null, code: null, source: null, joinedAt: null, invites: null };
  const { getInviteTrackerMember } = await import("./webInviteTracker.js");
  const data = await getInviteTrackerMember(guild, userId);
  const join = data.invitedBy;
  const counts = data.counts;
  return {
    ...empty,
    invitedBy: join?.inviter ? { userId: join.inviter.userId, name: join.inviter.name, avatarUrl: join.inviter.avatarUrl } : null,
    code: join?.code ?? null,
    source: join?.source ?? null,
    joinedAt: join?.joinedAt ?? null,
    invites: counts
      ? {
          total: counts.total ?? 0,
          regular: counts.regular ?? 0,
          left: counts.left ?? 0,
          fake: counts.fake ?? 0,
          bonus: counts.bonus ?? 0,
        }
      : null,
  };
}

async function readTeam(guildConfig: GuildConfig, guildId: string, userId: string): Promise<MemberHubPayload["team"]> {
  const config = await import("../plugins/team_control/functions/config.js");
  if (!config.isTeamControlEnabled(guildConfig)) return null;
  const { getTeamMember } = await import("../plugins/team_control/functions/store.js");
  const record = getTeamMember(guildId, userId);
  if (!record) return { enabled: true, onTeam: false, rankName: null, status: null, joinedAt: null, trialEndsAt: null };
  const ranks = config.loadTeamControlConfig(guildConfig).ranks;
  return {
    enabled: true,
    onTeam: !record.leftTeamAt && record.status !== "terminated",
    rankName: ranks.find((r) => r.id === record.rankId)?.name ?? null,
    status: record.leftTeamAt ? "left" : record.status,
    joinedAt: iso(record.joinedAt),
    trialEndsAt: iso(record.trialEndsAt),
  };
}

async function readActivity(guildConfig: GuildConfig, guildId: string, userId: string): Promise<MemberHubPayload["activity"]> {
  const cfg = await import("../plugins/activity_rewards/functions/config.js");
  const store = await import("../plugins/activity_rewards/functions/store.js");
  const enabled = pluginEnabled(guildConfig, cfg.PLUGIN);
  const progress = store.getProgress(guildId, userId);
  const milestones = enabled ? cfg.activeMilestones(cfg.loadActivityRewardsConfig(guildConfig)) : [];
  const reached = milestones.filter((m) => cfg.hasReached(progress, m)).length;
  const upcoming = milestones
    .filter((m) => !cfg.hasReached(progress, m))
    .map((m) => ({ m, left: m.threshold - cfg.metricValue(progress, m.metric) }))
    .sort((a, b) => a.left / a.m.threshold - b.left / b.m.threshold)[0];
  return {
    enabled,
    messages: progress.messages,
    voiceSeconds: progress.voiceSeconds,
    reached,
    total: milestones.length,
    next: upcoming
      ? { label: cfg.milestoneLabel(upcoming.m), current: cfg.metricValue(progress, upcoming.m.metric), threshold: upcoming.m.threshold }
      : null,
  };
}

export async function buildMemberHub(client: Client, guild: Guild, userId: string, viewerId: string): Promise<MemberHubPayload | null> {
  const [user, member, guildConfig] = await Promise.all([
    fetchUserCached(client, userId),
    currentGuildMember(guild, userId),
    configManager.getEffectiveConfig(guild.id),
  ]);
  if (!user) return null;

  const emptyCases: MemberHubPayload["cases"] = { total: 0, active: 0, overturned: 0, notes: 0, evidence: 0, recent: [] };
  const [identity, cases, tickets, appealRows, passport, names, inviter, team, activity, watchdog] = await Promise.all([
    part("identity", null as IdentityCardPayload | null, () => buildIdentityCard(client, guild, userId, viewerId)),
    part("cases", emptyCases, () => readCases(guild.id, userId)),
    part("tickets", { enabled: pluginEnabled(guildConfig, "tickets"), total: 0, open: 0, recent: [] }, () =>
      readTickets(guildConfig, guild.id, userId),
    ),
    part("appeals", { enabled: false, recent: [] }, () => readAppeals(guildConfig, guild.id, userId)),
    part("passport", { enabled: false, state: "off" as const, verifiedAt: null }, () => readPassport(guildConfig, guild.id, userId)),
    part("names", [], () => readNames(guild.id, userId)),
    part(
      "inviter",
      { enabled: pluginEnabled(guildConfig, "invite_tracker"), invitedBy: null, code: null, source: null, joinedAt: null, invites: null },
      () => readInviter(guild, guildConfig, userId),
    ),
    part("team", null, () => readTeam(guildConfig, guild.id, userId)),
    part("activity", { enabled: false, messages: 0, voiceSeconds: 0, reached: 0, total: 0, next: null }, () =>
      readActivity(guildConfig, guild.id, userId),
    ),
    part("watchdog", null as MemberHubPayload["watchdog"], async () => {
      if (!member || user.bot) return null;
      const { scoreWatchdogMember } = await import("./watchdogScoring.js");
      const scored = await scoreWatchdogMember(member);
      return {
        score: scored.score,
        tier: scored.tier,
        reasons: scored.reasons.filter((r) => r.points !== 0).map((r) => ({ label: r.label, points: r.points })),
      };
    }),
  ]);

  return {
    ok: true,
    guild: { id: guild.id, name: guild.name },
    user: {
      id: user.id,
      username: user.username,
      globalName: user.globalName ?? null,
      displayName: member?.displayName ?? user.globalName ?? user.username,
      avatarUrl: (member ?? user).displayAvatarURL({ size: 128 }) ?? null,
      bot: user.bot,
      inServer: Boolean(member),
      joinedAt: iso(member?.joinedAt),
      accountCreatedAt: user.createdAt.toISOString(),
    },
    identity: identity?.saved ?? null,
    cases,
    tickets,
    appeals: appealRows,
    passport,
    names,
    inviter,
    team,
    activity,
    watchdog,
  };
}
