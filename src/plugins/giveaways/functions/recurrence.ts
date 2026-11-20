export type GiveawayRecurrence = "none" | "daily" | "weekly";

export const RECURRENCES: GiveawayRecurrence[] = ["none", "daily", "weekly"];

const DAY_MS = 86_400_000;

export function isRecurrence(value: unknown): value is GiveawayRecurrence {
  return typeof value === "string" && (RECURRENCES as string[]).includes(value);
}

export function recurrenceIntervalMs(recurrence: GiveawayRecurrence): number {
  return recurrence === "daily" ? DAY_MS : recurrence === "weekly" ? 7 * DAY_MS : 0;
}

/**
 * The next occurrence's start and end: one interval after this one's start, keeping the same
 * running time. If that's already past (the bot was offline, or the giveaway was ended late), it
 * moves forward whole intervals until the start is in the future, so occurrences stay on the same
 * time of day / weekday and nothing is posted to catch up.
 */
export function nextOccurrence(
  startsAt: Date,
  endsAt: Date,
  recurrence: GiveawayRecurrence,
  now: Date = new Date(),
): { startsAt: Date; endsAt: Date } | null {
  const interval = recurrenceIntervalMs(recurrence);
  if (interval <= 0) return null;
  const duration = Math.max(60_000, endsAt.getTime() - startsAt.getTime());
  let start = startsAt.getTime() + interval;
  if (start <= now.getTime()) {
    const behind = Math.ceil((now.getTime() - start) / interval);
    start += Math.max(1, behind) * interval;
    if (start <= now.getTime()) start += interval;
  }
  return { startsAt: new Date(start), endsAt: new Date(start + duration) };
}
