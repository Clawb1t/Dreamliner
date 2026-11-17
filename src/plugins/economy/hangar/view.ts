import { getDb } from "../../../db/client.js";
import { planeCardTypes } from "../../../db/schema.js";
import type { PlaneTypeRow } from "../functions/catalog.js";
import {
  LEVEL_XP,
  LIVERY_META,
  MAX_LEVEL,
  RARITY_META,
  copyPoints,
  craftCost,
  salvageValue,
  upgradeCost,
  type Livery,
  type Rarity,
} from "./constants.js";
import { mintedCounts, type CopyRow } from "./copies.js";
import { effectiveStats } from "./flights.js";
import { setIdsByCardType } from "./sets.js";

/**
 * JSON shapes shared by the bridge (docs/hangar-bridge.md) and the Discord views. Image URLs are
 * bridge paths; the website proxies them.
 */

export type CardStats = Record<string, number>;

export type HangarCardTypeView = {
  id: number;
  key: string;
  name: string;
  cardType: "plane" | "airline";
  subtitle: string;
  rarity: Rarity;
  rarityLabel: string;
  rarityColor: string;
  imageKey: string;
  /** Raw art: GET /bridge/plane-cards/image/:imageKey */
  imageUrl: string | null;
  /** Rendered Standard face: GET /bridge/hangar/render/type/:id.png */
  renderUrl: string;
  enabled: boolean;
  retired: boolean;
  printRun: number | null;
  minted: number;
  craftCost: number | null;
  salvageBase: number;
  stats: CardStats;
  setIds: number[];
};

export type HangarCopyView = {
  id: number;
  ownerId: string;
  serial: number;
  /** "#0042/500" with a print run, "#0042" without. */
  serialLabel: string;
  livery: Livery;
  liveryLabel: string;
  firstEdition: boolean;
  level: number;
  xp: number;
  /** Total XP needed for the next level, null at max level. */
  xpForNextLevel: number | null;
  flights: number;
  obtainedVia: string;
  locked: { reason: string; ref: number | null } | null;
  mintedAt: string;
  acquiredAt: string;
  salvageValue: number;
  points: number;
  upgradeCost: number | null;
  repaintCost: number | null;
  effectiveStats: CardStats;
  /** Rendered face of this exact copy: GET /bridge/hangar/render/copy/:id.png */
  renderUrl: string;
  card: HangarCardTypeView;
};

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function cardStats(card: Pick<PlaneTypeRow, "cardType" | "speed" | "agility" | "passengerCount" | "reputation" | "fleetSize" | "destinations" | "safety">): CardStats {
  if (card.cardType === "airline") {
    return { reputation: card.reputation, fleetSize: card.fleetSize, destinations: card.destinations, safety: card.safety };
  }
  return { speed: card.speed, agility: card.agility, safety: card.safety, passengerCount: card.passengerCount };
}

export function serialLabel(serial: number, printRun: number | null): string {
  const width = Math.max(4, String(printRun ?? serial).length);
  const s = String(serial).padStart(width, "0");
  return printRun ? `#${s}/${printRun}` : `#${s}`;
}

/** Lookup tables built once per request. */
export type ViewContext = { minted: Map<number, number>; setIds: Map<number, number[]>; cards: Map<number, PlaneTypeRow> };

export function viewContext(): ViewContext {
  const cards = getDb().select().from(planeCardTypes).all();
  return { minted: mintedCounts(), setIds: setIdsByCardType(), cards: new Map(cards.map((c) => [c.id, c])) };
}

export function cardTypeView(card: PlaneTypeRow, ctx: ViewContext): HangarCardTypeView {
  const rarity = (card.rarity in RARITY_META ? card.rarity : "common") as Rarity;
  const meta = RARITY_META[rarity];
  return {
    id: card.id,
    key: card.key,
    name: card.name,
    cardType: card.cardType === "airline" ? "airline" : "plane",
    subtitle: card.subtitle,
    rarity,
    rarityLabel: meta.label,
    rarityColor: hex(meta.color),
    imageKey: card.imageKey,
    imageUrl: card.imageKey ? `/bridge/plane-cards/image/${encodeURIComponent(card.imageKey)}` : null,
    renderUrl: `/bridge/hangar/render/type/${card.id}.png`,
    enabled: card.enabled,
    retired: Boolean(card.retiredAt),
    printRun: card.printRun ?? null,
    minted: ctx.minted.get(card.id) ?? 0,
    craftCost: card.printRun != null ? null : craftCost(rarity),
    salvageBase: meta.salvage,
    stats: cardStats(card),
    setIds: ctx.setIds.get(card.id) ?? [],
  };
}

export function copyView(copy: CopyRow, ctx: ViewContext): HangarCopyView | null {
  const card = ctx.cards.get(copy.cardTypeId);
  if (!card) return null;
  const rarity = (card.rarity in RARITY_META ? card.rarity : "common") as Rarity;
  const livery = (copy.livery in LIVERY_META ? copy.livery : "standard") as Livery;
  const stats = effectiveStats(card, copy.level);
  return {
    id: copy.id,
    ownerId: copy.ownerId,
    serial: copy.serial,
    serialLabel: serialLabel(copy.serial, card.printRun ?? null),
    livery,
    liveryLabel: LIVERY_META[livery].label,
    firstEdition: copy.firstEdition,
    level: copy.level,
    xp: copy.xp,
    xpForNextLevel: copy.level >= MAX_LEVEL ? null : LEVEL_XP[copy.level + 1]!,
    flights: copy.flights,
    obtainedVia: copy.obtainedVia,
    locked: copy.lockedReason ? { reason: copy.lockedReason, ref: copy.lockedRef ?? null } : null,
    mintedAt: copy.mintedAt.toISOString(),
    acquiredAt: copy.acquiredAt.toISOString(),
    salvageValue: salvageValue(rarity, livery, copy.firstEdition),
    points: copyPoints(rarity, livery, copy.firstEdition, copy.level),
    upgradeCost: upgradeCost(rarity, copy.level),
    repaintCost: livery === "prototype" ? null : RARITY_META[rarity].repaint,
    effectiveStats: cardStats({ ...card, ...stats }),
    renderUrl: `/bridge/hangar/render/copy/${copy.id}.png`,
    card: cardTypeView(card, ctx),
  };
}

export function copyViews(copies: CopyRow[], ctx: ViewContext = viewContext()): HangarCopyView[] {
  return copies.map((c) => copyView(c, ctx)).filter((v): v is HangarCopyView => v !== null);
}
