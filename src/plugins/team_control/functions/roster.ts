import { createHash } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Guild } from "discord.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { baseEmbed } from "../../../core/embeds.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { containerReply } from "../../../core/responses.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { STATUS_DOTS, TEAM_PREFIX, type TeamStatus } from "./config.js";
import { rankIndexById } from "./authority.js";
import { activeLeaveByUser, deleteRosterMessage, getRosterMessage, listActiveShifts, listCurrentTeam, saveRosterMessage } from "./store.js";
import { APP_EMOJI } from "../../../core/appEmojis.js";

const log = getLogger("team_control");

export const ROSTER_BUTTON = `${TEAM_PREFIX}roster:`;
/** Roster edits are debounced: at most one per guild every 10 seconds. */
const ROSTER_DEBOUNCE_MS = 10_000;
/** Members listed per rank before "and N more". */
const MAX_PER_RANK = 40;

/** Each current team member's status: shift state first, then leave, then suspension. */
export function computeStatuses(guildId: string): Map<string, TeamStatus> {
  const out = new Map<string, TeamStatus>();
  const leave = activeLeaveByUser(guildId);
  for (const row of listCurrentTeam(guildId)) {
    if (row.status === "suspended") out.set(row.userId, "suspended");
    else {
      const l = leave.get(row.userId);
      out.set(row.userId, l ? (l.kind === "ra" ? "ra" : "loa") : "off_duty");
    }
  }
  for (const shift of listActiveShifts(guildId)) {
    if (out.get(shift.userId) === "suspended") continue;
    out.set(shift.userId, shift.breakStartedAt ? "on_break" : "on_duty");
  }
  return out;
}

const STATUS_ORDER: TeamStatus[] = ["on_duty", "on_break", "ra", "off_duty", "loa", "suspended"];

/** The roster card and its buttons. Ranks top to bottom; members by status, then name. */
export function buildRosterPayload(guild: Guild, config: TeamControlConfig) {
  const statuses = computeStatuses(guild.id);
  const team = listCurrentTeam(guild.id);
  const byRank = new Map<number, string[]>();
  for (const row of team) {
    const index = rankIndexById(config.ranks, row.rankId);
    byRank.set(index, [...(byRank.get(index) ?? []), row.userId]);
  }
  const name = (id: string) => guild.members.cache.get(id)?.displayName ?? "";
  const sections: string[] = [];
  for (let i = config.ranks.length - 1; i >= -1; i--) {
    const ids = byRank.get(i);
    if (!ids?.length) continue;
    ids.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(statuses.get(a) ?? "off_duty") - STATUS_ORDER.indexOf(statuses.get(b) ?? "off_duty") ||
        name(a).localeCompare(name(b)),
    );
    const lines = ids.slice(0, MAX_PER_RANK).map((id) => `${STATUS_DOTS[statuses.get(id) ?? "off_duty"]} <@${id}>`);
    if (ids.length > MAX_PER_RANK) lines.push(`-# and ${ids.length - MAX_PER_RANK} more`);
    const title = i >= 0 ? neutralizeMentions(config.ranks[i]!.name) : "Unranked";
    sections.push(`**${title}** · ${ids.length}\n${lines.join("\n")}`);
  }
  const onDuty = [...statuses.values()].filter((s) => s === "on_duty").length;
  const onBreak = [...statuses.values()].filter((s) => s === "on_break").length;
  const body = sections.length ? sections.join("\n\n") : "Nobody is on the team yet.";
  const card = baseEmbed()
    .setTitle(neutralizeMentions(config.roster.title))
    .setDescription(body.slice(0, 3800))
    .setFooter({
      text: `${onDuty} on duty · ${onBreak} on break · ${team.length} staff · ${STATUS_DOTS.on_duty} on duty ${STATUS_DOTS.on_break} break ${STATUS_DOTS.loa} LOA ${STATUS_DOTS.ra} RA ${STATUS_DOTS.suspended} suspended`,
    });
  const rows =
    config.roster.show_buttons && config.shifts.enabled
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${ROSTER_BUTTON}in`).setLabel("Clock in").setEmoji(APP_EMOJI.join).setStyle(ButtonStyle.Success),
            ...(config.shifts.allow_breaks
              ? [new ButtonBuilder().setCustomId(`${ROSTER_BUTTON}break`).setLabel("Break").setEmoji(APP_EMOJI.idle).setStyle(ButtonStyle.Secondary)]
              : []),
            new ButtonBuilder().setCustomId(`${ROSTER_BUTTON}out`).setLabel("Clock out").setEmoji(APP_EMOJI.leave).setStyle(ButtonStyle.Danger),
          ),
        ]
      : [];
  const payload = containerReply(card, false, rows);
  const fingerprint = createHash("sha1").update(JSON.stringify(payload.components)).digest("hex");
  return { payload, fingerprint };
}

/**
 * Brings the roster message up to date: edits it in place when what it shows changed, re-posts it
 * when it was deleted or the channel changed, removes it when the roster was turned off.
 */
export async function syncRoster(client: Client, guild: Guild, config: TeamControlConfig, force = false): Promise<boolean> {
  const tracked = getRosterMessage(guild.id);
  const wanted = config.roster.enabled ? config.roster.channel_id : null;
  if (tracked && tracked.channelId !== wanted) {
    const old = await fetchGuildTextChannel(client, guild.id, tracked.channelId);
    await old?.messages.delete(tracked.messageId).catch(() => null);
    deleteRosterMessage(guild.id);
  }
  if (!wanted) return false;
  const channel = await fetchGuildTextChannel(client, guild.id, wanted);
  if (!channel) return false;
  const built = buildRosterPayload(guild, config);
  const current = tracked && tracked.channelId === wanted ? tracked : null;
  if (current && !force && current.fingerprint === built.fingerprint) return true;
  if (current) {
    const message = await channel.messages.fetch(current.messageId).catch(() => null);
    if (message) {
      const edited = await message.edit(built.payload as Parameters<typeof message.edit>[0]).then(() => true).catch(() => false);
      if (edited) {
        saveRosterMessage(guild.id, wanted, message.id, built.fingerprint);
        return true;
      }
    }
  }
  const sent = await channel.send(built.payload as Parameters<typeof channel.send>[0]).catch((error) => {
    log.warn(`Could not post the roster in ${guild.id}: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  if (!sent) return false;
  saveRosterMessage(guild.id, wanted, sent.id, built.fingerprint);
  return true;
}

