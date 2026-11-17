import { eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardCopies, planeCardSetCompletions, planeCardTypes, planeCardUserState } from "../../../db/schema.js";
import {
  COMPLETED_SET_POINTS,
  DISTINCT_CARD_POINTS,
  SCORE_VERSION,
  copyPoints,
  pilotRankFor,
} from "./constants.js";
import { grantParts } from "./ledger.js";
import { isSetComplete, listSets, listUserCompletions, type SetWithMembers } from "./sets.js";
import { ensureUserState, updateUserState } from "./state.js";

export type ScoreCopy = { id: number; cardTypeId: number; rarity: string; livery: string; firstEdition: boolean; level: number };

export type FleetScore = {
  fleetValue: number;
  copiesValue: number;
  distinctCards: number;
  distinctBonus: number;
  setsCompleted: number;
  setsBonus: number;
  copies: number;
  mythics: number;
  rarestPoints: number;
  rarestCopyId: number | null;
  completedSetIds: number[];
};

/** Pure Fleet Value: copies by rarity x livery x edition x level, plus distinct-card and set bonuses. */
export function computeFleetScore(copies: ScoreCopy[], sets: SetWithMembers[]): FleetScore {
  let copiesValue = 0;
  let rarestPoints = 0;
  let rarestCopyId: number | null = null;
  let mythics = 0;
  const owned = new Set<number>();
  for (const copy of copies) {
    const points = copyPoints(copy.rarity, copy.livery, copy.firstEdition, copy.level);
    copiesValue += points;
    owned.add(copy.cardTypeId);
    if (copy.rarity === "mythic") mythics++;
    if (points > rarestPoints || (points === rarestPoints && rarestCopyId !== null && copy.id < rarestCopyId)) {
      rarestPoints = points;
      rarestCopyId = copy.id;
    }
  }
  const completedSetIds = sets.filter((set) => set.enabled && isSetComplete(set, owned)).map((set) => set.id);
  const distinctBonus = owned.size * DISTINCT_CARD_POINTS;
  const setsBonus = completedSetIds.length * COMPLETED_SET_POINTS;
  return {
    fleetValue: copiesValue + distinctBonus + setsBonus,
    copiesValue,
    distinctCards: owned.size,
    distinctBonus,
    setsCompleted: completedSetIds.length,
    setsBonus,
    copies: copies.length,
    mythics,
    rarestPoints,
    rarestCopyId,
    completedSetIds,
  };
}

export function loadScoreCopies(userId: string): ScoreCopy[] {
  return getDb()
    .select({
      id: planeCardCopies.id,
      cardTypeId: planeCardCopies.cardTypeId,
      rarity: planeCardTypes.rarity,
      livery: planeCardCopies.livery,
      firstEdition: planeCardCopies.firstEdition,
      level: planeCardCopies.level,
    })
    .from(planeCardCopies)
    .innerJoin(planeCardTypes, eq(planeCardTypes.id, planeCardCopies.cardTypeId))
    .where(eq(planeCardCopies.ownerId, userId))
    .all();
}

export type RefreshResult = FleetScore & { newlyCompletedSets: { setId: number; name: string; bonusParts: number }[] };

/**
 * Recomputes a user's cached score columns and pays any first-time set completion bonus. Called
 * after every change to a collection (inside the same transaction as the change).
 */
export function refreshUserScore(userId: string): RefreshResult {
  ensureUserState(userId);
  const sets = listSets();
  const score = computeFleetScore(loadScoreCopies(userId), sets);
  const completions = listUserCompletions(userId);
  const newlyCompletedSets: RefreshResult["newlyCompletedSets"] = [];
  const now = new Date();
  for (const setId of score.completedSetIds) {
    if (completions.has(setId)) continue;
    const set = sets.find((s) => s.id === setId)!;
    getDb().insert(planeCardSetCompletions).values({ userId, setId, completedAt: now }).onConflictDoNothing().run();
    if (set.bonusParts > 0) grantParts(userId, set.bonusParts, "set_bonus", { ref: `set:${setId}` });
    newlyCompletedSets.push({ setId, name: set.name, bonusParts: set.bonusParts });
  }
  updateUserState(userId, {
    fleetValue: score.fleetValue,
    setsCompleted: score.setsCompleted,
    distinctCards: score.distinctCards,
    copiesCount: score.copies,
    mythicsOwned: score.mythics,
    rarestPoints: score.rarestPoints,
    rarestCopyId: score.rarestCopyId,
    scoreVersion: SCORE_VERSION,
  });
  return { ...score, newlyCompletedSets };
}

/** Recomputes every stale state row (formula change, or rows written by the migration). */
export function refreshStaleScores(limit = 5000): number {
  const rows = getDb()
    .select({ userId: planeCardUserState.userId })
    .from(planeCardUserState)
    .where(or(lt(planeCardUserState.scoreVersion, SCORE_VERSION)))
    .limit(limit)
    .all();
  // Owners with copies but no state row at all (shouldn't happen, but cheap to cover).
  const orphans = getDb().all<{ owner_id: string }>(
    sql`SELECT DISTINCT owner_id FROM plane_card_copies WHERE owner_id NOT IN (SELECT user_id FROM plane_card_user_state) LIMIT ${limit}`,
  );
  const ids = new Set([...rows.map((r) => r.userId), ...orphans.map((r) => r.owner_id)]);
  for (const userId of ids) getDb().transaction(() => refreshUserScore(userId));
  return ids.size;
}

export function pilotRankView(fleetValue: number) {
  const { rank, next, progress } = pilotRankFor(fleetValue);
  return {
    key: rank.key,
    label: rank.label,
    color: rank.color,
    minFleetValue: rank.minFleetValue,
    next: next ? { key: next.key, label: next.label, minFleetValue: next.minFleetValue } : null,
    progress: Math.round(progress * 1000) / 1000,
    /** Free profile title the rank unlocks (cosmetics shape: { text, color }). */
    title: { text: rank.label, color: rank.color },
  };
}
