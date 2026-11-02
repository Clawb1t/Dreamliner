import type { Client, Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { performTeamAction } from "../plugins/team_control/functions/actions.js";
import { computeDaily } from "../plugins/team_control/functions/activity.js";
import { checkAuthority, rankIndexById } from "../plugins/team_control/functions/authority.js";
import {
  isTeamControlEnabled,
  loadTeamControlConfig,
  MAX_NOTE,
  TEAM_ACTION_TYPES,
  type LeaveStatus,
  type TeamActionType,
} from "../plugins/team_control/functions/config.js";
import { decideLeave, endLeaveRecord, extendLeaveRecord } from "../plugins/team_control/functions/leave.js";
import { syncGuildTeam } from "../plugins/team_control/functions/members.js";
import { applyOneGate, historyCutoff, isTeamOneActive, teamLimits } from "../plugins/team_control/functions/oneGate.js";
import { periodRange, parseWhich, toTeamPeriod, type TeamPeriod } from "../plugins/team_control/functions/periods.js";
import { summarizeQuotas, type QuotaState, type TeamMetrics } from "../plugins/team_control/functions/quota.js";
import { configWarnings, memberRankIndex, resolveActor, type TeamActor } from "../plugins/team_control/functions/ranks.js";
import { computeStatuses, scheduleRosterUpdate, syncRoster } from "../plugins/team_control/functions/roster.js";
import { shiftDaily } from "../plugins/team_control/functions/activity.js";
import { shiftWorkedSeconds } from "../plugins/team_control/functions/shiftMath.js";
import { endShiftRecord, shiftTypeName } from "../plugins/team_control/functions/shifts.js";
import { checklistProgress } from "../plugins/team_control/functions/onboarding.js";
import {
  countPendingLeave,
  deleteNote,
  getLeave,
  getShift,
  getTeamMember,
  insertNote,
  insertShift,
  listActions,
  listActiveShifts,
  listFeedback,
  listLeaveByStatus,
  listMemberLeave,
  listNotes,
  listShifts,
  setOnboardingItem,
  updateShift,
  type ActionRow,
  type FeedbackRow,
  type LeaveRow,
  type NoteRow,
  type ShiftRow,
} from "../plugins/team_control/functions/store.js";
import { summarizeMember, summarizeTeam, type TeamMemberSummary } from "../plugins/team_control/functions/team.js";
import { trackDashboardAction } from "./dashboardAudit.js";

// Response shapes are the bot ⇄ website contract for the Team Control pages; keep them in step
// with the website's src/lib/botBridge.ts.

export type TeamPerson = { userId: string; name: string; avatarUrl: string | null; inGuild: boolean };
export type TeamMemberRow = {
  user: TeamPerson;
  rankId: string | null;
  rankName: string | null;
  rankIndex: number;
  status: TeamMemberSummary["status"];
  memberStatus: TeamMemberSummary["memberStatus"];
  joinedAt: string;
  trialEndsAt: string | null;
  activeStrikes: number;
  feedbackAvg: number | null;
  metrics: TeamMetrics;
  quota: QuotaState;
};
export type TeamShift = {
  id: number;
  user: TeamPerson;
  typeId: string | null;
  typeName: string | null;
  startedAt: string;
  endedAt: string | null;
  breakSeconds: number;
  onBreak: boolean;
  durationMinutes: number;
  status: "active" | "ended" | "voided";
  endedBy: "self" | "admin" | "auto" | null;
  editedBy: TeamPerson | null;
  note: string | null;
};
export type TeamLeave = {
  id: number;
  user: TeamPerson;
  kind: "loa" | "ra";
  reason: string;
  startsAt: string;
  endsAt: string;
  status: LeaveStatus;
  reviewer: TeamPerson | null;
  reviewReason: string | null;
  createdAt: string;
};
export type TeamAction = {
  id: number;
  user: TeamPerson;
  actor: TeamPerson | null;
  type: TeamActionType;
  fromRank: string | null;
  toRank: string | null;
  reason: string;
  expiresAt: string | null;
  voidedAt: string | null;
  voidedBy: TeamPerson | null;
  voidReason: string | null;
  auto: boolean;
  createdAt: string;
};
export type TeamNote = { id: number; author: TeamPerson | null; body: string; createdAt: string };
export type TeamFeedback = { id: number; staff: TeamPerson; rater: TeamPerson | null; rating: number; comment: string | null; source: "ticket" | "direct"; createdAt: string };

export class TeamBridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type TeamBridgeResponse = { status: number; json: unknown } | { status: number; csv: string; filename: string };

const MAX_USER_FETCHES = 25;
const MAX_SHIFT_HOURS = 48;

/** Names and avatars for a set of user IDs: members first, then cached/fetched users. */
async function resolvePeople(guild: Guild, ids: Iterable<string | null | undefined>): Promise<Map<string, TeamPerson>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const people = new Map<string, TeamPerson>();
  const missing = unique.filter((id) => !guild.members.cache.has(id));
  for (let i = 0; i < missing.length; i += 100) await guild.members.fetch({ user: missing.slice(i, i + 100) }).catch(() => null);
  let fetches = 0;
  for (const id of unique) {
    const member = guild.members.cache.get(id);
    if (member) {
      people.set(id, { userId: id, name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }), inGuild: true });
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

async function loadRuntime(guild: Guild) {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const one = await isTeamOneActive(guild.id);
  return { guildConfig, one, enabled: isTeamControlEnabled(guildConfig), config: applyOneGate(loadTeamControlConfig(guildConfig), one) };
}
type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

function requireEnabled(runtime: Runtime): void {
  if (!runtime.enabled) throw new TeamBridgeError("Team Control is turned off. Turn it on first.", 409);
}

async function actorFor(guild: Guild, runtime: Runtime, userId: string): Promise<TeamActor> {
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  return resolveActor(member, userId, runtime.guildConfig, runtime.config.ranks);
}

/** Rank authority over a member for writes that aren't staff actions (notes, shifts, leave, onboarding). */
async function assertAuthority(guild: Guild, runtime: Runtime, actor: TeamActor, memberId: string): Promise<void> {
  const target = guild.members.cache.get(memberId) ?? (await guild.members.fetch(memberId).catch(() => null));
  const row = getTeamMember(guild.id, memberId);
  const index = Math.max(memberRankIndex(target, runtime.config.ranks), rankIndexById(runtime.config.ranks, row?.rankId), 0);
  const check = checkAuthority(actor, memberId, index, "warning", runtime.config.ranks);
  if (!check.ok) throw new TeamBridgeError(check.error, 403);
}

function rankName(runtime: Runtime, id: string | null): string | null {
  if (!id) return null;
  return runtime.config.ranks.find((rank) => rank.id === id)?.name ?? id;
}

function pageParams(query: URLSearchParams): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.min(10_000, Math.trunc(Number(query.get("page") ?? 1)) || 1));
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(query.get("pageSize") ?? 25)) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseDate(value: unknown, field: string): Date {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new TeamBridgeError(`${field} must be an ISO date.`);
  return date;
}

