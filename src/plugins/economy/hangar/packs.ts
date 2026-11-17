import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardPackOpenings, planeCardPacks, planeCardTypes } from "../../../db/schema.js";
import { normalizePlaneKey } from "../functions/catalog.js";
import {
  BOARDING_PASS_CARDS,
  BOARDING_PASS_COOLDOWN_MS,
  BOARDING_PASS_PACK_KEY,
  BOARDING_PASS_STREAK_EVERY,
  BOARDING_PASS_STREAK_GRACE_MS,
  BOARDING_PASS_STREAK_PARTS,
  DEFAULT_LIVERY_ODDS,
  DEFAULT_PACKS,
  LIVERIES,
  PACK_MAX_PITY,
  PACK_MAX_PRICE,
  PACK_MAX_SIZE,
  RARITIES,
  isRarity,
  rarityIndex,
  type Livery,
  type Rarity,
} from "./constants.js";
import { assertCapacity, mintCopy, mintedCounts, type CopyRow } from "./copies.js";
import { hangarError } from "./errors.js";
import { burnCoins, getCoinBalance, grantParts, inTx } from "./ledger.js";
import { defaultRng, pickOne, weightedPick, type Rng } from "./random.js";
import { refreshUserScore } from "./score.js";
import { getSet } from "./sets.js";
import { ensureUserState, parsePity, updateUserState } from "./state.js";

export type PackRow = typeof planeCardPacks.$inferSelect;

export type PackDef = {
  id: number;
  key: string;
  name: string;
  description: string;
  price: number;
  size: number;
  rarityOdds: Record<Rarity, number>;
  liveryOdds: Record<Livery, number>;
  guaranteeRarity: Rarity | null;
  pityRarity: Rarity | null;
  pityAfter: number | null;
  featuredSetId: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  enabled: boolean;
  sortOrder: number;
};

function parseWeights<K extends string>(raw: string, keys: readonly K[], fallback: Record<K, number>): Record<K, number> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = {} as Record<K, number>;
    for (const key of keys) {
      const value = Number(parsed[key] ?? 0);
      out[key] = Number.isFinite(value) && value > 0 ? value : 0;
    }
    return out;
  } catch {
    return { ...fallback };
  }
}

const ZERO_RARITY = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<Rarity, number>;

export function toPackDef(row: PackRow): PackDef {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    price: row.price,
    size: row.size,
    rarityOdds: parseWeights(row.rarityOdds, RARITIES, ZERO_RARITY),
    liveryOdds: parseWeights(row.liveryOdds, LIVERIES, DEFAULT_LIVERY_ODDS),
    guaranteeRarity: isRarity(row.guaranteeRarity) ? row.guaranteeRarity : null,
    pityRarity: isRarity(row.pityRarity) ? row.pityRarity : null,
    pityAfter: row.pityAfter && row.pityAfter > 0 ? row.pityAfter : null,
    featuredSetId: row.featuredSetId ?? null,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  };
}

export function isPackActive(pack: PackDef, at = new Date()): boolean {
  if (!pack.enabled) return false;
  if (pack.startsAt && at < pack.startsAt) return false;
  if (pack.endsAt && at >= pack.endsAt) return false;
  return true;
}

export function listPacks(opts: { activeOnly?: boolean } = {}): PackDef[] {
  const rows = getDb().select().from(planeCardPacks).orderBy(asc(planeCardPacks.sortOrder), asc(planeCardPacks.price)).all();
  const packs = rows.map(toPackDef);
  return opts.activeOnly ? packs.filter((p) => isPackActive(p)) : packs;
}

export function getPackByKey(key: string): PackDef | null {
  const row = getDb().select().from(planeCardPacks).where(eq(planeCardPacks.key, key)).get();
  return row ? toPackDef(row) : null;
}

export function getPackById(id: number): PackDef | null {
  const row = getDb().select().from(planeCardPacks).where(eq(planeCardPacks.id, id)).get();
  return row ? toPackDef(row) : null;
}

