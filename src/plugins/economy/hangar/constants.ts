/**
 * Every Hangar tunable in one place. Pack tiers themselves live in the `plane_card_packs` table
 * (superusers edit them on the dashboard); the seed values for the three built-in tiers are in
 * drizzle/migrations/0145_hangar.sql and mirrored in DEFAULT_PACKS below for tests and docs.
 *
 * Anti-mint rule: nothing in the card system creates global coins. Coins only leave (pack price,
 * market fee, repaint fee, hangar slots) or move between players (market sales, coins in trades).
 * Parts are a card-only currency and can never be turned into coins.
 */

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;
export type Rarity = (typeof RARITIES)[number];

export const LIVERIES = ["standard", "gold", "prototype"] as const;
export type Livery = (typeof LIVERIES)[number];

export function isRarity(value: unknown): value is Rarity {
  return typeof value === "string" && (RARITIES as readonly string[]).includes(value);
}

export function isLivery(value: unknown): value is Livery {
  return typeof value === "string" && (LIVERIES as readonly string[]).includes(value);
}

export function rarityIndex(rarity: string): number {
  return RARITIES.indexOf(rarity as Rarity);
}

export function liveryIndex(livery: string): number {
  return LIVERIES.indexOf(livery as Livery);
}

export type RarityMeta = {
  label: string;
  /** Frame/accent colour (cards, embeds, website). */
  color: number;
  /** Parts paid for salvaging a Standard, non First Edition copy. */
  salvage: number;
  /** Parts to craft one Standard copy in the Workshop, null when the rarity can't be crafted. */
  craft: number | null;
  /** Fleet Value points for one Standard, non First Edition, level 1 copy. */
  points: number;
  /** Coins per repaint (livery re-roll). */
  repaint: number;
  /** Parts per level when upgrading in the Workshop (multiplied by the copy's current level). */
  upgradePerLevel: number;
  /** Minimum market listing price in coins. */
  marketFloor: number;
};

/** Crafting costs about 4x what salvaging the same card pays, so Parts can't loop into free cards. */
export const CRAFT_TO_SALVAGE_RATIO = 4;

export const RARITY_META: Record<Rarity, RarityMeta> = {
  common: { label: "Common", color: 0x9aa4b2, salvage: 5, craft: 20, points: 1, repaint: 5, upgradePerLevel: 4, marketFloor: 1 },
  uncommon: { label: "Uncommon", color: 0x3ba55d, salvage: 12, craft: 48, points: 3, repaint: 10, upgradePerLevel: 8, marketFloor: 2 },
  rare: { label: "Rare", color: 0x3b82f6, salvage: 30, craft: 120, points: 8, repaint: 20, upgradePerLevel: 16, marketFloor: 5 },
  epic: { label: "Epic", color: 0x9b59b6, salvage: 75, craft: 300, points: 20, repaint: 40, upgradePerLevel: 30, marketFloor: 12 },
  legendary: { label: "Legendary", color: 0xf1c40f, salvage: 200, craft: 800, points: 50, repaint: 80, upgradePerLevel: 60, marketFloor: 30 },
  // One-off launch airframes: pack-only, never crafted.
  mythic: { label: "Mythic", color: 0xe5484d, salvage: 600, craft: null, points: 150, repaint: 150, upgradePerLevel: 120, marketFloor: 100 },
};

export type LiveryMeta = { label: string; color: number; salvageMultiplier: number; pointsMultiplier: number };

export const LIVERY_META: Record<Livery, LiveryMeta> = {
  standard: { label: "Standard", color: 0x9aa4b2, salvageMultiplier: 1, pointsMultiplier: 1 },
  gold: { label: "Gold", color: 0xd4a537, salvageMultiplier: 3, pointsMultiplier: 2 },
  prototype: { label: "Prototype", color: 0x2f6fd6, salvageMultiplier: 10, pointsMultiplier: 5 },
};

