import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardCopies, planeCardCopyEvents, planeCardMintCounters, planeCardTypes } from "../../../db/schema.js";
import { getPlaneTypeById, type PlaneTypeRow } from "../functions/catalog.js";
import {
  FIRST_EDITION_MAX_SERIAL,
  HANGAR_MAX_SLOTS,
  HANGAR_SLOT_STEP,
  HANGAR_SLOT_STEP_PRICE,
  LIVERIES,
  MAX_LEVEL,
  LEVEL_XP,
  REPAINT_LIVERY_ODDS,
  RARITY_META,
  SHOWCASE_MAX,
  craftCost,
  levelForXp,
  liveryIndex,
  salvageValue,
  upgradeCost,
  type Livery,
  type Rarity,
} from "./constants.js";
import { hangarError } from "./errors.js";
import { burnCoins, grantParts, inTx, spendParts } from "./ledger.js";
import { defaultRng, weightedPick, type Rng } from "./random.js";
import { refreshUserScore } from "./score.js";
import { ensureUserState, getUserState, parseShowcase, updateUserState } from "./state.js";

export type CopyRow = typeof planeCardCopies.$inferSelect;
export type ObtainedVia = "pack" | "boarding_pass" | "craft" | "trade" | "market" | "gift" | "flight" | "migration";
export type LockReason = "listing" | "trade" | "flight";

function now(): Date {
  return new Date();
}

export function getCopy(id: number): CopyRow | null {
  return getDb().select().from(planeCardCopies).where(eq(planeCardCopies.id, id)).get() ?? null;
}

export function getCopies(ids: number[]): CopyRow[] {
  if (ids.length === 0) return [];
  return getDb().select().from(planeCardCopies).where(inArray(planeCardCopies.id, ids)).all();
}

export function countUserCopies(userId: string): number {
  return getDb().select({ n: count() }).from(planeCardCopies).where(eq(planeCardCopies.ownerId, userId)).get()?.n ?? 0;
}

export function listUserCopies(userId: string): CopyRow[] {
  return getDb().select().from(planeCardCopies).where(eq(planeCardCopies.ownerId, userId)).orderBy(asc(planeCardCopies.id)).all();
}