function stringField(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TeamBridgeError(`${key} must be text.`);
  return value.trim().slice(0, max);
}

// ── Row builders ─────────────────────────────────────────────────────────────

function memberRow(summary: TeamMemberSummary, people: Map<string, TeamPerson>): TeamMemberRow {
  return {
    user: people.get(summary.userId)!,
    rankId: summary.rankId,
    rankName: summary.rankName,
    rankIndex: summary.rankIndex,
    status: summary.status,
    memberStatus: summary.memberStatus,
    joinedAt: summary.joinedAt.toISOString(),
    trialEndsAt: summary.trialEndsAt?.toISOString() ?? null,
    activeStrikes: summary.activeStrikes,
    feedbackAvg: summary.feedbackAvg,
    metrics: summary.metrics,
    quota: summary.quota,
  };
}

async function memberRows(guild: Guild, summaries: TeamMemberSummary[]): Promise<TeamMemberRow[]> {
  const people = await resolvePeople(guild, summaries.map((s) => s.userId));
  return summaries
    .map((s) => memberRow(s, people))
    .sort((a, b) => b.rankIndex - a.rankIndex || a.user.name.localeCompare(b.user.name));
}

async function shiftRows(guild: Guild, runtime: Runtime, shifts: ShiftRow[]): Promise<TeamShift[]> {
  const people = await resolvePeople(guild, shifts.flatMap((s) => [s.userId, s.editedBy]));
  return shifts.map((s) => ({
    id: s.id,
    user: people.get(s.userId)!,
    typeId: s.typeId,
    typeName: shiftTypeName(runtime.config, s.typeId),
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    breakSeconds: s.breakSeconds + (s.breakStartedAt && !s.endedAt ? Math.floor((Date.now() - s.breakStartedAt.getTime()) / 1000) : 0),
    onBreak: s.status === "active" && Boolean(s.breakStartedAt),
    durationMinutes: Math.round(shiftWorkedSeconds(s) / 60),
    status: s.status as TeamShift["status"],
    endedBy: (s.endedBy as TeamShift["endedBy"]) ?? null,
    editedBy: s.editedBy ? people.get(s.editedBy)! : null,
    note: s.note,
  }));
}