/** Serials up to this number are First Edition. */
export const FIRST_EDITION_MAX_SERIAL = 100;
/** First Edition multiplier on salvage Parts and Fleet Value points. */
export const FIRST_EDITION_MULTIPLIER = 1.25;

/** Default livery weights (packs carry their own). */
export const DEFAULT_LIVERY_ODDS: Record<Livery, number> = { standard: 88, gold: 10, prototype: 2 };
/** Workshop repaint: a re-roll on these odds that never downgrades the current livery. */
export const REPAINT_LIVERY_ODDS: Record<Livery, number> = { standard: 80, gold: 16, prototype: 4 };

// ── Levels ───────────────────────────────────────────────────────────────────

export const MAX_LEVEL = 10;
/** Cumulative XP needed to reach each level (index = level). Level 1 needs 0. */
export const LEVEL_XP: readonly number[] = [0, 0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500];
/** Each level above 1 raises every 0-100 stat by this fraction (capped at 100). */
export const LEVEL_STAT_BONUS = 0.02;
/** Each level above 1 adds this fraction to a copy's Fleet Value points. */
export const LEVEL_POINTS_BONUS = 0.05;

// ── Fleet Value and Pilot Rank ───────────────────────────────────────────────

/** Fleet Value bonus for each distinct card type owned. */
export const DISTINCT_CARD_POINTS = 5;
/** Fleet Value bonus for each currently completed set. */
export const COMPLETED_SET_POINTS = 100;
/** Bump when the score formula changes: stale plane_card_user_state rows recompute on boot. */
export const SCORE_VERSION = 1;

export type PilotRank = { key: string; label: string; minFleetValue: number; color: string };

export const PILOT_RANKS: readonly PilotRank[] = [
  { key: "cadet", label: "Cadet", minFleetValue: 0, color: "#9aa4b2" },
  { key: "student_pilot", label: "Student Pilot", minFleetValue: 50, color: "#3ba55d" },
  { key: "first_officer", label: "First Officer", minFleetValue: 200, color: "#3b82f6" },
  { key: "captain", label: "Captain", minFleetValue: 500, color: "#5865f2" },
  { key: "senior_captain", label: "Senior Captain", minFleetValue: 1200, color: "#9b59b6" },
  { key: "chief_pilot", label: "Chief Pilot", minFleetValue: 2500, color: "#e67e22" },
  { key: "ace", label: "Ace", minFleetValue: 5000, color: "#f1c40f" },
  { key: "legend", label: "Legend", minFleetValue: 10000, color: "#e5484d" },
];

// ── Boarding pass ────────────────────────────────────────────────────────────

/** One free pull from this pack per day. */
export const BOARDING_PASS_PACK_KEY = "economy";
export const BOARDING_PASS_CARDS = 1;
export const BOARDING_PASS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Missing a day by more than this resets the streak. */
export const BOARDING_PASS_STREAK_GRACE_MS = 48 * 60 * 60 * 1000;
/** Every Nth consecutive day pays a Parts bonus. */
export const BOARDING_PASS_STREAK_EVERY = 7;
export const BOARDING_PASS_STREAK_PARTS = 30;

// ── Hangar capacity (coin sink) ──────────────────────────────────────────────

export const HANGAR_BASE_SLOTS = 100;
export const HANGAR_SLOT_STEP = 25;
export const HANGAR_SLOT_STEP_PRICE = 50;
export const HANGAR_MAX_SLOTS = 500;

// ── Showcase ─────────────────────────────────────────────────────────────────

export const SHOWCASE_MAX = 3;

// ── Flights ──────────────────────────────────────────────────────────────────

export type RouteKey = "short" | "medium" | "long" | "test";

export type RouteDefinition = {
  key: RouteKey;
  label: string;
  description: string;
  durationMs: number;
  /** Base Parts before the stat score multiplier. */
  parts: number;
  xp: number;
  /** Chance of a bonus card (drawn from BOARDING_PASS_PACK_KEY odds). */
  bonusCardChance: number;
  /** Requirements on the flying plane's effective (level-boosted) stats. */
  minSafety: number;
  minPassengers: number;
  minSpeed: number;
  /** Dashboard superusers only (a 1 minute route for testing). */
  superuserOnly?: boolean;
};