/** Normalised odds (fractions summing to 1) for display. */
export function normalizedOdds<K extends string>(weights: Record<K, number>): Record<K, number> {
  const total = Object.values<number>(weights).reduce((a, b) => a + b, 0);
  const out = {} as Record<K, number>;
  for (const key of Object.keys(weights) as K[]) out[key] = total > 0 ? weights[key] / total : 0;
  return out;
}

// ── Draw logic (pure) ────────────────────────────────────────────────────────

export type PoolCard = { id: number; rarity: Rarity; remaining: number | null };
export type ForcedReason = "guarantee" | "pity" | null;
export type PlannedPull = { cardTypeId: number; rarity: Rarity; livery: Livery; forced: ForcedReason };

/** A rarity by the pack's odds, restricted to `minRarity` or better when given. */
export function drawRarity(odds: Record<Rarity, number>, rng: Rng, minRarity?: Rarity | null): Rarity {
  const min = minRarity ? rarityIndex(minRarity) : 0;
  return weightedPick(odds, rng, (r) => rarityIndex(r) >= min) ?? (minRarity ?? "common");
}

/**
 * Picks a card of `rarity` uniformly. If that rarity has no mintable cards, falls back to the
 * nearest rarity below it (never below `minRarity`), then the nearest above it.
 */
export function pickCard(rarity: Rarity, pool: PoolCard[], rng: Rng, minRarity?: Rarity | null): PoolCard | null {
  const target = rarityIndex(rarity);
  const floor = minRarity ? rarityIndex(minRarity) : 0;
  const order: number[] = [];
  for (let i = target; i >= floor; i--) order.push(i);
  for (let i = target + 1; i < RARITIES.length; i++) order.push(i);
  for (const index of order) {
    const candidates = pool.filter((c) => rarityIndex(c.rarity) === index && (c.remaining === null || c.remaining > 0));
    const picked = pickOne(candidates, rng);
    if (picked) return picked;
  }
  return null;
}

export function rollLivery(odds: Record<Livery, number>, rng: Rng): Livery {
  return weightedPick(odds, rng) ?? "standard";
}

/**
 * Plans every card of one pack: rarity first, then a card within it, then a livery. Applies pity
 * (a pityRarity-or-better card once `pityAfter` cards have gone by without one) and the guarantee
 * (the last card is re-drawn at guaranteeRarity-or-better when nothing earlier met it). Mutates
 * `pool[].remaining` so print runs can't be over-drawn within one pack.
 */
export function planPulls(
  pack: Pick<PackDef, "size" | "rarityOdds" | "liveryOdds" | "guaranteeRarity" | "pityRarity" | "pityAfter">,
  pool: PoolCard[],
  pityCount: number,
  rng: Rng,
): { pulls: PlannedPull[]; pityCount: number } {
  const pulls: PlannedPull[] = [];
  let pity = pityCount;
  const usesPity = Boolean(pack.pityRarity && pack.pityAfter);
  for (let i = 0; i < pack.size; i++) {
    let min: Rarity | null = null;
    let forced: ForcedReason = null;
    if (usesPity && pity + 1 >= pack.pityAfter!) {
      min = pack.pityRarity;
      forced = "pity";
    } else if (
      pack.guaranteeRarity &&
      i === pack.size - 1 &&
      !pulls.some((p) => rarityIndex(p.rarity) >= rarityIndex(pack.guaranteeRarity!))
    ) {
      min = pack.guaranteeRarity;
      forced = "guarantee";
    }
    const rarity = drawRarity(pack.rarityOdds, rng, min);
    let card = pickCard(rarity, pool, rng, min);
    if (!card && min) card = pickCard(rarity, pool, rng, null);
    if (!card) throw hangarError("empty_pool", "No cards are available in this pack right now.");
    if (card.remaining !== null) card.remaining -= 1;
    if (usesPity) pity = rarityIndex(card.rarity) >= rarityIndex(pack.pityRarity!) ? 0 : pity + 1;
    pulls.push({ cardTypeId: card.id, rarity: card.rarity, livery: rollLivery(pack.liveryOdds, rng), forced });
  }
  return { pulls, pityCount: pity };
}

