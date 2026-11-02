import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Guild } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField } from "../../../core/embeds.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { containerEdit } from "../../../core/responses.js";
import { safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { channelOr, LEAVE_LABELS, MAX_REASON, TEAM_PREFIX, unix, type LeaveKind, type LeaveStatus } from "./config.js";
import { extendLeave, validateLeaveRequest } from "./leaveRules.js";
import { dmTeamCard, postTeamMessage, teamCard } from "./messages.js";
import { usableStatusRole } from "./ranks.js";
import { scheduleRosterUpdate } from "./roster.js";
import { dueLeaveEnds, dueLeaveStarts, getOpenLeave, insertLeave, lastLeaveDecision, updateLeave, type LeaveRow } from "./store.js";

export const LEAVE_BUTTON = `${TEAM_PREFIX}lv:`;
export const LEAVE_DENY_MODAL = `${TEAM_PREFIX}lvdeny:`;
export const LEAVE_REQUEST_MODAL = `${TEAM_PREFIX}lvreq:`;
const ROLE_REASON = "Dreamliner Team Control: leave";

export type LeaveResult = { ok: true; leave: LeaveRow } | { ok: false; status: number; error: string };
const fail = (error: string, status = 400): LeaveResult => ({ ok: false, status, error });

function roleFor(config: TeamControlConfig, kind: string): string | null {
  return kind === "ra" ? config.leave.ra_role_id : config.leave.loa_role_id;
}

function leaveSummary(leave: LeaveRow): string {
  return `**${LEAVE_LABELS[leave.kind as LeaveKind]}** from <t:${unix(leave.startsAt)}:D> to <t:${unix(leave.endsAt)}:D>`;
}

function reviewRow(leaveId: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${LEAVE_BUTTON}approve:${leaveId}`).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${LEAVE_BUTTON}deny:${leaveId}`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

const STATUS_TEXT: Record<LeaveStatus, string> = {
  pending: "Waiting for review",
  approved: "Approved",
  denied: "Denied",
  active: "On leave now",
  ended: "Ended",
  cancelled: "Cancelled",
};

async function reviewCard(client: Client, guild: Guild, leave: LeaveRow) {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const fields = [
    embedField("Reason", leave.reason ? neutralizeMentions(leave.reason) : "No reason given"),
    embedField("Status", STATUS_TEXT[leave.status as LeaveStatus], true),
  ];
  if (leave.reviewerId) fields.push(embedField("Reviewed by", `<@${leave.reviewerId}>`, true));
  if (leave.reviewReason) fields.push(embedField("Review note", neutralizeMentions(leave.reviewReason)));
  const tone = leave.status === "denied" ? "error" : leave.status === "pending" ? "warning" : "success";
  return teamCard(client, guildConfig, "Leave request", `<@${leave.userId}> requested ${leaveSummary(leave)}.`, { tone, fields, footer: `Request #${leave.id}` });
}

/** Re-renders the review message after a decision (buttons disabled once it's decided). */
async function refreshReviewMessage(client: Client, guild: Guild, leave: LeaveRow): Promise<void> {
  if (!leave.reviewChannelId || !leave.reviewMessageId) return;
  const channel = await fetchGuildTextChannel(client, guild.id, leave.reviewChannelId);
  const message = await channel?.messages.fetch(leave.reviewMessageId).catch(() => null);
  if (!message) return;
  const card = await reviewCard(client, guild, leave);
  await message.edit(containerEdit(card, [reviewRow(leave.id, leave.status !== "pending")]) as Parameters<typeof message.edit>[0]).catch(() => null);
}

async function logLeave(client: Client, guild: Guild, config: TeamControlConfig, title: string, body: string, tone: "success" | "neutral" | "warning" | "error") {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await postTeamMessage(client, guild, channelOr(config, config.leave.log_channel_id), teamCard(client, guildConfig, title, body, { tone }));
}

/** Files a leave request: pending review, or approved straight away with `auto_approve`. */
export async function requestLeave(
  client: Client,
  guild: Guild,
  config: TeamControlConfig,
  userId: string,
  input: { kind: LeaveKind; days: number; startsInDays: number; reason: string },
): Promise<LeaveResult> {
  if (!config.leave.enabled) return fail("Leave requests are turned off on this server.");
  const reason = input.reason.trim().slice(0, MAX_REASON);
  const check = validateLeaveRequest({ ...input, reason }, config.leave, {
    hasOpen: Boolean(getOpenLeave(guild.id, userId)),
    lastDecidedAt: lastLeaveDecision(guild.id, userId),
  });
  if (!check.ok) return fail(check.error);
  const now = new Date();
  let leave = insertLeave({
    guildId: guild.id,
    userId,
    kind: input.kind,
    reason,
    startsAt: check.startsAt,
    endsAt: check.endsAt,
    status: config.leave.auto_approve ? "approved" : "pending",
    decidedAt: config.leave.auto_approve ? now : null,
    createdAt: now,
  });
  if (config.leave.auto_approve) {
    await logLeave(client, guild, config, "Leave approved", `<@${userId}>'s ${leaveSummary(leave)} was approved automatically.`, "success");
    leave = (await startDueLeave(client, leave, config)) ?? leave;
    return { ok: true, leave };
  }
  const channelId = channelOr(config, config.leave.request_channel_id);
  const ping = config.leave.ping_role_id ? [config.leave.ping_role_id] : config.manager_role_ids;
  const card = await reviewCard(client, guild, leave);
  const message = await postTeamMessage(client, guild, channelId, card, { rows: [reviewRow(leave.id)], pingRoleIds: ping });
  if (message) leave = updateLeave(guild.id, leave.id, { reviewChannelId: message.channelId, reviewMessageId: message.id }) ?? leave;
  return { ok: true, leave };
}

/** Approves or denies a pending request. */
export async function decideLeave(
  client: Client,
  guild: Guild,
  config: TeamControlConfig,
  leave: LeaveRow,
  reviewerId: string,
  approve: boolean,
  reviewReason: string | null,
): Promise<LeaveResult> {
  if (leave.status !== "pending") return fail(`This request is already ${STATUS_TEXT[leave.status as LeaveStatus].toLowerCase()}.`);
  if (leave.userId === reviewerId) return fail("You can't review your own leave request.", 403);
  const reason = reviewReason?.trim().slice(0, MAX_REASON) || null;
  let updated = updateLeave(guild.id, leave.id, {
    status: approve ? "approved" : "denied",
    reviewerId,
    reviewReason: reason,
    decidedAt: new Date(),
  })!;
  await logLeave(
    client,
    guild,
    config,
    approve ? "Leave approved" : "Leave denied",
    `<@${reviewerId}> ${approve ? "approved" : "denied"} <@${leave.userId}>'s ${leaveSummary(leave)}.${reason ? `\n> ${neutralizeMentions(reason)}` : ""}`,
    approve ? "success" : "error",
  );
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const user = await client.users.fetch(leave.userId).catch(() => null);
  await dmTeamCard(
    user,
    teamCard(
      client,
      guildConfig,
      approve ? `Leave approved in ${guild.name}` : `Leave denied in ${guild.name}`,
      `Your ${leaveSummary(leave)} was ${approve ? "approved" : "denied"}.`,
      { tone: approve ? "success" : "error", fields: reason ? [embedField("Note", neutralizeMentions(reason))] : [] },
    ),
  );
  if (approve) updated = (await startDueLeave(client, updated, config)) ?? updated;
  await refreshReviewMessage(client, guild, updated);
  return { ok: true, leave: updated };
}

/** Starts approved leave whose start time has come: applies the LOA/RA role. */
export async function startDueLeave(client: Client, leave: LeaveRow, config: TeamControlConfig): Promise<LeaveRow | null> {
  if (leave.status !== "approved" || leave.startsAt.getTime() > Date.now()) return null;
  const guild = client.guilds.cache.get(leave.guildId);
  if (!guild) return null;
  const roleId = usableStatusRole(guild, roleFor(config, leave.kind));
  let roleApplied = false;
  if (roleId) {
    const member = await guild.members.fetch(leave.userId).catch(() => null);
    if (member) roleApplied = (await safeAddRole(member, roleId, ROLE_REASON).catch(() => ({ ok: false }))).ok;
  }
  const updated = updateLeave(leave.guildId, leave.id, { status: "active", roleApplied });
  scheduleRosterUpdate(leave.guildId);
  return updated;
}

/** Ends running leave (or cancels upcoming leave): takes the role back off, logs and DMs. */
export async function endLeaveRecord(
  guild: Guild,
  config: TeamControlConfig,
  leave: LeaveRow,
  options: { status?: "ended" | "cancelled"; by?: string | null; quiet?: boolean } = {},
): Promise<LeaveRow> {
  const status = options.status ?? (leave.status === "active" ? "ended" : "cancelled");
  const updated = updateLeave(guild.id, leave.id, { status, endedAt: new Date() }) ?? leave;
  const roleId = roleFor(config, leave.kind);
  if (leave.roleApplied && roleId) {
    const member = await guild.members.fetch(leave.userId).catch(() => null);
    if (member) await safeRemoveRole(member, roleId, ROLE_REASON).catch(() => null);
  }
  if (!options.quiet) {
    const byText = options.by && options.by !== leave.userId ? ` by <@${options.by}>` : "";
    await logLeave(
      guild.client,
      guild,
      config,
      status === "ended" ? "Leave ended" : "Leave cancelled",
      `<@${leave.userId}>'s ${LEAVE_LABELS[leave.kind as LeaveKind].toLowerCase()} was ${status}${byText}.`,
      "neutral",
    );
  }
  await refreshReviewMessage(guild.client, guild, updated);
  scheduleRosterUpdate(guild.id);
  return updated;
}

/** Extends approved or running leave by `days`. */
export async function extendLeaveRecord(guild: Guild, config: TeamControlConfig, leave: LeaveRow, days: number, by: string): Promise<LeaveResult> {
  if (!["approved", "active"].includes(leave.status)) return fail("Only approved or running leave can be extended.");
  const next = extendLeave(leave, days, config.leave.max_days);
  if (!next.ok) return fail(next.error);
  const updated = updateLeave(guild.id, leave.id, { endsAt: next.endsAt })!;
  await logLeave(guild.client, guild, config, "Leave extended", `<@${by}> extended <@${leave.userId}>'s leave to <t:${unix(next.endsAt)}:D>.`, "neutral");
  return { ok: true, leave: updated };
}

/** The minute tick: starts approved leave and ends leave that ran out. */
export async function processDueLeave(client: Client, getConfig: (guildId: string) => Promise<TeamControlConfig | null>): Promise<void> {
  for (const leave of dueLeaveStarts()) {
    const config = await getConfig(leave.guildId);
    if (config) await startDueLeave(client, leave, config);
  }
  for (const leave of dueLeaveEnds()) {
    const guild = client.guilds.cache.get(leave.guildId);
    const config = guild ? await getConfig(leave.guildId) : null;
    if (!guild || !config) continue;
    await endLeaveRecord(guild, config, leave, { status: "ended" });
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    const user = await client.users.fetch(leave.userId).catch(() => null);
    await dmTeamCard(user, teamCard(client, guildConfig, `Welcome back to ${guild.name}`, `Your ${LEAVE_LABELS[leave.kind as LeaveKind].toLowerCase()} has ended.`, { tone: "success" }));
  }
}