export const ROUTES: Record<RouteKey, RouteDefinition> = {
  short: {
    key: "short",
    label: "Regional hop",
    description: "A quick 1 hour hop. Any plane can fly it.",
    durationMs: 60 * 60 * 1000,
    parts: 4,
    xp: 20,
    bonusCardChance: 0.01,
    minSafety: 0,
    minPassengers: 0,
    minSpeed: 0,
  },
  medium: {
    key: "medium",
    label: "Continental",
    description: "4 hours. Needs safety 50+ and speed 40+.",
    durationMs: 4 * 60 * 60 * 1000,
    parts: 10,
    xp: 60,
    bonusCardChance: 0.03,
    minSafety: 50,
    minPassengers: 0,
    minSpeed: 40,
  },
  long: {
    key: "long",
    label: "Long haul",
    description: "12 hours. Needs safety 60+, speed 60+ and 150+ passengers.",
    durationMs: 12 * 60 * 60 * 1000,
    parts: 22,
    xp: 150,
    bonusCardChance: 0.06,
    minSafety: 60,
    minPassengers: 150,
    minSpeed: 60,
  },
  test: {
    key: "test",
    label: "Test flight",
    description: "1 minute. Dashboard superusers only.",
    durationMs: 60 * 1000,
    parts: 4,
    xp: 20,
    bonusCardChance: 0.01,
    minSafety: 0,
    minPassengers: 0,
    minSpeed: 0,
    superuserOnly: true,
  },
};

export const ROUTE_KEYS = Object.keys(ROUTES) as RouteKey[];
export const MAX_ACTIVE_FLIGHTS = 3;
/** Most flights one user can start per UTC day (each copy also flies at most once a day). */
export const MAX_FLIGHTS_PER_DAY = 12;
/** An airline operator multiplies the flight's Parts by this. */
export const OPERATOR_PARTS_BONUS = 1.15;
/** Parts multiplier range from the plane's stat score (0 to 1): min + span * score. */
export const FLIGHT_SCORE_MIN = 0.75;
export const FLIGHT_SCORE_SPAN = 0.5;

// ── Trades ───────────────────────────────────────────────────────────────────

export const TRADE_EXPIRY_MS = 48 * 60 * 60 * 1000;
export const MAX_TRADE_ITEMS_PER_SIDE = 6;
export const MAX_PENDING_TRADES_PER_USER = 10;
export const MAX_TRADE_COINS = 1_000_000;

// ── Market ───────────────────────────────────────────────────────────────────

export const MARKET_LISTING_MS = 7 * 24 * 60 * 60 * 1000;
/** 5% of every sale is burned. */
export const MARKET_FEE_RATE = 0.05;
export const MARKET_MAX_LISTINGS_PER_USER = 10;
export const MARKET_MAX_PRICE = 1_000_000;
export const MARKET_PAGE_SIZE = 20;

// ── Pack tiers (seed values; the live tiers are in plane_card_packs) ─────────

export type PackSeed = {
  key: string;
  name: string;
  price: number;
  size: number;
  rarityOdds: Record<Rarity, number>;
  liveryOdds: Record<Livery, number>;
  guaranteeRarity: Rarity | null;
  pityRarity: Rarity | null;
  pityAfter: number | null;
};