async function leaveRows(guild: Guild, rows: LeaveRow[]): Promise<TeamLeave[]> {
  const people = await resolvePeople(guild, rows.flatMap((l) => [l.userId, l.reviewerId]));
  return rows.map((l) => ({
    id: l.id,
    user: people.get(l.userId)!,
    kind: l.kind as TeamLeave["kind"],
    reason: l.reason,
    startsAt: l.startsAt.toISOString(),
    endsAt: (l.endedAt && l.endedAt < l.endsAt ? l.endedAt : l.endsAt).toISOString(),
    status: l.status as LeaveStatus,
    reviewer: l.reviewerId ? people.get(l.reviewerId)! : null,
    reviewReason: l.reviewReason,
    createdAt: l.createdAt.toISOString(),
  }));
}

async function actionRows(guild: Guild, runtime: Runtime, rows: ActionRow[]): Promise<TeamAction[]> {
  const people = await resolvePeople(guild, rows.flatMap((a) => [a.userId, a.actorId, a.voidedBy]));
  return rows.map((a) => ({
    id: a.id,
    user: people.get(a.userId)!,
    actor: a.actorId ? people.get(a.actorId)! : null,
    type: a.type as TeamActionType,
    fromRank: rankName(runtime, a.fromRankId),
    toRank: rankName(runtime, a.toRankId),
    reason: a.reason,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    voidedAt: a.voidedAt?.toISOString() ?? null,
    voidedBy: a.voidedBy ? people.get(a.voidedBy)! : null,
    voidReason: a.voidReason,
    auto: a.auto,
    createdAt: a.createdAt.toISOString(),
  }));
}

async function noteRows(guild: Guild, rows: NoteRow[]): Promise<TeamNote[]> {
  const people = await resolvePeople(guild, rows.map((n) => n.authorId));
  return rows.map((n) => ({ id: n.id, author: people.get(n.authorId) ?? null, body: n.body, createdAt: n.createdAt.toISOString() }));
}

/** Dashboard viewers are managers (Manage Server), so they see who left each rating. */
async function feedbackRows(guild: Guild, rows: FeedbackRow[]): Promise<TeamFeedback[]> {
  const people = await resolvePeople(guild, rows.flatMap((f) => [f.staffId, f.raterId]));
  return rows.map((f) => ({
    id: f.id,
    staff: people.get(f.staffId)!,
    rater: people.get(f.raterId) ?? null,
    rating: f.rating,
    comment: f.comment,
    source: f.source as TeamFeedback["source"],
    createdAt: f.createdAt.toISOString(),
  }));
}

function periodOf(runtime: Runtime, query: URLSearchParams) {
  return periodRange(runtime.config.activity.period, runtime.config.activity.week_start, parseWhich(query.get("period")));
}