// Debounce state: one timer per guild at most, plus when each guild last updated.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const lastRun = new Map<string, number>();
let rosterClient: Client | null = null;
let rosterConfig: ((guildId: string) => Promise<TeamControlConfig | null>) | null = null;

export function initRoster(client: Client, getConfig: (guildId: string) => Promise<TeamControlConfig | null>): void {
  rosterClient = client;
  rosterConfig = getConfig;
}

/** Queues a roster refresh for a guild (no-op when its roster is off). */
export function scheduleRosterUpdate(guildId: string): void {
  if (!rosterClient || pending.has(guildId)) return;
  const wait = Math.max(1_000, (lastRun.get(guildId) ?? 0) + ROSTER_DEBOUNCE_MS - Date.now());
  const timer = setTimeout(() => {
    pending.delete(guildId);
    lastRun.set(guildId, Date.now());
    void (async () => {
      const guild = rosterClient?.guilds.cache.get(guildId);
      const config = guild ? await rosterConfig?.(guildId) : null;
      if (!guild || !config?.roster.enabled) return;
      await syncRoster(rosterClient!, guild, config);
    })().catch((error) => log.warn(`Roster update failed for ${guildId}: ${error instanceof Error ? error.message : error}`));
  }, wait);
  timer.unref?.();
  pending.set(guildId, timer);
}

export function forgetRosterGuild(guildId: string): void {
  const timer = pending.get(guildId);
  if (timer) clearTimeout(timer);
  pending.delete(guildId);
  lastRun.delete(guildId);
}

/** Drops debounce timestamps older than the debounce window (called by the sweep). */
export function pruneRosterState(): void {
  const cutoff = Date.now() - ROSTER_DEBOUNCE_MS;
  for (const [guildId, at] of lastRun) if (at < cutoff) lastRun.delete(guildId);
}
