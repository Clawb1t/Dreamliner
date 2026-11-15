import type { Guild } from "discord.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("team_control");

/** Most staff an on-shift page mentions at once, so a busy shift doesn't turn into a ping wall. */
export const ON_SHIFT_PING_LIMIT = 5;

type ShiftLike = { userId: string; startedAt: Date; breakStartedAt: Date | null };

/**
 * Pure selection: staff who are clocked in right now, not on a break and not on leave. When
 * `preferredUserIds` is given (e.g. on-shift staff who also hold the ticket's support role) and
 * any of them are available, only those are picked. Longest-running shift first, capped.
 */
export function pickOnShiftStaff(
  activeShifts: readonly ShiftLike[],
  onLeaveUserIds: ReadonlySet<string>,
  options: { preferredUserIds?: ReadonlySet<string> | null; limit?: number } = {},
): string[] {
  const limit = Math.max(1, options.limit ?? ON_SHIFT_PING_LIMIT);
  const available = [...activeShifts]
    .filter((shift) => !shift.breakStartedAt && !onLeaveUserIds.has(shift.userId))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((shift) => shift.userId);
  const unique = [...new Set(available)];
  const preferred = options.preferredUserIds?.size ? unique.filter((id) => options.preferredUserIds!.has(id)) : [];
  return (preferred.length ? preferred : unique).slice(0, limit);
}

export type StaffPing = {
  /** Mentions to put in the message, space separated. Empty when there's nobody to ping. */
  content: string;
  /** Pass straight to `allowedMentions` so only these get pinged. */
  allowedMentions: { users: string[]; roles: string[]; parse: [] };
  /** True when on-shift staff were paged instead of the fallback roles. */
  onShift: boolean;
};

export function buildStaffPing(userIds: readonly string[], roleIds: readonly string[], onShift: boolean): StaffPing {
  const users = onShift ? [...new Set(userIds)] : [];
  const roles = onShift ? [] : [...new Set(roleIds)];
  return {
    content: [...users.map((id) => `<@${id}>`), ...roles.map((id) => `<@&${id}>`)].join(" "),
    allowedMentions: { users, roles, parse: [] },
    onShift,
  };
}

/**
 * Who to page for an alert: up to ON_SHIFT_PING_LIMIT clocked-in staff (not on break or leave),
 * preferring holders of `roleIds` when any are on shift. Falls back to pinging `roleIds` when
 * Team Control is off or nobody is on shift. Never throws.
 */
export async function resolveOnShiftPing(guild: Guild, roleIds: readonly string[]): Promise<StaffPing> {
  const fallback = buildStaffPing([], roleIds, false);
  try {
    const { loadActiveTeamControl } = await import("./config.js");
    if (!(await loadActiveTeamControl(guild.id))) return fallback;
    const { activeLeaveByUser, listActiveShifts } = await import("./store.js");
    const shifts = listActiveShifts(guild.id);
    if (!shifts.length) return fallback;
    const onLeave = new Set(activeLeaveByUser(guild.id).keys());
    const preferred = new Set<string>();
    if (roleIds.length) {
      for (const shift of shifts) {
        const member = guild.members.cache.get(shift.userId);
        if (member && roleIds.some((roleId) => member.roles.cache.has(roleId))) preferred.add(shift.userId);
      }
    }
    const picked = pickOnShiftStaff(shifts, onLeave, { preferredUserIds: preferred });
    return picked.length ? buildStaffPing(picked, [], true) : fallback;
  } catch (err) {
    log.error("On-shift staff lookup failed:", err);
    return fallback;
  }
}
