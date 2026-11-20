import { loadEconomyConfig } from "../../economy/functions/config.js";
import { createSeed, poolHash, verifyDraw, type WeightedEntrant } from "./fairness.js";
import * as store from "./store.js";
import type { Giveaway, GiveawayDraw, WinnerStatus } from "./store.js";

export { weightedPick } from "./fairness.js";
export type { WeightedEntrant } from "./fairness.js";

/** Credits the giveaway's win bonus, only while Economy is enabled. Never throws. */
async function payWinBonus(giveaway: Giveaway, userId: string): Promise<void> {
  if (giveaway.winBonus <= 0) return;
  try {
    if (!(await loadEconomyConfig(giveaway.guildId))) return;
    const { creditServer } = await import("../../economy/functions/money.js");
    creditServer(giveaway.guildId, userId, giveaway.winBonus);
  } catch {
    // Economy unavailable or errored: never block a draw or claim on it.
  }
}

async function loadPool(giveawayId: number): Promise<WeightedEntrant[]> {
  return (await store.listEntries(giveawayId)).map((e) => ({ userId: e.userId, weight: e.weight }));
}

function totalOf(pool: WeightedEntrant[]): number {
  return Math.round(pool.reduce((sum, e) => sum + (Number.isFinite(e.weight) ? e.weight : 0), 0) * 1000) / 1000;
}

export type DrawResult = { winnerIds: string[]; draw: GiveawayDraw | null; alreadyDrawn: boolean };

/**
 * The giveaway's one and only initial draw. Safe to call any number of times (two ticks, a restart
 * mid-end, a dashboard click racing the poller): once a draw exists, later calls return its
 * winners instead of drawing again.
 */
export async function drawWinners(giveaway: Giveaway, actorId: string | null = null): Promise<DrawResult> {
  const existing = await store.getInitialDraw(giveaway.id);
  if (existing) return { winnerIds: existing.pickedUserIds, draw: existing, alreadyDrawn: true };

  const pool = await loadPool(giveaway.id);
  const seed = createSeed();
  const picks = verifyDraw(seed, pool, Math.max(1, giveaway.winnerCount));
  const recorded = store.recordDraw({
    giveawayId: giveaway.id,
    kind: "draw",
    seed,
    poolHash: poolHash(pool),
    poolSize: pool.length,
    totalWeight: totalOf(pool),
    pickedUserIds: picks,
    actorId,
  });
  if (!recorded) {
    const raced = await store.getInitialDraw(giveaway.id);
    return { winnerIds: raced?.pickedUserIds ?? [], draw: raced, alreadyDrawn: true };
  }

  // No claim window means no claim step, so the bonus is paid on the draw itself.
  if (giveaway.claimWindowMinutes <= 0) {
    for (const userId of picks) await payWinBonus(giveaway, userId);
  }
  return { winnerIds: picks, draw: recorded.draw, alreadyDrawn: false };
}

export type RerollResult = { oldWinnerIds: string[]; newWinnerIds: string[]; draw: GiveawayDraw | null };

/**
 * Replaces winners with fresh draws from the same pool. `winnerRowIds: null` rerolls every current
 * winner; otherwise only those rows. Nobody who has ever won this giveaway can be drawn again.
 * Each retired row is changed only while it's still current, so two rerolls at once can't both
 * replace the same winner.
 */