/** Cards a pack can drop right now: enabled, not retired, print run left, and in the featured set. */
export function buildPool(pack: Pick<PackDef, "featuredSetId">): PoolCard[] {
  const minted = mintedCounts();
  const featured = pack.featuredSetId ? new Set(getSet(pack.featuredSetId)?.cardTypeIds ?? []) : null;
  return getDb()
    .select()
    .from(planeCardTypes)
    .all()
    .filter((c) => c.enabled && !c.retiredAt && isRarity(c.rarity))
    .filter((c) => !featured || featured.has(c.id))
    .map((c) => ({
      id: c.id,
      rarity: c.rarity as Rarity,
      remaining: c.printRun == null ? null : Math.max(0, c.printRun - (minted.get(c.id) ?? 0)),
    }))
    .filter((c) => c.remaining === null || c.remaining > 0);
}

// ── Opening ──────────────────────────────────────────────────────────────────

export type OpenedCopy = { copy: CopyRow; rarity: Rarity; forced: ForcedReason };
export type PackOpenResult = {
  pack: PackDef;
  copies: OpenedCopy[];
  cost: number;
  balance: number;
  pityCount: number | null;
  openingId: number;
  newlyCompletedSets: { setId: number; name: string; bonusParts: number }[];
};

function logOpening(userId: string, guildId: string, cost: number, source: "pack" | "boarding_pass", packKey: string, copies: OpenedCopy[]): number {
  return getDb()
    .insert(planeCardPackOpenings)
    .values({
      userId,
      guildId,
      cost,
      planeTypeIds: JSON.stringify(copies.map((c) => c.copy.cardTypeId)),
      source,
      packKey,
      pulls: JSON.stringify(
        copies.map((c) => ({ copyId: c.copy.id, cardTypeId: c.copy.cardTypeId, rarity: c.rarity, livery: c.copy.livery, forced: c.forced })),
      ),
      createdAt: new Date(),
    })
    .returning({ id: planeCardPackOpenings.id })
    .get().id;
}

function mintPlanned(userId: string, pulls: PlannedPull[], via: "pack" | "boarding_pass" | "flight", packKey: string): OpenedCopy[] {
  return pulls.map((pull) => ({
    copy: mintCopy({ cardTypeId: pull.cardTypeId, ownerId: userId, livery: pull.livery, via, detail: { pack: packKey } }),
    rarity: pull.rarity,
    forced: pull.forced,
  }));
}

/** Buys and opens a pack: burns the price, mints every card, updates pity, logs the opening. */
export function openPack(userId: string, guildId: string, packKey: string, rng: Rng = defaultRng): PackOpenResult {
  return inTx(() => {
    const pack = getPackByKey(packKey);
    if (!pack || !isPackActive(pack)) throw hangarError("pack_unavailable", "That pack isn't available right now.");
    const pool = buildPool(pack);
    if (pool.length === 0) throw hangarError("empty_pool", "No cards are available in this pack right now.");
    assertCapacity(userId, pack.size);
    const state = ensureUserState(userId);
    const pity = parsePity(state.pity);
    const plan = planPulls(pack, pool, pity[pack.key] ?? 0, rng);
    const balance = pack.price > 0 ? burnCoins(userId, pack.price, "pack", `pack:${pack.key}`) : getCoinBalance(userId);
    const copies = mintPlanned(userId, plan.pulls, "pack", pack.key);
    if (pack.pityRarity && pack.pityAfter) {
      pity[pack.key] = plan.pityCount;
      updateUserState(userId, { pity: JSON.stringify(pity) });
    }
    const openingId = logOpening(userId, guildId, pack.price, "pack", pack.key, copies);
    const score = refreshUserScore(userId);
    return {
      pack,
      copies,
      cost: pack.price,
      balance,
      pityCount: pack.pityRarity && pack.pityAfter ? plan.pityCount : null,
      openingId,
      newlyCompletedSets: score.newlyCompletedSets,
    };
  });
}

