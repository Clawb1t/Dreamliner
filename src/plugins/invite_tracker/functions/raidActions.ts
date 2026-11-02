import { GuildFeature, type Guild } from "discord.js";
import type { InviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import { getLogger } from "../../../core/logger.js";
import { onInviteDeleted } from "./cache.js";
import { postInviteLog } from "./messages.js";
import { clampPauseMinutes, RaidDetector } from "./raid.js";

const log = getLogger("invite_tracker");
const RAID_REASON = "Dreamliner Invite Tracker: join burst";

export const raidDetector = new RaidDetector();

/** When Discord's invite pause ends, or null when invites aren't paused. */
export function invitesPausedUntil(guild: Guild, now = Date.now()): Date | null {
  const until = guild.incidentsData?.invitesDisabledUntil ?? null;
  if (until && until.getTime() > now) return until;
  // The older "invites disabled" feature flag has no end time.
  if (guild.features.includes(GuildFeature.InvitesDisabled)) return new Date(now + 24 * 3_600_000);
  return null;
}

/** The guild's current DM pause, carried through so changing the invite pause doesn't lift it
 *  (the incident-actions endpoint replaces both at once). */
function currentDmPause(guild: Guild): Date | null {
  const until = guild.incidentsData?.dmsDisabledUntil ?? null;
  return until && until.getTime() > Date.now() ? until : null;
}

/** Pauses every invite for `minutes` (15 minutes to 24 hours). Returns when the pause ends. */
export async function pauseInvites(guild: Guild, minutes: number): Promise<Date> {
  const until = new Date(Date.now() + clampPauseMinutes(minutes) * 60_000);
  try {
    const result = await guild.setIncidentActions({ invitesDisabledUntil: until, dmsDisabledUntil: currentDmPause(guild) });
    return result.invitesDisabledUntil ?? until;
  } catch (error) {
    // Older guilds (or missing incident permissions) fall back to the plain "pause invites" flag.
    log.warn(`setIncidentActions failed in ${guild.id}, falling back: ${error instanceof Error ? error.message : error}`);
    await guild.disableInvites(true);
    return until;
  }
}

export async function resumeInvites(guild: Guild): Promise<void> {
  if (guild.incidentsData?.invitesDisabledUntil) {
    await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: currentDmPause(guild) });
  }
  if (guild.features.includes(GuildFeature.InvitesDisabled)) await guild.disableInvites(false);
}

/**
 * Feeds one join into the burst detector and, when it trips, takes the configured action and
 * alerts the log channel (pinging the alert role). Each guild has a 10-minute cooldown.
 */
export async function recordRaidJoin(
  guild: Guild,
  config: InviteTrackerConfig,
  join: { code: string | null; source: string },
): Promise<void> {
  if (!config.raid.enabled) return;
  const key = join.code ?? `source:${join.source}`;
  const tripped = raidDetector.record(guild.id, key, Date.now(), {
    threshold: config.raid.threshold_joins,
    windowSeconds: config.raid.window_seconds,
  });
  if (!tripped) return;

  const through = join.code ? `invite \`${join.code}\`` : join.source === "vanity" ? "the vanity URL" : "unknown invites";
  const lines = [
    `**${config.raid.threshold_joins}** members joined through ${through} within ${config.raid.window_seconds} seconds.`,
  ];

  if (config.raid.action === "delete_invite") {
    if (join.code) {
      const deleted = await guild.invites.delete(join.code, RAID_REASON).then(
        () => true,
        () => false,
      );
      if (deleted) onInviteDeleted(guild.id, join.code);
      lines.push(deleted ? `Deleted invite \`${join.code}\`.` : `Couldn't delete invite \`${join.code}\`. Check Dreamliner has Manage Server.`);
    } else {
      lines.push("There was no single invite to delete.");
    }
  } else if (config.raid.action === "pause_all") {
    const until = await pauseInvites(guild, config.raid.pause_minutes).catch(() => null);
    lines.push(
      until
        ? `Paused every invite until <t:${Math.floor(until.getTime() / 1000)}:t>. Resume early with \`/invites raid resume\`.`
        : "Couldn't pause invites. Check Dreamliner has Manage Server.",
    );
  }

  await postInviteLog(guild.client, guild, config, "Possible raid", lines.join("\n"), {
    tone: "warning",
    pingRoleId: config.raid.alert_role_id,
  });
}
