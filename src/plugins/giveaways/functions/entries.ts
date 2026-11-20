import type { Guild, GuildMember } from "discord.js";
import { isBoosting } from "../../../core/boosterStatus.js";
import { loadEconomyConfig } from "../../economy/functions/config.js";
import { formatServer } from "../../economy/functions/format.js";
import { checkPassportRequirement } from "../../../core/verifiedOnly.js";
import { getGuildMessageCount } from "../../utility/functions/messageCounts.js";
import { defaultTranslator, translatorFor, type Translator } from "../../../i18n/index.js";
import * as store from "./store.js";
import type { Giveaway } from "./store.js";

const DAY_MS = 86_400_000;

export type EntryCheckResult = { ok: true } | { ok: false; reason: string };

type MemberLike = Pick<GuildMember, "joinedTimestamp" | "premiumSinceTimestamp"> & {
  roles: { cache: { has: (id: string) => boolean } };
  user: { createdTimestamp: number };
};

export function hasBypass(member: MemberLike, giveaway: Pick<Giveaway, "bypassRoleIds">): boolean {
  return giveaway.bypassRoleIds.some((id) => member.roles.cache.has(id));
}

/**
 * The role and age gates (everything that doesn't need a lookup). Blocked roles win over bypass
 * roles only when the member has no bypass role; bypass roles skip every other check.
 */
export function checkEntryRequirements(member: MemberLike, giveaway: Giveaway, t: Translator = defaultTranslator, now = Date.now()): EntryCheckResult {
  const bypass = hasBypass(member, giveaway);
  const blocked = giveaway.blacklistRoleIds.some((id) => member.roles.cache.has(id));

  if (blocked && !bypass) {
    return { ok: false, reason: t("giveaways.req.blockedRole", "You have a role that can't enter this giveaway.") };
  }
  if (bypass) return { ok: true };

  if (giveaway.requireRoleIds.length > 0) {
    const matches = giveaway.requireRoleIds.filter((id) => member.roles.cache.has(id));
    const satisfied = giveaway.requireRoleMode === "all" ? matches.length === giveaway.requireRoleIds.length : matches.length > 0;
    if (!satisfied) {
      const roles = giveaway.requireRoleIds.map((id) => `<@&${id}>`).join(", ");
      return {
        ok: false,
        reason:
          giveaway.requireRoleMode === "all"
            ? t("giveaways.req.rolesAll", "You need all of these roles to enter: {roles}", { roles })
            : t("giveaways.req.rolesAny", "You need one of these roles to enter: {roles}", { roles }),
      };
    }
  }

  if (giveaway.minAccountAgeDays > 0 && now - member.user.createdTimestamp < giveaway.minAccountAgeDays * DAY_MS) {
    return {
      ok: false,
      reason: t("giveaways.req.accountAge", "Your Discord account must be at least {days} day(s) old to enter.", { days: giveaway.minAccountAgeDays }),
    };
  }

  if (giveaway.minJoinAgeDays > 0) {
    const joined = member.joinedTimestamp ?? now;
    if (now - joined < giveaway.minJoinAgeDays * DAY_MS) {
      return {
        ok: false,
        reason: t("giveaways.req.joinAge", "You need to have been in this server for at least {days} day(s) to enter.", { days: giveaway.minJoinAgeDays }),
      };
    }
  }

  return { ok: true };
}

/**
 * Entries a member gets: the highest bonus role they have (or 1), plus the booster bonus. Stored
 * on the entry when they join, so changing the bonuses later only affects new entries.
 */
export function computeEntryWeight(member: MemberLike, giveaway: Pick<Giveaway, "bonusRoleWeights" | "boosterBonusWeight">): number {
  const matches = giveaway.bonusRoleWeights.filter((bw) => bw.roleId && member.roles.cache.has(bw.roleId) && Number.isFinite(bw.weight));
  const base = matches.length > 0 ? Math.max(...matches.map((bw) => bw.weight)) : 1;
  const boosterBonus = isBoosting(member as GuildMember) ? Math.max(0, giveaway.boosterBonusWeight || 0) : 0;
  return Math.max(0, Math.round((base + boosterBonus) * 1000) / 1000);
}