/** The pack the boarding pass (and flight bonus cards) draw from: the live Economy tier, or its seed. */
export function boardingPack(): PackDef {
  const live = getPackByKey(BOARDING_PASS_PACK_KEY);
  if (live) return live;
  const seed = DEFAULT_PACKS.find((p) => p.key === BOARDING_PASS_PACK_KEY) ?? DEFAULT_PACKS[0]!;
  return {
    id: 0,
    key: seed.key,
    name: seed.name,
    description: "",
    price: seed.price,
    size: seed.size,
    rarityOdds: seed.rarityOdds,
    liveryOdds: seed.liveryOdds,
    guaranteeRarity: null,
    pityRarity: null,
    pityAfter: null,
    featuredSetId: null,
    startsAt: null,
    endsAt: null,
    enabled: true,
    sortOrder: 0,
  };
}

/** Draws `count` cards on the boarding-pass odds and mints them (no guarantee, no pity). */
export function mintFreeCards(userId: string, count: number, via: "boarding_pass" | "flight", rng: Rng): OpenedCopy[] {
  const pack = boardingPack();
  const pool = buildPool({ featuredSetId: null });
  if (pool.length === 0) throw hangarError("empty_pool", "No cards are available right now.");
  const plan = planPulls({ ...pack, size: count, guaranteeRarity: null, pityRarity: null, pityAfter: null }, pool, 0, rng);
  return mintPlanned(userId, plan.pulls, via, pack.key);
}

export type BoardingStatus = { available: boolean; nextAt: string | null; streak: number; nextStreakBonusIn: number };

export function boardingStatus(userId: string, at = new Date()): BoardingStatus {
  const state = ensureUserState(userId);
  const last = state.boardingLastAt;
  const available = !last || at.getTime() - last.getTime() >= BOARDING_PASS_COOLDOWN_MS;
  const streakAlive = last && at.getTime() - last.getTime() < BOARDING_PASS_STREAK_GRACE_MS;
  const streak = streakAlive ? state.boardingStreak : 0;
  const upcoming = available ? streak + 1 : streak;
  const remainder = upcoming % BOARDING_PASS_STREAK_EVERY;
  return {
    available,
    nextAt: available || !last ? null : new Date(last.getTime() + BOARDING_PASS_COOLDOWN_MS).toISOString(),
    streak,
    nextStreakBonusIn: available ? (remainder === 0 ? 0 : BOARDING_PASS_STREAK_EVERY - remainder) : BOARDING_PASS_STREAK_EVERY - (streak % BOARDING_PASS_STREAK_EVERY),
  };
}

export type BoardingClaimResult = {
  copies: OpenedCopy[];
  streak: number;
  streakBonusParts: number;
  nextAt: string;
  newlyCompletedSets: { setId: number; name: string; bonusParts: number }[];
};

