import * as store from "./store.js";
import type { Giveaway, WinnerStatus } from "./store.js";

export type WeightedEntrant = { userId: string; weight: number };

/** Cumulative-weight sampling without replacement. Zero/negative weights never win. */
export function weightedPick(entries: WeightedEntrant[], count: number, exclude: Set<string>): string[] {
  const pool = entries.filter((e) => !exclude.has(e.userId) && e.weight > 0);
  const picks: string[] = [];

  while (picks.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((sum, e) => sum + e.weight, 0);
    if (totalWeight <= 0) break;

    const target = Math.random() * totalWeight;
    let cumulative = 0;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      cumulative += pool[i]!.weight;
      if (target < cumulative) {
        index = i;
        break;
      }
    }

    picks.push(pool[index]!.userId);
    pool.splice(index, 1);
  }

  return picks;
}

export async function drawWinners(giveaway: Giveaway): Promise<string[]> {
  const entries = await store.listEntries(giveaway.id);
  const picks = weightedPick(
    entries.map((e) => ({ userId: e.userId, weight: e.weight })),
    giveaway.winnerCount,
    new Set(),
  );

  const now = new Date();
  for (const userId of picks) {
    await store.insertWinner({ giveawayId: giveaway.id, userId, status: "won", selectedAt: now, replacesWinnerId: null });
  }

  return picks;
}

export type RerollResult = { oldWinnerIds: string[]; newWinnerIds: string[] };

/**
 * `winnerRowId: null` rerolls every current "won" row for this giveaway (no 1:1 replacement
 * mapping, per the product decision, see the plan). A specific `winnerRowId` rerolls just that
 * one, with the new winner's `replacesWinnerId` pointing back at it. `oldStatus` lets
 * `expireUnclaimedWinners` reuse this same draw path while marking the lapsed row
 * "expired_unclaimed" instead of "rerolled".
 */
export async function rerollWinner(
  giveaway: Giveaway,
  winnerRowId: number | null,
  oldStatus: WinnerStatus = "rerolled",
): Promise<RerollResult> {
  const now = new Date();
  let oldWinnerIds: string[];
  let drawCount: number;

  if (winnerRowId === null) {
    const current = await store.listWinnersByStatus(giveaway.id, "won");
    for (const winner of current) {
      await store.updateWinner(winner.id, { status: oldStatus, rerolledAt: now });
    }
    oldWinnerIds = current.map((w) => w.userId);
    drawCount = current.length;
  } else {
    const all = await store.listWinners(giveaway.id);
    const winner = all.find((w) => w.id === winnerRowId);
    if (!winner) return { oldWinnerIds: [], newWinnerIds: [] };
    await store.updateWinner(winner.id, { status: oldStatus, rerolledAt: now });
    oldWinnerIds = [winner.userId];
    drawCount = 1;
  }

  if (drawCount === 0) return { oldWinnerIds, newWinnerIds: [] };

  const pastWinnerIds = new Set((await store.listWinners(giveaway.id)).map((w) => w.userId));
  const entries = await store.listEntries(giveaway.id);
  const newWinnerIds = weightedPick(
    entries.map((e) => ({ userId: e.userId, weight: e.weight })),
    drawCount,
    pastWinnerIds,
  );

  for (const userId of newWinnerIds) {
    await store.insertWinner({
      giveawayId: giveaway.id,
      userId,
      status: "won",
      selectedAt: now,
      replacesWinnerId: winnerRowId,
    });
  }

  return { oldWinnerIds, newWinnerIds };
}

export async function claimWinner(giveawayId: number, userId: string): Promise<boolean> {
  const wonWinners = await store.listWinnersByStatus(giveawayId, "won");
  const winner = wonWinners.find((w) => w.userId === userId);
  if (!winner) return false;
  await store.updateWinner(winner.id, { status: "claimed", claimedAt: new Date() });
  return true;
}

/** Marks any "won" row past its claim deadline "expired_unclaimed" and draws one replacement
 *  per expired row, via the same single-winner reroll path `/giveaway reroll [winner]` uses. */
export async function expireUnclaimedWinners(giveaway: Giveaway): Promise<void> {
  if (giveaway.claimWindowMinutes <= 0) return;

  const wonWinners = await store.listWinnersByStatus(giveaway.id, "won");
  const nowMs = Date.now();

  for (const winner of wonWinners) {
    const deadline = winner.selectedAt.getTime() + giveaway.claimWindowMinutes * 60_000;
    if (nowMs < deadline) continue;
    await rerollWinner(giveaway, winner.id, "expired_unclaimed");
  }
}