export const DEFAULT_PACKS: readonly PackSeed[] = [
  {
    key: "economy",
    name: "Economy",
    price: 25,
    size: 3,
    rarityOdds: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 0.9, mythic: 0.1 },
    liveryOdds: { standard: 88, gold: 10, prototype: 2 },
    guaranteeRarity: null,
    pityRarity: null,
    pityAfter: null,
  },
  {
    key: "business",
    name: "Business",
    price: 90,
    size: 5,
    rarityOdds: { common: 42, uncommon: 32, rare: 17, epic: 7, legendary: 1.8, mythic: 0.2 },
    liveryOdds: { standard: 88, gold: 10, prototype: 2 },
    guaranteeRarity: "uncommon",
    pityRarity: null,
    pityAfter: null,
  },
  {
    key: "first_class",
    name: "First Class",
    price: 300,
    size: 5,
    rarityOdds: { common: 15, uncommon: 30, rare: 32, epic: 16, legendary: 6.3, mythic: 0.7 },
    liveryOdds: { standard: 84, gold: 13, prototype: 3 },
    guaranteeRarity: "rare",
    pityRarity: "legendary",
    pityAfter: 40,
  },
];

/** Pack definition limits (admin validation). */
export const PACK_MAX_SIZE = 10;
export const PACK_MAX_PRICE = 100_000;
export const PACK_MAX_PITY = 1000;

// ── Leaderboards ─────────────────────────────────────────────────────────────

export const LEADERBOARD_BOARDS = ["fleet_value", "rarest", "sets", "flights_weekly"] as const;
export type LeaderboardBoard = (typeof LEADERBOARD_BOARDS)[number];
export const LEADERBOARD_MAX = 50;

// ── Art uploads ──────────────────────────────────────────────────────────────

export const ART_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const ART_MAX_DIMENSION = 2400;

// ── Derived helpers ──────────────────────────────────────────────────────────

/** Parts paid for salvaging one copy. */
export function salvageValue(rarity: string, livery: string, firstEdition: boolean): number {
  const meta = RARITY_META[rarity as Rarity] ?? RARITY_META.common;
  const liveryMeta = LIVERY_META[livery as Livery] ?? LIVERY_META.standard;
  return Math.round(meta.salvage * liveryMeta.salvageMultiplier * (firstEdition ? FIRST_EDITION_MULTIPLIER : 1));
}

/** Parts to craft a Standard copy, or null when the rarity can't be crafted. */
export function craftCost(rarity: string): number | null {
  return (RARITY_META[rarity as Rarity] ?? RARITY_META.common).craft;
}

/** Fleet Value points of one copy. */
export function copyPoints(rarity: string, livery: string, firstEdition: boolean, level: number): number {
  const meta = RARITY_META[rarity as Rarity] ?? RARITY_META.common;
  const liveryMeta = LIVERY_META[livery as Livery] ?? LIVERY_META.standard;
  const lvl = Math.max(1, Math.min(MAX_LEVEL, level));
  return Math.round(
    meta.points * liveryMeta.pointsMultiplier * (firstEdition ? FIRST_EDITION_MULTIPLIER : 1) * (1 + LEVEL_POINTS_BONUS * (lvl - 1)),
  );
}

/** The level a copy with this much XP is at. */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let l = 2; l <= MAX_LEVEL; l++) if (xp >= LEVEL_XP[l]!) level = l;
  return level;
}

/** Parts to buy the next level in the Workshop, or null at max level. */
export function upgradeCost(rarity: string, level: number): number | null {
  if (level >= MAX_LEVEL) return null;
  return (RARITY_META[rarity as Rarity] ?? RARITY_META.common).upgradePerLevel * level;
}

export function pilotRankFor(fleetValue: number): { rank: PilotRank; next: PilotRank | null; progress: number } {
  let index = 0;
  for (let i = 0; i < PILOT_RANKS.length; i++) if (fleetValue >= PILOT_RANKS[i]!.minFleetValue) index = i;
  const rank = PILOT_RANKS[index]!;
  const next = PILOT_RANKS[index + 1] ?? null;
  const progress = next ? Math.max(0, Math.min(1, (fleetValue - rank.minFleetValue) / (next.minFleetValue - rank.minFleetValue))) : 1;
  return { rank, next, progress };
}

export function marketFee(price: number): number {
  return Math.round(price * MARKET_FEE_RATE * 100) / 100;
}