export async function rerollWinners(
  giveaway: Giveaway,
  winnerRowIds: number[] | null,
  options: { kind?: "reroll" | "auto_reroll"; actorId?: string | null; oldStatus?: WinnerStatus } = {},
): Promise<RerollResult> {
  const kind = options.kind ?? "reroll";
  const oldStatus = options.oldStatus ?? "rerolled";
  const all = await store.listWinners(giveaway.id);
  const eligible = all.filter((w) => (kind === "auto_reroll" ? w.status === "won" : w.status === "won" || w.status === "claimed"));
  const targets = winnerRowIds === null ? eligible : eligible.filter((w) => winnerRowIds.includes(w.id));

  const now = new Date();
  const retired: store.GiveawayWinner[] = [];
  for (const winner of targets) {
    if (await store.retireWinnerRow(winner.id, oldStatus, now, kind === "auto_reroll" ? ["won"] : ["won", "claimed"])) retired.push(winner);
  }
  const oldWinnerIds = retired.map((w) => w.userId);
  if (!retired.length) return { oldWinnerIds, newWinnerIds: [], draw: null };

  const everWon = new Set(all.map((w) => w.userId));
  const pool = await loadPool(giveaway.id);
  const seed = createSeed();
  const picks = verifyDraw(seed, pool, retired.length, everWon);
  const replaces = new Map<string, number | null>(picks.map((userId, i) => [userId, retired[i]?.id ?? null]));
  const recorded = store.recordDraw(
    {
      giveawayId: giveaway.id,
      kind,
      seed,
      poolHash: poolHash(pool),
      poolSize: pool.length,
      totalWeight: totalOf(pool),
      pickedUserIds: picks,
      replacedUserIds: oldWinnerIds,
      actorId: options.actorId ?? null,
    },
    { selectedAt: now, replaces },
  );

  if (giveaway.claimWindowMinutes <= 0) {
    for (const userId of picks) await payWinBonus(giveaway, userId);
  }
  return { oldWinnerIds, newWinnerIds: picks, draw: recorded?.draw ?? null };
}

/** One winner by row id; kept for callers that reroll a single winner. */
export async function rerollWinner(giveaway: Giveaway, winnerRowId: number | null, oldStatus: WinnerStatus = "rerolled"): Promise<RerollResult> {
  return rerollWinners(giveaway, winnerRowId === null ? null : [winnerRowId], { oldStatus });
}

export function claimDeadline(giveaway: Pick<Giveaway, "claimWindowMinutes">, selectedAt: Date): Date | null {
  return giveaway.claimWindowMinutes > 0 ? new Date(selectedAt.getTime() + giveaway.claimWindowMinutes * 60_000) : null;
}

export type ClaimResult = { ok: true } | { ok: false; reason: "not_winner" | "already_claimed" | "expired" };

export async function claimWinner(giveaway: Giveaway, userId: string): Promise<ClaimResult> {
  const rows = (await store.listWinners(giveaway.id)).filter((w) => w.userId === userId);
  const winner = rows.find((w) => w.status === "won");
  if (!winner) return { ok: false, reason: rows.some((w) => w.status === "claimed") ? "already_claimed" : rows.length ? "expired" : "not_winner" };
  // Past the claim window the prize is gone, even before the sweep rerolls it.
  const deadline = claimDeadline(giveaway, winner.selectedAt);
  if (deadline && Date.now() > deadline.getTime()) return { ok: false, reason: "expired" };
  if (!(await store.claimWinnerRow(winner.id, new Date()))) return { ok: false, reason: "already_claimed" };

  await payWinBonus(giveaway, userId);
  await store.addEvent(giveaway.id, "claimed", userId).catch(() => null);
  return { ok: true };
}

/** Every "won" row past its claim deadline becomes "expired_unclaimed" and gets one replacement. */
export async function expireUnclaimedWinners(giveaway: Giveaway, now: Date = new Date()): Promise<RerollResult> {
  if (giveaway.claimWindowMinutes <= 0) return { oldWinnerIds: [], newWinnerIds: [], draw: null };
  const expired = (await store.listWinners(giveaway.id)).filter((w) => {
    if (w.status !== "won") return false;
    const deadline = claimDeadline(giveaway, w.selectedAt);
    return deadline !== null && now.getTime() >= deadline.getTime();
  });
  if (!expired.length) return { oldWinnerIds: [], newWinnerIds: [], draw: null };
  return rerollWinners(
    giveaway,
    expired.map((w) => w.id),
    { kind: "auto_reroll", oldStatus: "expired_unclaimed" },
  );
}
