import type { Client, Guild, Message } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import { endSuspension } from "./actions.js";
import { lastActivity } from "./activity.js";
import { DAY_MS } from "./config.js";
import { processDueLeave } from "./leave.js";
import { loadTeamRuntime, shouldFullFetch, syncGuildTeam } from "./members.js";
import { postTeamMessage, teamCard } from "./messages.js";
import { isTeamOneActive, retentionDays } from "./oneGate.js";
import { dayKey } from "./periods.js";
import { isOnTeam } from "./ranks.js";
import { postScheduledReport } from "./reports.js";
import { postTrialReview } from "./onboarding.js";
import { pruneRosterState, syncRoster } from "./roster.js";
import { autoEndLongShifts } from "./shifts.js";
import {
  activeLeaveByUser,
  addStaffMessages,
  clearInactivityAlert,
  dueSuspensions,
  dueTrials,
  guildsWithTeamData,
  lastShiftAt,
  listCurrentTeam,
  listInactivityAlerts,
  pruneGuildHistory,
  setInactivityAlert,
} from "./store.js";

const log = getLogger("team_control");

export const TICK_MS = 60_000;
export const SWEEP_MS = 30 * 60_000;

/** The effective config for a guild the tick is about to act in, or null when Team Control is off. */
async function runtimeConfig(guildId: string) {
  return (await loadTeamRuntime(guildId))?.config ?? null;
}

/** Every minute: auto clock-out, leave start/end, suspension end, trial end. All state is in the DB, so a restart just catches up. */
export async function runTeamTick(client: Client): Promise<void> {
  await autoEndLongShifts(client, runtimeConfig);
  await processDueLeave(client, runtimeConfig);
  for (const row of dueSuspensions()) {
    const config = await runtimeConfig(row.guildId);
    if (config) await endSuspension(client, row.guildId, row.userId, config);
  }
  for (const row of dueTrials()) {
    const config = await runtimeConfig(row.guildId);
    if (config?.onboarding.enabled) await postTrialReview(client, row, config);
  }
  flushStaffMessages();
}

// ── Staff messages: counted in memory, written once a minute ─────────────────

const MAX_BUFFERED = 20_000;
const messageBuffer = new Map<string, number>();

/** Counts a message toward its author's staff messages when it's in a staff channel. */
export async function countStaffMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.system) return;
  const runtime = await loadTeamRuntime(message.guildId);
  if (!runtime || !runtime.config.activity.enabled) return;
  const channels = runtime.config.activity.staff_channel_ids;
  if (channels.length === 0) return;
  const channelId = message.channel.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId;
  if (!channels.includes(channelId) && !channels.includes(message.channelId)) return;
  if (!isOnTeam(message.member, runtime.config.ranks)) return;
  const key = `${message.guildId}:${message.author.id}:${dayKey(Date.now())}`;
  messageBuffer.set(key, (messageBuffer.get(key) ?? 0) + 1);
  if (messageBuffer.size >= MAX_BUFFERED) flushStaffMessages();
}

export function flushStaffMessages(): void {
  if (messageBuffer.size === 0) return;
  const entries = [...messageBuffer.entries()].map(([key, n]) => {
    const [guildId, userId, day] = key.split(":") as [string, string, string];
    return { guildId, userId, day, n };
  });
  messageBuffer.clear();
  try {
    addStaffMessages(entries);
  } catch (error) {
    log.warn(`Could not save staff message counts: ${error instanceof Error ? error.message : error}`);
  }
}

export function forgetGuildMessages(guildId: string): void {
  for (const key of messageBuffer.keys()) if (key.startsWith(`${guildId}:`)) messageBuffer.delete(key);
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/** Posts an inactivity alert once per inactive streak; activity since the alert clears it. */
async function checkInactivity(client: Client, guild: Guild, config: NonNullable<Awaited<ReturnType<typeof runtimeConfig>>>): Promise<void> {
  const days = config.activity.inactivity_days;
  if (!config.activity.enabled || days <= 0) return;
  const now = Date.now();
  const team = listCurrentTeam(guild.id).filter((row) => row.status === "active");
  if (team.length === 0) return;
  const onLeave = activeLeaveByUser(guild.id);
  const last = lastActivity(guild.id, team.map((row) => row.userId), lastShiftAt(guild.id));
  const alerts = listInactivityAlerts(guild.id);
  const guildConfig = (await loadTeamRuntime(guild.id))?.guildConfig;
  if (!guildConfig) return;
  for (const row of team) {
    const lastAt = Math.max(last.get(row.userId) ?? 0, row.joinedAt.getTime());
    const alertedAt = alerts.get(row.userId);
    if (alertedAt && lastAt > alertedAt.getTime()) {
      clearInactivityAlert(guild.id, row.userId);
      continue;
    }
    if (alertedAt || onLeave.has(row.userId) || now - lastAt < days * DAY_MS) continue;
    setInactivityAlert(guild.id, row.userId);
    await postTeamMessage(
      client,
      guild,
      config.log_channel_id,
      teamCard(client, guildConfig, "Inactive staff member", `<@${row.userId}> hasn't had a shift, mod action, closed ticket or staff message in **${days}** days (last activity <t:${Math.floor(lastAt / 1000)}:R>).`, {
        tone: "warning",
      }),
      { pingRoleIds: config.manager_role_ids },
    );
  }
}

let lastPruneAt = 0;

/** Every 30 minutes: member sync, roster refresh, inactivity alerts, scheduled reports, retention. */
export async function runTeamSweep(client: Client): Promise<void> {
  flushStaffMessages();
  pruneRosterState();
  const prune = Date.now() - lastPruneAt > DAY_MS;
  if (prune) lastPruneAt = Date.now();
  const guildIds = new Set(guildsWithTeamData());
  for (const guild of client.guilds.cache.values()) {
    const runtime = await loadTeamRuntime(guild.id);
    if (!runtime) continue;
    guildIds.delete(guild.id);
    const { config, guildConfig, one } = runtime;
    try {
      await syncGuildTeam(guild, config, shouldFullFetch(guild));
      if (config.roster.enabled) await syncRoster(client, guild, config);
      await checkInactivity(client, guild, config);
      await postScheduledReport(client, guild, guildConfig, config, one);
      if (prune) pruneGuildHistory(guild.id, new Date(Date.now() - retentionDays(one) * DAY_MS));
    } catch (error) {
      log.warn(`Team Control sweep failed for ${guild.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  // Servers that turned Team Control off (or removed the bot) keep their plan's retention window.
  if (prune) {
    for (const guildId of guildIds) {
      pruneGuildHistory(guildId, new Date(Date.now() - retentionDays(await isTeamOneActive(guildId)) * DAY_MS));
    }
  }
}