/** Every check, including the ones that need a lookup (blacklist, message count, Passport). */
export async function checkEligibility(member: GuildMember, giveaway: Giveaway, t: Translator): Promise<EntryCheckResult> {
  if (await store.isBlacklisted(giveaway.guildId, member.id)) {
    return { ok: false, reason: t("giveaways.req.blacklisted", "Staff have blocked you from entering giveaways in this server.") };
  }
  const basic = checkEntryRequirements(member, giveaway, t);
  if (!basic.ok) return basic;
  if (hasBypass(member, giveaway)) return { ok: true };

  if (giveaway.minMessages > 0) {
    const sent = await getGuildMessageCount(giveaway.guildId, member.id);
    if (sent < giveaway.minMessages) {
      return {
        ok: false,
        reason: t("giveaways.req.messages", "You need at least {min} messages in this server to enter (you have {count}).", {
          min: giveaway.minMessages.toLocaleString("en-US"),
          count: sent.toLocaleString("en-US"),
        }),
      };
    }
  }

  if (giveaway.requirePassport) {
    const passport = await checkPassportRequirement(member, true, t);
    if (!passport.ok) return { ok: false, reason: passport.message };
  }
  return { ok: true };
}

export type EnterResult =
  | { ok: true; action: "entered"; weight: number; paid: number }
  | { ok: true; action: "left"; refunded: number }
  | { ok: true; action: "already" }
  | { ok: false; reason: string };

/**
 * Enters a member, or (with `toggle`) takes them out again when they're already in. Leaving
 * refunds whatever they paid to enter.
 */
export async function enterGiveaway(guild: Guild, giveaway: Giveaway, userId: string, options: { toggle?: boolean } = {}): Promise<EnterResult> {
  const { t } = await translatorFor(userId);
  if (giveaway.status !== "active") {
    return {
      ok: false,
      reason:
        giveaway.status === "paused"
          ? t("giveaways.enter.paused", "This giveaway is paused. Entries open again when staff resume it.")
          : t("giveaways.enter.notActive", "This giveaway isn't open for entries."),
    };
  }

  const existing = await store.getEntry(giveaway.id, userId);
  if (existing) {
    if (!options.toggle) return { ok: true, action: "already" };
    const refunded = await leaveGiveaway(giveaway, userId);
    return { ok: true, action: "left", refunded };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, reason: t("giveaways.enter.noMember", "Couldn't find you in this server.") };

  const check = await checkEligibility(member, giveaway, t);
  if (!check.ok) return check;

  // The entry cost only applies while Economy is on.
  let paid = 0;
  const economy = giveaway.entryCost > 0 ? await loadEconomyConfig(guild.id).catch(() => null) : null;
  if (economy) {
    try {
      const { spendServer, InsufficientFundsError } = await import("../../economy/functions/money.js");
      try {
        spendServer(guild.id, userId, giveaway.entryCost);
        paid = giveaway.entryCost;
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          return { ok: false, reason: t("giveaways.enter.cost", "You need {cost} to enter this giveaway.", { cost: formatServer(giveaway.entryCost, economy.server) }) };
        }
        throw error;
      }
    } catch {
      // Economy unavailable or errored for an unrelated reason: never block entry on it.
    }
  }

  const weight = computeEntryWeight(member, giveaway);
  await store.addEntry({ giveawayId: giveaway.id, userId, weight, paid });
  return { ok: true, action: "entered", weight, paid };
}

/** Takes a member out of a giveaway, refunding their entry cost. Returns the amount refunded. */
export async function leaveGiveaway(giveaway: Giveaway, userId: string): Promise<number> {
  const removed = await store.removeEntry(giveaway.id, userId);
  if (!removed || removed.paid <= 0) return 0;
  try {
    const { creditServer } = await import("../../economy/functions/money.js");
    creditServer(giveaway.guildId, userId, removed.paid);
    return removed.paid;
  } catch {
    return 0;
  }
}
