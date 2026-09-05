import type { GuildMember } from "discord.js";
import type { BoosterRolesConfig } from "../../../config/schemas/boosterRoles.js";
import { activeTiers } from "./config.js";

export type BoosterRoleEvaluation = {
  toAdd: string[];
  toRemove: string[];
};

const DAY_MS = 86_400_000;

export function boostDurationDays(premiumSince: Date): number {
  return Math.floor((Date.now() - premiumSince.getTime()) / DAY_MS);
}

/**
 * Which tier role IDs a member should hold vs. currently held tier role IDs, given their
 * `premiumSince`. Non-stacking (default): only the highest tier currently qualified for is kept.
 * Stacking: every qualified tier is kept. A member who isn't boosting loses every tier role.
 */
export function evaluateBoosterRoles(
  member: GuildMember,
  premiumSince: Date | null,
  config: BoosterRolesConfig,
): BoosterRoleEvaluation {
  const tiers = activeTiers(config);
  const held = tiers.filter((tier) => member.roles.cache.has(tier.role_id));

  if (!premiumSince) {
    return { toAdd: [], toRemove: held.map((tier) => tier.role_id) };
  }

  const days = boostDurationDays(premiumSince);
  const qualifying = tiers.filter((tier) => days >= tier.duration_days);

  if (qualifying.length === 0) {
    return { toAdd: [], toRemove: held.map((tier) => tier.role_id) };
  }

  const wanted = config.stacking ? qualifying : [qualifying[qualifying.length - 1]];
  const wantedIds = new Set(wanted.map((tier) => tier.role_id));

  const toAdd = wanted.filter((tier) => !member.roles.cache.has(tier.role_id)).map((tier) => tier.role_id);
  const toRemove = held.filter((tier) => !wantedIds.has(tier.role_id)).map((tier) => tier.role_id);

  return { toAdd, toRemove };
}

/** Evaluate and actually add/remove the roles on Discord. Safe to call repeatedly — a no-op diff does nothing. */
export async function syncBoosterRoles(member: GuildMember, config: BoosterRolesConfig): Promise<BoosterRoleEvaluation> {
  const evaluation = evaluateBoosterRoles(member, member.premiumSince, config);
  if (evaluation.toAdd.length > 0) {
    await member.roles.add(evaluation.toAdd).catch(() => null);
  }
  if (evaluation.toRemove.length > 0) {
    await member.roles.remove(evaluation.toRemove).catch(() => null);
  }
  return evaluation;
}
