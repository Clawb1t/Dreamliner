import type { Guild, GuildMember } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { isBoosting } from "../../../core/boosterStatus.js";
import * as store from "./store.js";
import type { Giveaway } from "./store.js";

const DAY_MS = 86_400_000;

export type EntryCheckResult = { ok: true } | { ok: false; reason: string };

export function checkEntryRequirements(member: GuildMember, giveaway: Giveaway): EntryCheckResult {
  const hasBypass = giveaway.bypassRoleIds.some((id) => member.roles.cache.has(id));
  const hasBlacklist = giveaway.blacklistRoleIds.some((id) => member.roles.cache.has(id));

  if (hasBlacklist && !hasBypass) {
    return { ok: false, reason: "You have a role that's blocked from entering this giveaway." };
  }
  if (hasBypass) return { ok: true };

  if (giveaway.requireRoleIds.length > 0) {
    const matches = giveaway.requireRoleIds.filter((id) => member.roles.cache.has(id));
    const satisfied = giveaway.requireRoleMode === "all" ? matches.length === giveaway.requireRoleIds.length : matches.length > 0;
    if (!satisfied) {
      return { ok: false, reason: "You don't have the role(s) required to enter this giveaway." };
    }
  }

  if (giveaway.minAccountAgeDays > 0) {
    const ageMs = Date.now() - member.user.createdTimestamp;
    if (ageMs < giveaway.minAccountAgeDays * DAY_MS) {
      return { ok: false, reason: `Your Discord account must be at least ${giveaway.minAccountAgeDays} day(s) old to enter.` };
    }
  }

  if (giveaway.minJoinAgeDays > 0 && member.joinedTimestamp) {
    const ageMs = Date.now() - member.joinedTimestamp;
    if (ageMs < giveaway.minJoinAgeDays * DAY_MS) {
      return { ok: false, reason: `You must have been in this server for at least ${giveaway.minJoinAgeDays} day(s) to enter.` };
    }
  }

  return { ok: true };
}

/**
 * `guildConfig` is accepted for API symmetry with the plan's spec and future guild-level bonus
 * rules, but every input this needs today is already snapshotted on the giveaway row itself.
 */
export function computeEntryWeight(member: GuildMember, giveaway: Giveaway, _guildConfig?: GuildConfig): number {
  const matches = giveaway.bonusRoleWeights.filter((bw) => member.roles.cache.has(bw.roleId));
  const base = matches.length > 0 ? Math.max(...matches.map((bw) => bw.weight)) : 1;
  const boosterBonus = isBoosting(member) ? giveaway.boosterBonusWeight : 0;
  return base + boosterBonus;
}

export type EnterResult = { ok: true; entered: boolean } | { ok: false; reason: string };

export async function enterGiveaway(guild: Guild, giveaway: Giveaway, userId: string): Promise<EnterResult> {
  if (giveaway.status !== "active") {
    return { ok: false, reason: "This giveaway is not currently active." };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    return { ok: false, reason: "Could not resolve you as a member of this server." };
  }

  const check = checkEntryRequirements(member, giveaway);
  if (!check.ok) return check;

  const existing = await store.getEntry(giveaway.id, userId);
  if (existing) {
    return { ok: true, entered: false };
  }

  if (giveaway.entryCost > 0) {
    try {
      const { spendServer, InsufficientFundsError } = await import("../../economy/functions/money.js");
      try {
        spendServer(guild.id, userId, giveaway.entryCost);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          return { ok: false, reason: `You need ${giveaway.entryCost} to enter this giveaway.` };
        }
        throw error;
      }
    } catch {
      // Economy unavailable, disabled, or errored for an unrelated reason - never block entry on it.
    }
  }

  const weight = computeEntryWeight(member, giveaway);
  await store.addEntry({ giveawayId: giveaway.id, userId, weight });
  return { ok: true, entered: true };
}

export async function leaveGiveaway(giveawayId: number, userId: string): Promise<boolean> {
  return store.removeEntry(giveawayId, userId);
}