export function ownedCardTypeIds(userId: string): Set<number> {
  const rows = getDb()
    .selectDistinct({ id: planeCardCopies.cardTypeId })
    .from(planeCardCopies)
    .where(eq(planeCardCopies.ownerId, userId))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** How many copies of a card type have been minted so far. */
export function mintedCount(cardTypeId: number): number {
  const row = getDb().select().from(planeCardMintCounters).where(eq(planeCardMintCounters.cardTypeId, cardTypeId)).get();
  return row ? row.nextSerial - 1 : 0;
}

export function mintedCounts(): Map<number, number> {
  return new Map(getDb().select().from(planeCardMintCounters).all().map((r) => [r.cardTypeId, r.nextSerial - 1]));
}

export function logCopyEvent(
  copyId: number,
  kind: string,
  fromUserId: string | null,
  toUserId: string | null,
  detail?: Record<string, unknown>,
): void {
  getDb()
    .insert(planeCardCopyEvents)
    .values({ copyId, kind, fromUserId, toUserId, detail: detail ? JSON.stringify(detail) : null, createdAt: now() })
    .run();
}

export function listCopyEvents(copyId: number, limit = 50) {
  return getDb()
    .select()
    .from(planeCardCopyEvents)
    .where(eq(planeCardCopyEvents.copyId, copyId))
    .orderBy(desc(planeCardCopyEvents.id))
    .limit(limit)
    .all();
}

// ── Capacity ─────────────────────────────────────────────────────────────────

export function hangarCapacity(userId: string): { used: number; slots: number; free: number } {
  const slots = ensureUserState(userId).hangarSlots;
  const used = countUserCopies(userId);
  return { used, slots, free: Math.max(0, slots - used) };
}

export function assertCapacity(userId: string, adding: number): void {
  const { used, slots } = hangarCapacity(userId);
  if (used + adding > slots) {
    throw hangarError("hangar_full", "That hangar is full ({used}/{slots}). Salvage some cards or expand the hangar.", { used, slots });
  }
}

/** Throws when a user would hold more than their slots after a swap (trades). */
export function ensureCopyCapacity(userId: string, countAfter: number): void {
  const slots = ensureUserState(userId).hangarSlots;
  if (countAfter > slots) {
    throw hangarError("hangar_full", "That hangar is full ({used}/{slots}). Salvage some cards or expand the hangar.", { used: countAfter, slots });
  }
}

/** Buys HANGAR_SLOT_STEP more slots for HANGAR_SLOT_STEP_PRICE coins (burned). */
export function expandHangar(userId: string): { slots: number; cost: number; balance: number } {
  return inTx(() => {
    const state = ensureUserState(userId);
    if (state.hangarSlots >= HANGAR_MAX_SLOTS) {
      throw hangarError("limit", "Your hangar is already at the maximum of {max} slots.", { max: HANGAR_MAX_SLOTS });
    }
    const slots = Math.min(HANGAR_MAX_SLOTS, state.hangarSlots + HANGAR_SLOT_STEP);
    const balance = burnCoins(userId, HANGAR_SLOT_STEP_PRICE, "hangar_slot", `slots:${slots}`);
    updateUserState(userId, { hangarSlots: slots });
    return { slots, cost: HANGAR_SLOT_STEP_PRICE, balance };
  });
}

// ── Minting ──────────────────────────────────────────────────────────────────

/** Whether a card type can still be minted (not retired, print run not used up). */
export function isMintable(card: PlaneTypeRow, minted = mintedCount(card.id)): boolean {
  if (card.retiredAt) return false;
  return card.printRun == null || minted < card.printRun;
}

/**
 * Mints the next serial of a card type to a user. Enforces the print run atomically and retires the
 * card when its last print is minted. Doesn't check hangar capacity (callers check it up front).
 */
export function mintCopy(input: { cardTypeId: number; ownerId: string; livery: Livery; via: ObtainedVia; detail?: Record<string, unknown> }): CopyRow {
  return inTx(() => {
    const db = getDb();
    const card = getPlaneTypeById(input.cardTypeId);
    if (!card) throw hangarError("not_found", "That card doesn't exist.");
    db.insert(planeCardMintCounters).values({ cardTypeId: card.id, nextSerial: 1 }).onConflictDoNothing().run();
    const counter = db.select().from(planeCardMintCounters).where(eq(planeCardMintCounters.cardTypeId, card.id)).get()!;
    const serial = counter.nextSerial;
    if (card.retiredAt || (card.printRun != null && serial > card.printRun)) {
      throw hangarError("empty_pool", "{name} is sold out.", { name: card.name });
    }
    db.update(planeCardMintCounters).set({ nextSerial: serial + 1 }).where(eq(planeCardMintCounters.cardTypeId, card.id)).run();
    const timestamp = now();
    if (card.printRun != null && serial >= card.printRun) {
      db.update(planeCardTypes).set({ retiredAt: timestamp, updatedAt: timestamp }).where(eq(planeCardTypes.id, card.id)).run();
    }
    const copy = db
      .insert(planeCardCopies)
      .values({
        cardTypeId: card.id,
        ownerId: input.ownerId,
        serial,
        livery: input.livery,
        firstEdition: serial <= FIRST_EDITION_MAX_SERIAL,
        level: 1,
        xp: 0,
        flights: 0,
        obtainedVia: input.via,
        mintedAt: timestamp,
        acquiredAt: timestamp,
      })
      .returning()
      .get();
    logCopyEvent(copy.id, "mint", null, input.ownerId, { via: input.via, livery: input.livery, ...input.detail });
    return copy;
  });
}

// ── Ownership and locks ──────────────────────────────────────────────────────

export function requireCopy(copyId: number): CopyRow {
  const copy = Number.isInteger(copyId) && copyId > 0 ? getCopy(copyId) : null;
  if (!copy) throw hangarError("not_found", "That card copy doesn't exist.");
  return copy;
}

/** Throws unless `userId` owns the copy and it's free (or held by exactly `allowLock`). */
export function assertOwnedFree(copy: CopyRow, userId: string, allowLock?: { reason: LockReason; ref: number }): void {
  if (copy.ownerId !== userId) throw hangarError("not_owner", "You don't own that card.");
  if (copy.lockedReason) {
    if (allowLock && copy.lockedReason === allowLock.reason && copy.lockedRef === allowLock.ref) return;
    throw hangarError("locked", "That card is busy ({reason}).", { reason: copy.lockedReason });
  }
}

export function lockCopy(copyId: number, reason: LockReason, ref: number): void {
  const result = getDb()
    .update(planeCardCopies)
    .set({ lockedReason: reason, lockedRef: ref })
    .where(and(eq(planeCardCopies.id, copyId), sql`${planeCardCopies.lockedReason} IS NULL`))
    .run();
  if (result.changes !== 1) throw hangarError("locked", "That card is busy.");
}

/** Releases a lock, but only the one this caller holds. */
export function unlockCopy(copyId: number, reason: LockReason, ref: number): void {
  getDb()
    .update(planeCardCopies)
    .set({ lockedReason: null, lockedRef: null })
    .where(and(eq(planeCardCopies.id, copyId), eq(planeCardCopies.lockedReason, reason), eq(planeCardCopies.lockedRef, ref)))
    .run();
}

/** Moves a copy to a new owner, clearing its lock. The caller has already validated ownership. */
export function moveCopy(copy: CopyRow, toUserId: string, via: ObtainedVia, detail?: Record<string, unknown>): void {
  const result = getDb()
    .update(planeCardCopies)
    .set({ ownerId: toUserId, lockedReason: null, lockedRef: null, acquiredAt: now(), obtainedVia: via })
    .where(and(eq(planeCardCopies.id, copy.id), eq(planeCardCopies.ownerId, copy.ownerId)))
    .run();
  if (result.changes !== 1) throw hangarError("conflict", "That card changed hands. Try again.");
  logCopyEvent(copy.id, via, copy.ownerId, toUserId, detail);
  dropFromShowcase(copy.ownerId, [copy.id]);
}

function dropFromShowcase(userId: string, copyIds: number[]): void {
  const state = ensureUserState(userId);
  const current = parseShowcase(state.showcase);
  const next = current.filter((id) => !copyIds.includes(id));
  if (next.length !== current.length) updateUserState(userId, { showcase: JSON.stringify(next) });
}

// ── Gift ─────────────────────────────────────────────────────────────────────

export function giveCopy(fromUserId: string, toUserId: string, copyId: number): CopyRow {
  if (fromUserId === toUserId) throw hangarError("invalid", "You can't give a card to yourself.");
  return inTx(() => {
    const copy = requireCopy(copyId);
    assertOwnedFree(copy, fromUserId);
    assertCapacity(toUserId, 1);
    moveCopy(copy, toUserId, "gift");
    refreshUserScore(fromUserId);
    refreshUserScore(toUserId);
    return getCopy(copyId)!;
  });
}

// ── Salvage, craft, repaint, upgrade ─────────────────────────────────────────

export type SalvageResult = { parts: number; balance: number; copies: { id: number; cardTypeId: number; serial: number; parts: number }[] };

export function salvageCopies(userId: string, copyIds: number[]): SalvageResult {
  const ids = [...new Set(copyIds)];
  if (ids.length === 0) throw hangarError("invalid", "Pick at least one card to salvage.");
  if (ids.length > 50) throw hangarError("invalid", "You can salvage at most 50 cards at once.");
  return inTx(() => {
    const out: SalvageResult["copies"] = [];
    let total = 0;
    let balance = 0;
    for (const id of ids) {
      const copy = requireCopy(id);
      assertOwnedFree(copy, userId);
      const card = getPlaneTypeById(copy.cardTypeId);
      const parts = salvageValue(card?.rarity ?? "common", copy.livery, copy.firstEdition);
      const removed = getDb()
        .delete(planeCardCopies)
        .where(and(eq(planeCardCopies.id, copy.id), eq(planeCardCopies.ownerId, userId), sql`${planeCardCopies.lockedReason} IS NULL`))
        .run();
      if (removed.changes !== 1) throw hangarError("conflict", "That card changed. Try again.");
      logCopyEvent(copy.id, "salvage", userId, null, { parts });
      balance = grantParts(userId, parts, "salvage", { copyId: copy.id, ref: `copy:${copy.id}` });
      total += parts;
      out.push({ id: copy.id, cardTypeId: copy.cardTypeId, serial: copy.serial, parts });
    }
    dropFromShowcase(userId, ids);
    refreshUserScore(userId);
    return { parts: total, balance, copies: out };
  });
}

export function craftCard(userId: string, cardTypeId: number): { copy: CopyRow; cost: number; balance: number } {
  return inTx(() => {
    const card = getPlaneTypeById(cardTypeId);
    if (!card) throw hangarError("not_found", "That card doesn't exist.");
    const cost = craftCost(card.rarity);
    if (cost == null) throw hangarError("not_craftable", "{rarity} cards can't be crafted.", { rarity: RARITY_META[card.rarity as Rarity]?.label ?? card.rarity });
    if (!card.enabled) throw hangarError("not_craftable", "{name} isn't available right now.", { name: card.name });
    if (card.printRun != null) throw hangarError("not_craftable", "Limited print cards can't be crafted.");
    if (!isMintable(card)) throw hangarError("not_craftable", "{name} is retired.", { name: card.name });
    assertCapacity(userId, 1);
    const balance = spendParts(userId, cost, "craft", { ref: `card:${card.id}` });
    const copy = mintCopy({ cardTypeId: card.id, ownerId: userId, livery: "standard", via: "craft", detail: { parts: cost } });
    refreshUserScore(userId);
    return { copy, cost, balance };
  });
}

/** Re-rolls a copy's livery for coins (burned). Never downgrades; prototypes can't be repainted. */
export function repaintCopy(userId: string, copyId: number, rng: Rng = defaultRng): { copy: CopyRow; from: Livery; to: Livery; cost: number; balance: number } {
  return inTx(() => {
    const copy = requireCopy(copyId);
    assertOwnedFree(copy, userId);
    const from = copy.livery as Livery;
    if (from === "prototype") throw hangarError("invalid", "Prototype liveries can't be repainted.");
    const card = getPlaneTypeById(copy.cardTypeId);
    const cost = RARITY_META[(card?.rarity ?? "common") as Rarity]?.repaint ?? RARITY_META.common.repaint;
    const balance = burnCoins(userId, cost, "repaint", `copy:${copy.id}`);
    const rolled = weightedPick(REPAINT_LIVERY_ODDS, rng) ?? "standard";
    const to = liveryIndex(rolled) > liveryIndex(from) ? rolled : from;
    if (to !== from) getDb().update(planeCardCopies).set({ livery: to }).where(eq(planeCardCopies.id, copy.id)).run();
    logCopyEvent(copy.id, "repaint", userId, userId, { from, to, cost });
    refreshUserScore(userId);
    return { copy: getCopy(copy.id)!, from, to, cost, balance };
  });
}

/** Spends Parts to raise a copy one level (sets XP to that level's threshold). */
export function upgradeCopy(userId: string, copyId: number): { copy: CopyRow; cost: number; balance: number } {
  return inTx(() => {
    const copy = requireCopy(copyId);
    assertOwnedFree(copy, userId);
    const card = getPlaneTypeById(copy.cardTypeId);
    const cost = upgradeCost(card?.rarity ?? "common", copy.level);
    if (cost == null) throw hangarError("max_level", "That card is already level {max}.", { max: MAX_LEVEL });
    const balance = spendParts(userId, cost, "upgrade", { copyId: copy.id, ref: `copy:${copy.id}` });
    const level = copy.level + 1;
    const xp = Math.max(copy.xp, LEVEL_XP[level]!);
    getDb().update(planeCardCopies).set({ level, xp }).where(eq(planeCardCopies.id, copy.id)).run();
    logCopyEvent(copy.id, "level", userId, userId, { level, via: "upgrade", parts: cost });
    refreshUserScore(userId);
    return { copy: getCopy(copy.id)!, cost, balance };
  });
}

/** Adds XP (flights) and levels up as thresholds are crossed. Returns levels gained. */
export function addCopyXp(copyId: number, xp: number): { level: number; levelsGained: number; xp: number } {
  const copy = requireCopy(copyId);
  const total = copy.xp + Math.max(0, Math.floor(xp));
  const level = Math.max(copy.level, levelForXp(total));
  getDb().update(planeCardCopies).set({ xp: total, level }).where(eq(planeCardCopies.id, copy.id)).run();
  if (level > copy.level) logCopyEvent(copy.id, "level", copy.ownerId, copy.ownerId, { level, via: "flight" });
  return { level, levelsGained: level - copy.level, xp: total };
}

// ── Showcase ─────────────────────────────────────────────────────────────────

export function setShowcase(userId: string, copyIds: number[]): number[] {
  const ids = [...new Set(copyIds)];
  if (ids.length > SHOWCASE_MAX) throw hangarError("invalid", "You can showcase at most {max} cards.", { max: SHOWCASE_MAX });
  for (const id of ids) {
    const copy = requireCopy(id);
    if (copy.ownerId !== userId) throw hangarError("not_owner", "You don't own that card.");
  }
  updateUserState(userId, { showcase: JSON.stringify(ids) });
  return ids;
}

export function getShowcase(userId: string): number[] {
  const ids = parseShowcase(getUserState(userId)?.showcase);
  const owned = new Set(getCopies(ids).filter((c) => c.ownerId === userId).map((c) => c.id));
  return ids.filter((id) => owned.has(id));
}

export { LIVERIES };