function audit(client: Client, guildId: string, userId: string, title: string, summary: string, payload: Record<string, unknown>): void {
  trackDashboardAction(client, guildId, userId, { eventType: "dashboard_config", title, summary, details: [], payload });
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function getOverview(guild: Guild, runtime: Runtime) {
  const range = periodRange(runtime.config.activity.period, runtime.config.activity.week_start);
  const summaries = summarizeTeam(guild.id, runtime.config, range, runtime.one);
  const statuses = computeStatuses(guild.id);
  const count = (s: string) => [...statuses.values()].filter((v) => v === s).length;
  const pending = listLeaveByStatus(guild.id, ["pending"], 25).rows;
  const now = Date.now();
  return {
    ok: true,
    one: runtime.one,
    limits: teamLimits(runtime.one),
    warnings: configWarnings(guild, runtime.config),
    period: toTeamPeriod(range) satisfies TeamPeriod,
    counts: {
      members: summaries.length,
      onDuty: count("on_duty"),
      onBreak: count("on_break"),
      onLeave: count("loa") + count("ra"),
      pendingLeave: countPendingLeave(guild.id),
      suspended: count("suspended"),
      inTrial: summaries.filter((s) => s.trialEndsAt && (s.trialEndsAt.getTime() > now || s.memberStatus === "active")).length,
    },
    onDuty: await shiftRows(guild, runtime, listActiveShifts(guild.id)),
    pendingLeave: await leaveRows(guild, pending),
    recentActions: await actionRows(guild, runtime, listActions(guild.id, {}, 10).rows),
    quota: summarizeQuotas(summaries.map((s) => s.quota)),
  };
}

async function getMemberDetail(guild: Guild, runtime: Runtime, memberId: string, query: URLSearchParams) {
  const range = periodOf(runtime, query);
  const summary = summarizeMember(guild.id, runtime.config, range, runtime.one, memberId);
  if (!summary) throw new TeamBridgeError("That member has never been on the team.", 404);
  const since = historyCutoff(runtime.one);
  const [row] = await memberRows(guild, [summary]);
  const actions = listActions(guild.id, { userId: memberId, since }, 100).rows;
  const onboarding = runtime.config.onboarding.enabled && runtime.config.onboarding.checklist.length > 0 ? checklistProgress(guild.id, memberId, runtime.config) : null;
  const doneBy = onboarding ? await resolvePeople(guild, onboarding.items.map((i) => i.doneBy)) : new Map<string, TeamPerson>();
  return {
    ok: true,
    member: row!,
    rankHistory: await actionRows(
      guild,
      runtime,
      actions.filter((a) => a.type === "promotion" || a.type === "demotion"),
    ),
    shifts: await shiftRows(guild, runtime, listShifts(guild.id, { userId: memberId, since }, 20, 0).rows),
    shiftDaily: shiftDaily(guild.id, memberId, 30),
    leave: await leaveRows(guild, listMemberLeave(guild.id, memberId, since)),
    actions: await actionRows(guild, runtime, actions),
    notes: await noteRows(guild, listNotes(guild.id, memberId)),
    feedback: await feedbackRows(guild, listFeedback(guild.id, memberId, 20, 0, since).rows),
    onboarding: onboarding
      ? {
          items: onboarding.items.map((item) => ({
            id: item.id,
            label: item.label,
            description: item.description,
            doneAt: item.doneAt?.toISOString() ?? null,
            doneBy: item.doneBy ? (doneBy.get(item.doneBy) ?? null) : null,
          })),
          trialEndsAt: summary.trialEndsAt?.toISOString() ?? null,
        }
      : null,
  };
}

async function postManualShift(client: Client, guild: Guild, runtime: Runtime, actor: TeamActor, body: Record<string, unknown>) {
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  if (!getTeamMember(guild.id, memberId)) throw new TeamBridgeError("That member isn't on the team.", 404);
  await assertAuthority(guild, runtime, actor, memberId);
  const startedAt = parseDate(body.startedAt, "startedAt");
  const endedAt = parseDate(body.endedAt, "endedAt");
  const typeId = typeof body.typeId === "string" && body.typeId ? body.typeId : null;
  if (typeId && !runtime.config.shifts.types.some((t) => t.id === typeId)) throw new TeamBridgeError("That shift type doesn't exist.");
  const span = endedAt.getTime() - startedAt.getTime();
  if (span <= 0) throw new TeamBridgeError("The shift has to end after it starts.");
  if (endedAt.getTime() > Date.now() + 60_000) throw new TeamBridgeError("A manual shift can't end in the future.");
  if (span > MAX_SHIFT_HOURS * 3_600_000) throw new TeamBridgeError(`A shift can be at most ${MAX_SHIFT_HOURS} hours.`);
  const breakSeconds = Math.max(0, Math.round(Number(body.breakMinutes ?? 0) * 60) || 0);
  if (breakSeconds * 1000 >= span) throw new TeamBridgeError("Breaks have to be shorter than the shift.");
  const shift = insertShift({
    guildId: guild.id,
    userId: memberId,
    typeId,
    startedAt,
    endedAt,
    breakSeconds,
    status: "ended",
    endedBy: "admin",
    editedBy: actor.userId,
    note: stringField(body, "note", 200) || "Added on the dashboard",
  });
  audit(client, guild.id, actor.userId, "Shift added", `A ${Math.round((span / 1000 - breakSeconds) / 60)}-minute shift was added for ${memberId}.`, { shiftId: shift.id });
  return { ok: true, shift: (await shiftRows(guild, runtime, [shift]))[0]! };
}

async function patchShift(client: Client, guild: Guild, runtime: Runtime, actor: TeamActor, shiftId: number, body: Record<string, unknown>) {
  const shift = getShift(guild.id, shiftId);
  if (!shift) throw new TeamBridgeError("That shift doesn't exist.", 404);
  await assertAuthority(guild, runtime, actor, shift.userId);
  const action = body.action;
  let updated: ShiftRow | null = shift;
  if (action === "end") {
    if (shift.status !== "active") throw new TeamBridgeError("That shift has already ended.");
    updated = (await endShiftRecord(guild, runtime.config, shift, "admin", { editorId: actor.userId })).shift;
  } else if (action === "void") {
    if (shift.status === "voided") throw new TeamBridgeError("That shift is already voided.");
    if (shift.status === "active") await endShiftRecord(guild, runtime.config, shift, "admin", { editorId: actor.userId });
    updated = updateShift(guild.id, shiftId, { status: "voided", editedBy: actor.userId });
  } else if (action === "restore") {
    if (shift.status !== "voided") throw new TeamBridgeError("Only voided shifts can be restored.");
    if (!shift.endedAt) throw new TeamBridgeError("That shift has no end time to restore it with.");
    updated = updateShift(guild.id, shiftId, { status: "ended", editedBy: actor.userId });
  } else if (action !== undefined && action !== null) {
    throw new TeamBridgeError("action must be end, void or restore.");
  }
  const patch: Partial<ShiftRow> = {};
  const current = updated ?? shift;
  if (body.startedAt !== undefined) patch.startedAt = parseDate(body.startedAt, "startedAt");
  if (body.endedAt !== undefined) {
    if (current.status === "active") throw new TeamBridgeError("End the shift before changing its end time.");
    patch.endedAt = parseDate(body.endedAt, "endedAt");
  }
  if (body.breakMinutes !== undefined) patch.breakSeconds = Math.max(0, Math.round(Number(body.breakMinutes) * 60) || 0);
  if (body.note !== undefined) patch.note = stringField(body, "note", 200) || null;
  if (Object.keys(patch).length) {
    const start = (patch.startedAt ?? current.startedAt).getTime();
    const end = (patch.endedAt ?? current.endedAt)?.getTime() ?? Date.now();
    if (end <= start) throw new TeamBridgeError("The shift has to end after it starts.");
    if (end - start > MAX_SHIFT_HOURS * 3_600_000) throw new TeamBridgeError(`A shift can be at most ${MAX_SHIFT_HOURS} hours.`);
    if ((patch.breakSeconds ?? current.breakSeconds) * 1000 >= end - start) throw new TeamBridgeError("Breaks have to be shorter than the shift.");
    updated = updateShift(guild.id, shiftId, { ...patch, editedBy: actor.userId });
  }
  audit(client, guild.id, actor.userId, "Shift edited", `Shift #${shiftId} was ${typeof action === "string" ? `${action === "end" ? "ended" : action === "void" ? "voided" : "restored"}` : "edited"}.`, {
    shiftId,
    action: action ?? null,
  });
  scheduleRosterUpdate(guild.id);
  return { ok: true, shift: (await shiftRows(guild, runtime, [updated ?? shift]))[0]! };
}

async function postLeave(client: Client, guild: Guild, runtime: Runtime, actor: TeamActor, leaveId: number, body: Record<string, unknown>) {
  const leave = getLeave(guild.id, leaveId);
  if (!leave) throw new TeamBridgeError("That leave request doesn't exist.", 404);
  const action = body.action;
  const reason = stringField(body, "reason", 500) || null;
  let result: { ok: true; leave: LeaveRow } | { ok: false; status: number; error: string };
  if (action === "approve" || action === "deny") {
    result = await decideLeave(client, guild, runtime.config, leave, actor.userId, action === "approve", reason);
  } else if (action === "end") {
    await assertAuthority(guild, runtime, actor, leave.userId);
    if (!["pending", "approved", "active"].includes(leave.status)) throw new TeamBridgeError("That leave has already finished.");
    result = { ok: true, leave: await endLeaveRecord(guild, runtime.config, leave, { by: actor.userId }) };
  } else if (action === "extend") {
    await assertAuthority(guild, runtime, actor, leave.userId);
    result = await extendLeaveRecord(guild, runtime.config, leave, Math.trunc(Number(body.days)), actor.userId);
  } else {
    throw new TeamBridgeError("action must be approve, deny, end or extend.");
  }
  if (!result.ok) throw new TeamBridgeError(result.error, result.status);
  audit(client, guild.id, actor.userId, "Leave updated", `Leave #${leaveId} for ${leave.userId}: ${String(action)}.`, { leaveId, action });
  return { ok: true, leave: (await leaveRows(guild, [result.leave]))[0]! };
}

async function postAction(client: Client, guild: Guild, runtime: Runtime, actor: TeamActor, body: Record<string, unknown>) {
  const type = body.type as TeamActionType;
  if (!TEAM_ACTION_TYPES.includes(type)) throw new TeamBridgeError("Unknown action type.");
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  if (!/^\d{17,20}$/.test(memberId)) throw new TeamBridgeError("memberId is required.");
  const result = await performTeamAction({
    guild,
    guildConfig: runtime.guildConfig,
    config: runtime.config,
    actor,
    targetId: memberId,
    type,
    rankId: typeof body.rankId === "string" && body.rankId ? body.rankId : null,
    reason: stringField(body, "reason", 500),
    days: body.days === undefined || body.days === null ? null : Math.trunc(Number(body.days)),
  });
  if (!result.ok) throw new TeamBridgeError(result.error, result.status);
  audit(client, guild.id, actor.userId, "Staff action", `${type} for ${memberId}.`, { actionId: result.action.id, type, memberId });
  return { ok: true, action: (await actionRows(guild, runtime, [result.action]))[0]! };
}

async function postVoid(client: Client, guild: Guild, runtime: Runtime, actor: TeamActor, actionId: number, body: Record<string, unknown>) {
  const { voidTeamAction } = await import("../plugins/team_control/functions/actions.js");
  const result = await voidTeamAction(guild, runtime.config, actor, actionId, stringField(body, "reason", 500));
  if (!result.ok) throw new TeamBridgeError(result.error, result.status);
  audit(client, guild.id, actor.userId, "Staff action voided", `Action #${actionId} was voided.`, { actionId });
  return { ok: true, action: (await actionRows(guild, runtime, [result.action]))[0]! };
}

async function getActivity(guild: Guild, runtime: Runtime, query: URLSearchParams) {
  const range = periodOf(runtime, query);
  const summaries = summarizeTeam(guild.id, runtime.config, range, runtime.one);
  const totals: TeamMetrics = { shiftMinutes: 0, modActions: 0, ticketsClosed: 0, staffMessages: 0, voiceMinutes: 0, points: runtime.config.activity.points_mode ? 0 : null };
  for (const s of summaries) {
    totals.shiftMinutes += s.metrics.shiftMinutes;
    totals.modActions += s.metrics.modActions;
    totals.ticketsClosed += s.metrics.ticketsClosed;
    totals.staffMessages += s.metrics.staffMessages;
    totals.voiceMinutes += s.metrics.voiceMinutes;
    if (totals.points !== null) totals.points = Math.round((totals.points + (s.metrics.points ?? 0)) * 10) / 10;
  }
  return {
    ok: true,
    period: toTeamPeriod(range),
    members: await memberRows(guild, summaries),
    totals,
    daily: computeDaily(guild.id, summaries.map((s) => s.userId), range.start, range.end),
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Leading = + - @ would run as a formula in spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportActivity(guild: Guild, runtime: Runtime, query: URLSearchParams): Promise<TeamBridgeResponse> {
  if (!runtime.one) return { status: 403, json: { error: "Dreamliner One required" } };
  const range = periodOf(runtime, query);
  const rows = await memberRows(guild, summarizeTeam(guild.id, runtime.config, range, true));
  const header = ["user_id", "name", "rank", "status", "shift_minutes", "mod_actions", "tickets_closed", "staff_messages", "voice_minutes", "points", "quota_met", "excused", "progress"];
  const lines = rows.map((r) =>
    [
      r.user.userId,
      r.user.name,
      r.rankName ?? "",
      r.memberStatus,
      r.metrics.shiftMinutes,
      r.metrics.modActions,
      r.metrics.ticketsClosed,
      r.metrics.staffMessages,
      r.metrics.voiceMinutes,
      r.metrics.points ?? "",
      r.quota.met,
      r.quota.excused,
      r.quota.progress,
    ]
      .map(csvCell)
      .join(","),
  );
  return { status: 200, csv: [header.join(","), ...lines].join("\n"), filename: `team-activity-${range.start.toISOString().slice(0, 10)}.csv` };
}

/**
 * Routes `/bridge/guilds/:guildId/team-control/<path>`. The caller has already checked the viewer
 * (`userId`) can manage the server; writes also check rank authority with the viewer as actor.
 */
export async function handleTeamControlBridge(
  client: Client,
  guild: Guild,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
  userId: string,
): Promise<TeamBridgeResponse> {
  const runtime = await loadRuntime(guild);
  const [area, id, sub, subId] = segments;
  const isGet = method === "GET";
  const ok = (json: unknown): TeamBridgeResponse => ({ status: 200, json });
  const since = historyCutoff(runtime.one);

  if (isGet) {
    if (area === "overview" && !id) return ok(await getOverview(guild, runtime));
    if (area === "members" && !id) {
      const range = periodOf(runtime, query);
      return ok({ ok: true, period: toTeamPeriod(range), members: await memberRows(guild, summarizeTeam(guild.id, runtime.config, range, runtime.one)) });
    }
    if (area === "member" && id && !sub) return ok(await getMemberDetail(guild, runtime, id, query));
    if (area === "shifts" && !id) {
      const { page, pageSize, offset } = pageParams(query);
      const status = query.get("status");
      const filterStatus = status === "active" || status === "ended" || status === "voided" ? status : null;
      const result = listShifts(guild.id, { status: filterStatus, userId: query.get("memberId") || null, since }, pageSize, offset);
      return ok({ ok: true, page, pageSize, total: result.total, shifts: await shiftRows(guild, runtime, result.rows) });
    }
    if (area === "leave" && !id) {
      const { page, pageSize, offset } = pageParams(query);
      const status = query.get("status");
      const statuses: LeaveStatus[] =
        status === "active" ? ["approved", "active"] : status === "history" ? ["denied", "ended", "cancelled"] : ["pending"];
      const result = listLeaveByStatus(guild.id, statuses, pageSize, offset, status === "history" ? since : null);
      return ok({ ok: true, page, pageSize, total: result.total, leave: await leaveRows(guild, result.rows) });
    }
    if (area === "actions" && !id) {
      const { page, pageSize, offset } = pageParams(query);
      const type = query.get("type");
      const result = listActions(
        guild.id,
        { type: type && TEAM_ACTION_TYPES.includes(type as TeamActionType) ? type : null, userId: query.get("memberId") || null, since },
        pageSize,
        offset,
      );
      return ok({ ok: true, page, pageSize, total: result.total, actions: await actionRows(guild, runtime, result.rows) });
    }
    if (area === "activity" && !id) return ok(await getActivity(guild, runtime, query));
    if (area === "activity" && id === "export" && !sub) return exportActivity(guild, runtime, query);
    if (area === "feedback" && !id) {
      const { page, pageSize, offset } = pageParams(query);
      const result = listFeedback(guild.id, query.get("memberId") || null, pageSize, offset, since);
      return ok({ ok: true, page, pageSize, total: result.total, average: result.average, feedback: await feedbackRows(guild, result.rows) });
    }
    throw new TeamBridgeError("Not found", 404);
  }

  const actor = await actorFor(guild, runtime, userId);
  if (method === "POST" && area === "member" && id && sub === "notes" && !subId) {
    if (!getTeamMember(guild.id, id)) throw new TeamBridgeError("That member has never been on the team.", 404);
    await assertAuthority(guild, runtime, actor, id);
    const text = stringField(body, "body", MAX_NOTE);
    if (!text) throw new TeamBridgeError("The note is empty.");
    const note = insertNote(guild.id, id, userId, text);
    audit(client, guild.id, userId, "Team note added", `A note was added to ${id}'s profile.`, { memberId: id, noteId: note.id });
    return ok({ ok: true, note: (await noteRows(guild, [note]))[0]! });
  }
  if (method === "DELETE" && area === "member" && id && sub === "notes" && subId) {
    if (!deleteNote(guild.id, id, Number(subId))) throw new TeamBridgeError("That note doesn't exist.", 404);
    audit(client, guild.id, userId, "Team note deleted", `A note was deleted from ${id}'s profile.`, { memberId: id, noteId: Number(subId) });
    return ok({ ok: true });
  }
  if (method === "POST" && area === "member" && id && sub === "onboarding" && !subId) {
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    if (!runtime.config.onboarding.checklist.some((item) => item.id === itemId)) throw new TeamBridgeError("That checklist item doesn't exist.", 404);
    if (!getTeamMember(guild.id, id)) throw new TeamBridgeError("That member has never been on the team.", 404);
    await assertAuthority(guild, runtime, actor, id);
    setOnboardingItem(guild.id, id, itemId, body.done !== false, userId);
    audit(client, guild.id, userId, "Onboarding updated", `Checklist item ${itemId} for ${id} was ${body.done !== false ? "ticked" : "unticked"}.`, { memberId: id, itemId });
    return ok({ ok: true });
  }

  requireEnabled(runtime);
  if (method === "POST" && area === "shifts" && !id) return ok(await postManualShift(client, guild, runtime, actor, body));
  if (method === "PATCH" && area === "shifts" && id && !sub) return ok(await patchShift(client, guild, runtime, actor, Number(id), body));
  if (method === "POST" && area === "leave" && id && !sub) return ok(await postLeave(client, guild, runtime, actor, Number(id), body));
  if (method === "POST" && area === "actions" && !id) return ok(await postAction(client, guild, runtime, actor, body));
  if (method === "POST" && area === "actions" && id && sub === "void" && !subId) return ok(await postVoid(client, guild, runtime, actor, Number(id), body));
  if (method === "POST" && area === "roster" && id === "refresh" && !sub) {
    if (!runtime.config.roster.enabled || !runtime.config.roster.channel_id) throw new TeamBridgeError("Turn the roster on and pick its channel first.");
    const posted = await syncRoster(client, guild, runtime.config, true);
    if (!posted) throw new TeamBridgeError("I couldn't post in the roster channel. Check I can see it and send messages there.");
    audit(client, guild.id, userId, "Roster refreshed", "The Team Control roster was re-posted.", {});
    return ok({ ok: true });
  }
  if (method === "POST" && area === "sync" && !id) {
    const members = await syncGuildTeam(guild, runtime.config, true);
    audit(client, guild.id, userId, "Team synced", `Team Control synced ${members} members.`, { members });
    return ok({ ok: true, members });
  }
  throw new TeamBridgeError("Not found", 404);
}
