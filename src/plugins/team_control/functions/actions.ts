import type { Client, Guild, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { checkAuthority, rankIndexById, resolveRankMove } from "./authority.js";
import { ACTION_LABELS, channelOr, DAY_MS, MAX_REASON, unix, type TeamActionType } from "./config.js";
import { endLeaveRecord } from "./leave.js";
import { onJoinTeam } from "./onboarding.js";
import { dmTeamCard, postTeamMessage, teamCard } from "./messages.js";
import { heldRankRoleIds, memberRankIndex, rankRolesProblem, rankRoleIds, usableStatusRole, type TeamActor } from "./ranks.js";
import { scheduleRosterUpdate } from "./roster.js";
import { endShiftRecord } from "./shifts.js";
import { countActiveStrikes, crossedThreshold, strikeExpiry } from "./strikes.js";
import {
  getActiveShift,
  getAction,
  getOpenLeave,
  getTeamMember,
  insertAction,
  parseRoleIds,
  strikeRows,
  upsertTeamMember,
  voidAction,
  type ActionRow,
  type TeamMemberRecord,
} from "./store.js";

const log = getLogger("team_control");
const REASON_PREFIX = "Dreamliner Team Control";

export type ActionRequest = {
  guild: Guild;
  guildConfig: GuildConfig;
  config: TeamControlConfig;
  /** Null when Dreamliner acts on its own (strike thresholds, failed trials). */
  actor: TeamActor | null;
  targetId: string;
  type: TeamActionType;
  rankId?: string | null;
  reason: string;
  /** Suspension length. */
  days?: number | null;
  auto?: boolean;
};

export type ActionResult = { ok: true; action: ActionRow; notes: string[] } | { ok: false; status: number; error: string };

const fail = (error: string, status = 400): ActionResult => ({ ok: false, status, error });

/** The rank a member is at for actions: their roles, or what was stored when roles were taken by a suspension. */
function targetRankIndex(config: TeamControlConfig, member: GuildMember | null, row: TeamMemberRecord | null): number {
  const fromRoles = memberRankIndex(member, config.ranks);
  if (fromRoles >= 0) return fromRoles;
  if (row && row.status === "suspended") return rankIndexById(config.ranks, row.rankId);
  return -1;
}

/**
 * Takes a staff action: checks authority and role hierarchy, changes roles, records it, DMs the
 * member, logs and announces it, and (for strikes) applies any threshold that was crossed.
 */
export async function performTeamAction(req: ActionRequest): Promise<ActionResult> {
  const { guild, config, actor, type } = req;
  const startedAt = Date.now();
  if (!config.actions.enabled) return fail("Staff actions are turned off on this server.");
  const reason = req.reason.trim().slice(0, MAX_REASON);
  if (config.actions.require_reason && !reason && !req.auto) return fail("Please give a reason.");
  const target = await guild.members.fetch(req.targetId).catch(() => null);
  if (target?.user.bot) return fail("Bots can't be on the team.");
  const row = getTeamMember(guild.id, req.targetId);
  const currentIndex = targetRankIndex(config, target, row);
  const needsMember = type === "promotion" || type === "demotion" || type === "suspension";
  if (needsMember && !target) return fail("They aren't in this server.");
  if (type !== "promotion" && currentIndex < 0 && row?.status !== "suspended") return fail("They aren't on the team.");
  if (type === "suspension" && row?.status === "suspended") return fail("They're already suspended.");

  let toIndex: number | undefined;
  if (type === "promotion" || type === "demotion") {
    if (row?.status === "suspended") return fail("They're suspended. Wait for the suspension to end first.");
    const move = resolveRankMove(config.ranks, type, currentIndex, req.rankId);
    if (!move.ok) return fail(move.error);
    toIndex = move.toIndex;
  }
  if (actor) {
    const authority = checkAuthority(actor, req.targetId, Math.max(currentIndex, 0), type, config.ranks, toIndex);
    if (!authority.ok) return fail(authority.error, 403);
  }

  const notes: string[] = [];
  const auditReason = `${REASON_PREFIX}: ${ACTION_LABELS[type]}${reason ? ` (${reason.slice(0, 200)})` : ""}`;
  const fromRank = currentIndex >= 0 ? config.ranks[currentIndex]! : null;
  const toRank = toIndex !== undefined ? config.ranks[toIndex]! : null;
  let expiresAt: Date | null = null;

  if (type === "promotion" || type === "demotion") {
    const add = toRank!.role_id!;
    const remove = heldRankRoleIds(target!, config.ranks).filter((id) => id !== add);
    const problem = rankRolesProblem(guild, actor, [add, ...remove], target);
    if (problem) return fail(problem, 403);
    // Add first, then remove, so the member never briefly holds no rank (that would read as leaving).
    const added = await safeAddRole(target!, add, auditReason, { allowStaffRoles: true });
    if (!added.ok) return fail(added.reason);
    for (const id of remove) await safeRemoveRole(target!, id, auditReason);
    const joining = !row || row.leftTeamAt !== null || row.status === "terminated";
    // The role-change event may already have recorded the join (and run onboarding); only do it
    // here when it hasn't, so new staff are onboarded exactly once.
    const now = getTeamMember(guild.id, req.targetId);
    const alreadyJoined = joining && now !== null && now.leftTeamAt === null && now.status === "active" && now.joinedAt.getTime() >= startedAt;
    if (joining && !alreadyJoined) {
      upsertTeamMember(guild.id, req.targetId, {
        joinedAt: new Date(),
        leftTeamAt: null,
        status: "active",
        rankId: toRank!.id,
        suspendedUntil: null,
        suspendedRoleIds: "[]",
        trialEndsAt: null,
        trialReviewedAt: null,
      });
      await onJoinTeam(target!, config, toRank!).catch(() => null);
    } else {
      upsertTeamMember(guild.id, req.targetId, { rankId: toRank!.id });
    }
  } else if (type === "suspension") {
    const days = Math.trunc(req.days ?? 0);
    if (days < 1 || days > 365) return fail("Suspend for 1 to 365 days.");
    const held = heldRankRoleIds(target!, config.ranks);
    const problem = rankRolesProblem(guild, actor, held, target);
    if (problem) return fail(problem, 403);
    expiresAt = new Date(Date.now() + days * DAY_MS);
    // Recorded before the roles come off, so the role-change event doesn't read it as leaving.
    upsertTeamMember(guild.id, req.targetId, {
      status: "suspended",
      suspendedUntil: expiresAt,
      suspendedRoleIds: JSON.stringify(held),
      rankId: fromRank?.id ?? row?.rankId ?? null,
    });
    for (const id of held) await safeRemoveRole(target!, id, auditReason);
    const suspendedRole = usableStatusRole(guild, config.actions.suspended_role_id);
    if (suspendedRole) await safeAddRole(target!, suspendedRole, auditReason);
    else if (config.actions.suspended_role_id) notes.push("The suspended role couldn't be given (check it's below Dreamliner and has no staff permissions).");
    const shift = getActiveShift(guild.id, req.targetId);
    if (shift) await endShiftRecord(guild, config, shift, "admin", { member: target, note: "Suspended" });
  } else if (type === "termination") {
    const removable = target ? heldRankRoleIds(target, config.ranks) : [];
    const problem = target ? rankRolesProblem(guild, actor, removable, target) : null;
    if (problem) return fail(problem, 403);
    upsertTeamMember(guild.id, req.targetId, {
      status: "terminated",
      leftTeamAt: new Date(),
      suspendedUntil: null,
      suspendedRoleIds: "[]",
      trialEndsAt: null,
      rankId: fromRank?.id ?? row?.rankId ?? null,
    });
    if (target) {
      const statusRoles = [config.shifts.duty_role_id, config.leave.loa_role_id, config.leave.ra_role_id, config.actions.suspended_role_id].filter(
        (id): id is string => Boolean(id),
      );
      for (const id of [...removable, ...statusRoles]) {
        if (target.roles.cache.has(id)) await safeRemoveRole(target, id, auditReason).catch(() => null);
      }
    }
    const shift = getActiveShift(guild.id, req.targetId);
    if (shift) await endShiftRecord(guild, config, shift, "admin", { member: target, note: "Terminated" });
    const leave = getOpenLeave(guild.id, req.targetId);
    if (leave) await endLeaveRecord(guild, config, leave, { status: leave.status === "active" ? "ended" : "cancelled", quiet: true });
  } else if (type === "strike") {
    expiresAt = strikeExpiry(config.actions.strike_expiry_days);
  }

  const action = insertAction({
    guildId: guild.id,
    userId: req.targetId,
    actorId: actor?.userId ?? null,
    type,
    fromRankId: fromRank?.id ?? null,
    toRankId: type === "promotion" || type === "demotion" ? toRank!.id : null,
    reason,
    expiresAt,
    auto: Boolean(req.auto),
    createdAt: new Date(),
  });

  await announceAction(guild.client, guild, req.guildConfig, config, action, target).catch((error) => {
    log.warn(`Could not announce team action ${action.id}: ${error instanceof Error ? error.message : error}`);
  });
  scheduleRosterUpdate(guild.id);

  if (type === "strike") {
    const active = countActiveStrikes(strikeRows(guild.id, [req.targetId]));
    const threshold = crossedThreshold(config.actions.strike_thresholds, active - 1, active);
    if (threshold) notes.push(await applyThreshold(req, threshold, active));
  }
  return { ok: true, action, notes };
}

async function applyThreshold(
  req: ActionRequest,
  threshold: TeamControlConfig["actions"]["strike_thresholds"][number],
  strikes: number,
): Promise<string> {
  const { guild, config } = req;
  const reason = `Reached ${strikes} active strikes`;
  if (threshold.action === "notify") {
    await postTeamMessage(
      guild.client,
      guild,
      channelOr(config, config.actions.log_channel_id),
      teamCard(guild.client, req.guildConfig, "Strike threshold reached", `<@${req.targetId}> now has **${strikes}** active strikes.`, { tone: "warning" }),
      { pingRoleIds: config.manager_role_ids },
    );
    return `They reached ${strikes} strikes, so managers were notified.`;
  }
  const type: TeamActionType = threshold.action === "demote" ? "demotion" : threshold.action === "suspend" ? "suspension" : "termination";
  const result = await performTeamAction({
    ...req,
    actor: null,
    type,
    rankId: null,
    reason,
    days: threshold.suspend_days,
    auto: true,
  });
  return result.ok
    ? `They reached ${strikes} strikes, so they were automatically given a ${ACTION_LABELS[type].toLowerCase()}.`
    : `They reached ${strikes} strikes, but the automatic ${ACTION_LABELS[type].toLowerCase()} failed: ${result.error}`;
}

function actionTone(type: TeamActionType): "success" | "warning" | "error" | "neutral" {
  if (type === "promotion") return "success";
  if (type === "termination" || type === "suspension") return "error";
  if (type === "warning" || type === "strike" || type === "demotion") return "warning";
  return "neutral";
}

function rankName(config: TeamControlConfig, id: string | null): string | null {
  if (!id) return null;
  return neutralizeMentions(config.ranks.find((rank) => rank.id === id)?.name ?? id);
}

/** One line describing what happened, for logs and DMs. */
export function describeAction(config: TeamControlConfig, action: ActionRow): string {
  const from = rankName(config, action.fromRankId);
  const to = rankName(config, action.toRankId);
  switch (action.type as TeamActionType) {
    case "promotion":
      return from ? `promoted from **${from}** to **${to}**` : `added to the team as **${to}**`;
    case "demotion":
      return `demoted from **${from}** to **${to}**`;
    case "warning":
      return "warned";
    case "strike":
      return "given a strike";
    case "suspension":
      return `suspended until <t:${unix(action.expiresAt!)}:f>`;
    default:
      return "removed from the team";
  }
}

async function announceAction(
  client: Client,
  guild: Guild,
  guildConfig: GuildConfig,
  config: TeamControlConfig,
  action: ActionRow,
  target: GuildMember | null,
): Promise<void> {
  const type = action.type as TeamActionType;
  const label = ACTION_LABELS[type];
  const by = action.actorId ? `<@${action.actorId}>` : "Dreamliner (automatic)";
  const reason = action.reason ? neutralizeMentions(action.reason) : "No reason given";
  const fields = [embedField("Reason", reason), embedField("By", by, true)];
  if (type === "strike") {
    const active = countActiveStrikes(strikeRows(guild.id, [action.userId]));
    fields.push(embedField("Active strikes", String(active), true));
    if (action.expiresAt) fields.push(embedField("Expires", `<t:${unix(action.expiresAt)}:D>`, true));
  }
  fields.push(embedField("Action", `#${action.id}`, true));
  await postTeamMessage(
    client,
    guild,
    channelOr(config, config.actions.log_channel_id),
    teamCard(client, guildConfig, label, `<@${action.userId}> was ${describeAction(config, action)}.`, {
      tone: actionTone(type),
      fields,
      thumbnail: target?.displayAvatarURL({ size: 128 }) ?? null,
    }),
  );
  if ((type === "promotion" || type === "demotion") && config.actions.announce_channel_id) {
    await postTeamMessage(
      client,
      guild,
      config.actions.announce_channel_id,
      teamCard(
        client,
        guildConfig,
        type === "promotion" ? "Promotion" : "Rank change",
        type === "promotion"
          ? `Congratulations <@${action.userId}>, you've been ${describeAction(config, action)}! 🎉`
          : `<@${action.userId}> was ${describeAction(config, action)}.`,
        { tone: type === "promotion" ? "success" : "neutral", thumbnail: target?.displayAvatarURL({ size: 128 }) ?? null },
      ),
    );
  }
  if (config.actions.dm_member && target) {
    await dmTeamCard(
      target.user,
      teamCard(client, guildConfig, `${label} in ${guild.name}`, `You were ${describeAction(config, action)}.`, {
        tone: actionTone(type),
        fields: [embedField("Reason", reason)],
      }),
    );
  }
}

/** Voids an action. It stays on record; rank and role changes aren't undone. */
export async function voidTeamAction(
  guild: Guild,
  config: TeamControlConfig,
  actor: TeamActor,
  actionId: number,
  reason: string,
): Promise<ActionResult> {
  const existing = getAction(guild.id, actionId);
  if (!existing) return fail("That action doesn't exist.", 404);
  if (existing.voidedAt) return fail("That action is already voided.");
  const trimmed = reason.trim().slice(0, MAX_REASON);
  if (!trimmed) return fail("Please give a reason for voiding it.");
  const target = await guild.members.fetch(existing.userId).catch(() => null);
  const row = getTeamMember(guild.id, existing.userId);
  const authority = checkAuthority(actor, existing.userId, Math.max(targetRankIndex(config, target, row), 0), "warning", config.ranks);
  if (!authority.ok) return fail(authority.error, 403);
  const action = voidAction(guild.id, actionId, actor.userId, trimmed);
  if (!action) return fail("That action is already voided.");
  const notes: string[] = [];
  if (existing.type === "promotion" || existing.type === "demotion" || existing.type === "termination") {
    notes.push("Voiding doesn't change their roles back. Change their rank yourself if needed.");
  }
  // A voided suspension that's still running ends now.
  if (existing.type === "suspension" && row?.status === "suspended") {
    await endSuspension(guild.client, guild.id, existing.userId, config);
    notes.push("Their suspension ended and their rank roles were given back.");
  }
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await postTeamMessage(
    guild.client,
    guild,
    channelOr(config, config.actions.log_channel_id),
    teamCard(guild.client, guildConfig, "Action voided", `${ACTION_LABELS[existing.type as TeamActionType]} #${existing.id} for <@${existing.userId}> was voided by <@${actor.userId}>.`, {
      fields: [embedField("Reason", neutralizeMentions(trimmed))],
    }),
  );
  return { ok: true, action, notes };
}

/** Ends a suspension: gives the rank roles back and removes the suspended role. */
export async function endSuspension(client: Client, guildId: string, userId: string, config: TeamControlConfig): Promise<void> {
  const row = getTeamMember(guildId, userId);
  if (!row || row.status !== "suspended") return;
  const guild = client.guilds.cache.get(guildId);
  const roleIds = parseRoleIds(row.suspendedRoleIds).filter((id) => rankRoleIds(config.ranks).includes(id));
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  if (!guild || !member) {
    upsertTeamMember(guildId, userId, { status: "active", suspendedUntil: null, suspendedRoleIds: "[]", ...(guild ? { leftTeamAt: new Date() } : {}) });
    return;
  }
  const reason = `${REASON_PREFIX}: suspension ended`;
  // Roles go back on before the row says active, so a role-change event in between can't read
  // "active with no rank" as leaving the team.
  for (const id of roleIds) await safeAddRole(member, id, reason, { allowStaffRoles: true }).catch(() => null);
  upsertTeamMember(guildId, userId, { status: "active", suspendedUntil: null, suspendedRoleIds: "[]" });
  if (config.actions.suspended_role_id && member.roles.cache.has(config.actions.suspended_role_id)) {
    await safeRemoveRole(member, config.actions.suspended_role_id, reason).catch(() => null);
  }
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  await postTeamMessage(
    client,
    guild,
    channelOr(config, config.actions.log_channel_id),
    teamCard(client, guildConfig, "Suspension ended", `<@${userId}>'s suspension ended and their rank roles were given back.`, { tone: "success" }),
  );
  if (config.actions.dm_member) {
    await dmTeamCard(member.user, teamCard(client, guildConfig, `Suspension ended in ${guild.name}`, "Your suspension is over and your rank is restored.", { tone: "success" }));
  }
  scheduleRosterUpdate(guildId);
}