/** The free daily pull, plus a Parts bonus every BOARDING_PASS_STREAK_EVERY days in a row. */
export function claimBoardingPass(userId: string, guildId: string, rng: Rng = defaultRng, at = new Date()): BoardingClaimResult {
  return inTx(() => {
    const state = ensureUserState(userId);
    const last = state.boardingLastAt;
    if (last && at.getTime() - last.getTime() < BOARDING_PASS_COOLDOWN_MS) {
      const nextAt = new Date(last.getTime() + BOARDING_PASS_COOLDOWN_MS);
      throw hangarError("cooldown", "Your next boarding pass is ready at {nextAt}.", { nextAt: nextAt.toISOString() });
    }
    assertCapacity(userId, BOARDING_PASS_CARDS);
    const streak = last && at.getTime() - last.getTime() < BOARDING_PASS_STREAK_GRACE_MS ? state.boardingStreak + 1 : 1;
    const copies = mintFreeCards(userId, BOARDING_PASS_CARDS, "boarding_pass", rng);
    let streakBonusParts = 0;
    if (streak % BOARDING_PASS_STREAK_EVERY === 0) {
      streakBonusParts = BOARDING_PASS_STREAK_PARTS;
      grantParts(userId, streakBonusParts, "boarding_streak", { ref: `streak:${streak}` });
    }
    updateUserState(userId, { boardingLastAt: at, boardingStreak: streak });
    logOpening(userId, guildId, 0, "boarding_pass", BOARDING_PASS_PACK_KEY, copies);
    const score = refreshUserScore(userId);
    return {
      copies,
      streak,
      streakBonusParts,
      nextAt: new Date(at.getTime() + BOARDING_PASS_COOLDOWN_MS).toISOString(),
      newlyCompletedSets: score.newlyCompletedSets,
    };
  });
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────

export type PackInput = {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  price?: unknown;
  size?: unknown;
  rarityOdds?: unknown;
  liveryOdds?: unknown;
  guaranteeRarity?: unknown;
  pityRarity?: unknown;
  pityAfter?: unknown;
  featuredSetId?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  enabled?: unknown;
  sortOrder?: unknown;
};

/** Validates an odds map: known keys only, finite non-negative weights, positive total. */
export function validateOdds<K extends string>(raw: unknown, keys: readonly K[], label: string): Record<K, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw hangarError("invalid", "{label} must be an object of weights.", { label });
  const out = {} as Record<K, number>;
  for (const key of Object.keys(raw as object)) {
    if (!(keys as readonly string[]).includes(key)) throw hangarError("invalid", "{label} has an unknown key: {key}.", { label, key });
  }
  let total = 0;
  for (const key of keys) {
    const value = Number((raw as Record<string, unknown>)[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw hangarError("invalid", "{label}.{key} must be a weight of 0 or more.", { label, key });
    out[key] = value;
    total += value;
  }
  if (total <= 0) throw hangarError("invalid", "{label} needs at least one weight above 0.", { label });
  return out;
}

function optionalRarity(raw: unknown, label: string): Rarity | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (!isRarity(raw)) throw hangarError("invalid", "{label} must be a rarity or null.", { label });
  return raw;
}

function optionalDate(raw: unknown, label: string): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const date = new Date(String(raw));
  if (!Number.isFinite(date.getTime())) throw hangarError("invalid", "{label} must be an ISO date or null.", { label });
  return date;
}

