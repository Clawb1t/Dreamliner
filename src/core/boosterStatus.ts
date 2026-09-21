import type { GuildMember } from "discord.js";

/** Whether a member currently has an active server boost. Replaces each plugin's own
 * `member.premiumSince`/`premiumSinceTimestamp` re-derivation with one shared check. */
export function isBoosting(member: GuildMember): boolean {
  return member.premiumSinceTimestamp != null;
}

/** Milliseconds since boosting began, from either a live member or a raw boost-start date. */
export function boostDurationMs(premiumSince: Date | GuildMember | null): number | null {
  const since = premiumSince instanceof Date ? premiumSince : (premiumSince?.premiumSince ?? null);
  return since ? Date.now() - since.getTime() : null;
}

export function boostDurationDays(premiumSince: Date | GuildMember | null): number | null {
  const ms = boostDurationMs(premiumSince);
  return ms === null ? null : Math.floor(ms / 86_400_000);
}
