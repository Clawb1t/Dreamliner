import type { GuildMember } from "discord.js";
import type { BoosterRolesConfig, BoosterRoleTier } from "../../../config/schemas/boosterRoles.js";
import { boostDurationDays } from "../../../core/boosterStatus.js";
import { activeTiers, hasBoostCountTiers } from "./config.js";
import { effectiveBoostCount } from "./boostCounts.js";
import { autoGrantableRoleIds } from "../../../core/roles.js";

export type BoosterRoleEvaluation = {
  toAdd: string[];
  toRemove: string[];
};

export type BoosterProgress = {
  /** Days of continuous boosting, or null when not boosting. */
  days: number | null;
  /** Boosts given in the current streak (0 when not boosting). */
  boosts: number;
};

export function tierQualifies(tier: BoosterRoleTier, progress: BoosterProgress): boolean {
  if (progress.days === null) return false;
  return tier.requirement === "boosts" ? progress.boosts >= tier.boost_count : progress.days >= tier.duration_days;
}

/**
 * Which tier role IDs a member should hold vs. currently held tier role IDs. Non-stacking
 * (default): only the highest qualified tier of each kind is kept, so a member can hold one
 * duration role and one boost-count role at once. Stacking: every qualified tier is kept. A member
 * who isn't boosting loses every tier role.
 */
export function evaluateBoosterRoles(
  member: GuildMember,
  premiumSince: Date | null,
  config: BoosterRolesConfig,
  boosts = premiumSince ? 1 : 0,
): BoosterRoleEvaluation {
  const tiers = activeTiers(config);
  const held = tiers.filter((tier) => member.roles.cache.has(tier.role_id));
  const progress: BoosterProgress = { days: premiumSince ? (boostDurationDays(premiumSince) ?? 0) : null, boosts };

  const qualifying = tiers.filter((tier) => tierQualifies(tier, progress));
  let wanted = qualifying;
  if (!config.stacking) {
    // activeTiers sorts each kind ascending, so the last qualifying tier of a kind is its highest.
    const highest = new Map<string, BoosterRoleTier>();
    for (const tier of qualifying) highest.set(tier.requirement, tier);
    wanted = [...highest.values()];
  }
  const wantedIds = new Set(wanted.map((tier) => tier.role_id));

  const toAdd = [...new Set(wanted.filter((tier) => !member.roles.cache.has(tier.role_id)).map((tier) => tier.role_id))];
  const toRemove = [...new Set(held.filter((tier) => !wantedIds.has(tier.role_id)).map((tier) => tier.role_id))];

  return { toAdd, toRemove };
}

/** Whether the member holds any configured tier role (e.g. an ex-booster who still needs them removed). */
export function holdsBoosterTierRole(member: GuildMember, config: BoosterRolesConfig): boolean {
  return activeTiers(config).some((tier) => member.roles.cache.has(tier.role_id));
}

/** Evaluate and actually add/remove the roles on Discord. Safe to call repeatedly — a no-op diff does
 *  nothing. Returns only the roles actually added/removed (not ones skipped or that Discord refused). */
export async function syncBoosterRoles(member: GuildMember, config: BoosterRolesConfig): Promise<BoosterRoleEvaluation> {
  const boosts = hasBoostCountTiers(config) ? await effectiveBoostCount(member) : member.premiumSince ? 1 : 0;
  const evaluation = evaluateBoosterRoles(member, member.premiumSince, config, boosts);
  const toAdd = autoGrantableRoleIds(member.guild, evaluation.toAdd);
  let added: string[] = [];
  let removed: string[] = [];
  if (toAdd.length > 0) {
    added = (await member.roles.add(toAdd).then(() => true).catch(() => false)) ? toAdd : [];
  }
  if (evaluation.toRemove.length > 0) {
    removed = (await member.roles.remove(evaluation.toRemove).then(() => true).catch(() => false)) ? evaluation.toRemove : [];
  }
  return { toAdd: added, toRemove: removed };
}