function packValues(input: PackInput, existing: PackDef | null) {
  const pick = <T>(key: keyof PackInput, parse: (v: unknown) => T, fallback: T): T => (input[key] === undefined ? fallback : parse(input[key]));
  const name = pick("name", (v) => {
    if (typeof v !== "string" || !v.trim()) throw hangarError("invalid", "name is required.");
    return v.trim().slice(0, 60);
  }, existing?.name ?? "");
  if (!name) throw hangarError("invalid", "name is required.");
  const price = pick("price", (v) => {
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < 0 || n > PACK_MAX_PRICE) throw hangarError("invalid", "price must be between 0 and {max}.", { max: PACK_MAX_PRICE });
    return n;
  }, existing?.price ?? NaN);
  if (!Number.isFinite(price)) throw hangarError("invalid", "price is required.");
  const size = pick("size", (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > PACK_MAX_SIZE) throw hangarError("invalid", "size must be between 1 and {max}.", { max: PACK_MAX_SIZE });
    return n;
  }, existing?.size ?? NaN);
  if (!Number.isFinite(size)) throw hangarError("invalid", "size is required.");
  const rarityOdds = pick("rarityOdds", (v) => validateOdds(v, RARITIES, "rarityOdds"), existing?.rarityOdds ?? null);
  if (!rarityOdds) throw hangarError("invalid", "rarityOdds is required.");
  const liveryOdds = pick("liveryOdds", (v) => validateOdds(v, LIVERIES, "liveryOdds"), existing?.liveryOdds ?? { ...DEFAULT_LIVERY_ODDS });
  const guaranteeRarity = pick("guaranteeRarity", (v) => optionalRarity(v, "guaranteeRarity"), existing?.guaranteeRarity ?? null);
  const pityRarity = pick("pityRarity", (v) => optionalRarity(v, "pityRarity"), existing?.pityRarity ?? null);
  const pityAfter = pick("pityAfter", (v) => {
    if (v === null || v === "") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > PACK_MAX_PITY) throw hangarError("invalid", "pityAfter must be between 1 and {max}, or null.", { max: PACK_MAX_PITY });
    return n;
  }, existing?.pityAfter ?? null);
  if (Boolean(pityRarity) !== Boolean(pityAfter)) throw hangarError("invalid", "pityRarity and pityAfter must be set together.");
  if (guaranteeRarity && rarityOdds) {
    const reachable = RARITIES.some((r) => rarityIndex(r) >= rarityIndex(guaranteeRarity) && rarityOdds[r] > 0);
    if (!reachable) throw hangarError("invalid", "The guarantee rarity needs at least one rarity at or above it with odds above 0.");
  }
  if (pityRarity && rarityOdds) {
    const reachable = RARITIES.some((r) => rarityIndex(r) >= rarityIndex(pityRarity) && rarityOdds[r] > 0);
    if (!reachable) throw hangarError("invalid", "The pity rarity needs at least one rarity at or above it with odds above 0.");
  }
  const featuredSetId = pick("featuredSetId", (v) => {
    if (v === null || v === "") return null;
    const id = Number(v);
    if (!Number.isInteger(id) || !getSet(id)) throw hangarError("invalid", "featuredSetId must be an existing set id or null.");
    return id;
  }, existing?.featuredSetId ?? null);
  const startsAt = pick("startsAt", (v) => optionalDate(v, "startsAt"), existing?.startsAt ?? null);
  const endsAt = pick("endsAt", (v) => optionalDate(v, "endsAt"), existing?.endsAt ?? null);
  if (startsAt && endsAt && endsAt <= startsAt) throw hangarError("invalid", "endsAt must be after startsAt.");
  const enabled = pick("enabled", (v) => {
    if (typeof v !== "boolean") throw hangarError("invalid", "enabled must be a boolean.");
    return v;
  }, existing?.enabled ?? true);
  const sortOrder = pick("sortOrder", (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) throw hangarError("invalid", "sortOrder must be a number.");
    return n;
  }, existing?.sortOrder ?? 0);
  const description = pick("description", (v) => (typeof v === "string" ? v.trim().slice(0, 300) : ""), existing?.description ?? "");
  return {
    name,
    description,
    price,
    size,
    rarityOdds: JSON.stringify(rarityOdds),
    liveryOdds: JSON.stringify(liveryOdds),
    guaranteeRarity,
    pityRarity,
    pityAfter,
    featuredSetId,
    startsAt,
    endsAt,
    enabled,
    sortOrder,
  };
}

export function createPack(input: PackInput): PackDef {
  const key = normalizePlaneKey(typeof input.key === "string" ? input.key : "").replace(/-/g, "_");
  if (!key) throw hangarError("invalid", "key is required.");
  if (getPackByKey(key)) throw hangarError("conflict", "A pack with key {key} already exists.", { key });
  const values = packValues(input, null);
  const now = new Date();
  getDb().insert(planeCardPacks).values({ key, ...values, createdAt: now, updatedAt: now }).run();
  return getPackByKey(key)!;
}

export function updatePack(id: number, input: PackInput): PackDef {
  const existing = getPackById(id);
  if (!existing) throw hangarError("not_found", "That pack doesn't exist.");
  const values = packValues(input, existing);
  getDb().update(planeCardPacks).set({ ...values, updatedAt: new Date() }).where(eq(planeCardPacks.id, id)).run();
  return getPackById(id)!;
}

/** Removes a pack tier. Opening history keeps its pack key. */
export function deletePack(id: number): void {
  const existing = getPackById(id);
  if (!existing) throw hangarError("not_found", "That pack doesn't exist.");
  if (existing.key === BOARDING_PASS_PACK_KEY) {
    throw hangarError("invalid", "The {key} pack backs the boarding pass; disable it instead of deleting it.", { key: existing.key });
  }
  getDb().delete(planeCardPacks).where(eq(planeCardPacks.id, id)).run();
}
