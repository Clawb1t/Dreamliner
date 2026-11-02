import type { TeamRank } from "../../../config/schemas/teamControl.js";
import type { TeamActionType } from "./config.js";

/**
 * Rank authority, kept free of Discord so it can be tested. An actor may act on a target only when
 * they bypass (owner, Administrator or Manage Server) or outrank them, and may only promote to a
 * rank strictly below their own. Rank indexes count from 0 (the lowest rank); -1 = not on the team.
 */
export type AuthorityActor = { bypass: boolean; rankIndex: number; userId: string };

export type AuthorityResult = { ok: true } | { ok: false; error: string };

/** The highest rank whose role the member holds, or -1. */
export function rankIndexForRoles(ranks: TeamRank[], roleIds: Iterable<string>): number {
  const held = roleIds instanceof Set ? (roleIds as Set<string>) : new Set(roleIds);
  for (let i = ranks.length - 1; i >= 0; i--) {
    const roleId = ranks[i]!.role_id;
    if (roleId && held.has(roleId)) return i;
  }
  return -1;
}

export function rankIndexById(ranks: TeamRank[], rankId: string | null | undefined): number {
  if (!rankId) return -1;
  return ranks.findIndex((rank) => rank.id === rankId);
}

/** Whether `actor` can take `type` on a target at `targetIndex` (moving them to `toIndex` for promotions and demotions). */
export function checkAuthority(
  actor: AuthorityActor,
  targetUserId: string,
  targetIndex: number,
  type: TeamActionType,
  ranks: TeamRank[],
  toIndex?: number,
): AuthorityResult {
  if (actor.userId === targetUserId && !actor.bypass) {
    return { ok: false, error: "You can't take staff actions on yourself." };
  }
  if (!actor.bypass) {
    if (actor.rankIndex < 0) return { ok: false, error: "Only staff with a rank (or Manage Server) can do that." };
    if (targetIndex >= actor.rankIndex) {
      const name = ranks[targetIndex]?.name ?? "their rank";
      return { ok: false, error: `You can only act on staff ranked below you. They're **${name}**, the same as or above your rank.` };
    }
    if (type === "promotion" && toIndex !== undefined && toIndex >= actor.rankIndex) {
      return { ok: false, error: `You can only promote staff to ranks below your own (**${ranks[actor.rankIndex]?.name ?? "your rank"}**).` };
    }
  }
  return { ok: true };
}

export type RankMove = { ok: true; toIndex: number } | { ok: false; error: string };

/** Where a promotion or demotion takes the member: the named rank, else one step. */
export function resolveRankMove(ranks: TeamRank[], type: "promotion" | "demotion", currentIndex: number, rankId?: string | null): RankMove {
  if (ranks.length === 0) return { ok: false, error: "This server has no ranks set up yet. Add them on the dashboard." };
  if (rankId) {
    const toIndex = rankIndexById(ranks, rankId);
    if (toIndex < 0) return { ok: false, error: "That rank doesn't exist." };
    if (!ranks[toIndex]!.role_id) return { ok: false, error: `The **${ranks[toIndex]!.name}** rank has no role linked yet.` };
    if (type === "promotion" && toIndex <= currentIndex) {
      return { ok: false, error: `**${ranks[toIndex]!.name}** isn't above their current rank. Use a demotion instead.` };
    }
    if (type === "demotion") {
      if (currentIndex < 0) return { ok: false, error: "They aren't on the team." };
      if (toIndex >= currentIndex) return { ok: false, error: `**${ranks[toIndex]!.name}** isn't below their current rank.` };
    }
    return { ok: true, toIndex };
  }
  if (type === "promotion") {
    const toIndex = currentIndex + 1;
    if (toIndex >= ranks.length) return { ok: false, error: "They're already at the highest rank." };
    if (!ranks[toIndex]!.role_id) return { ok: false, error: `The **${ranks[toIndex]!.name}** rank has no role linked yet.` };
    return { ok: true, toIndex };
  }
  if (currentIndex < 0) return { ok: false, error: "They aren't on the team." };
  if (currentIndex === 0) return { ok: false, error: "They're already at the lowest rank. Use a termination to remove them from the team." };
  const toIndex = currentIndex - 1;
  if (!ranks[toIndex]!.role_id) return { ok: false, error: `The **${ranks[toIndex]!.name}** rank has no role linked yet.` };
  return { ok: true, toIndex };
}
