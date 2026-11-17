import { and, asc, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardCopies, planeCardPackOpenings, planeCardTypes } from "../../../db/schema.js";
import {
  HANGAR_MAX_SLOTS,
  HANGAR_SLOT_STEP,
  HANGAR_SLOT_STEP_PRICE,
  ROUTES,
  isLivery,
  isRarity,
  rarityIndex,
  type RouteKey,
} from "./constants.js";
import { getCopy, getShowcase, hangarCapacity, listCopyEvents } from "./copies.js";
import { hangarError } from "./errors.js";
import { listActiveFlights, listRecentFlights, routesForCopy, totalFlightsFlown, type FlightRow } from "./flights.js";
import { getCoinBalance, getPartsBalance } from "./ledger.js";
import { globalFleetRank } from "./leaderboards.js";
import { listUserListings } from "./market.js";
import { boardingStatus } from "./packs.js";
import { pilotRankView } from "./score.js";
import { listSets, listUserCompletions } from "./sets.js";
import { getUserState } from "./state.js";
import { listTrades } from "./trades.js";
import { cardTypeView, copyView, copyViews, viewContext, type HangarCardTypeView, type HangarCopyView, type ViewContext } from "./view.js";

export type FlightView = {
  id: number;
  route: RouteKey;
  routeLabel: string;
  copyId: number;
  operatorCopyId: number | null;
  startedAt: string;
  endsAt: string;
  claimedAt: string | null;
  landed: boolean;
  reward: Record<string, unknown> | null;
  copy: HangarCopyView | null;
};

export function flightView(flight: FlightRow, ctx: ViewContext, at = new Date()): FlightView {
  const route = ROUTES[flight.route as RouteKey] ?? ROUTES.short;
  const copy = getCopy(flight.copyId);
  let reward: Record<string, unknown> | null = null;
  try {
    reward = flight.reward ? (JSON.parse(flight.reward) as Record<string, unknown>) : null;
  } catch {
    reward = null;
  }
  return {
    id: flight.id,
    route: route.key,
    routeLabel: route.label,
    copyId: flight.copyId,
    operatorCopyId: flight.operatorCopyId ?? null,
    startedAt: flight.startedAt.toISOString(),
    endsAt: flight.endsAt.toISOString(),
    claimedAt: flight.claimedAt ? flight.claimedAt.toISOString() : null,
    landed: flight.endsAt <= at,
    reward,
    copy: copy ? copyView(copy, ctx) : null,
  };
}

export type RecentPull = {
  openingId: number;
  source: string;
  packKey: string | null;
  createdAt: string;
  pulls: { copyId: number | null; card: HangarCardTypeView | null; rarity: string; livery: string; forced: string | null; stillOwned: boolean }[];
};

export function recentPulls(userId: string | null, limit = 10, ctx: ViewContext = viewContext()): RecentPull[] {
  const query = getDb().select().from(planeCardPackOpenings);
  const rows = (userId ? query.where(eq(planeCardPackOpenings.userId, userId)) : query)
    .orderBy(desc(planeCardPackOpenings.id))
    .limit(Math.min(50, limit))
    .all();
  const copyIds = rows.flatMap((r) => {
    try {
      return (JSON.parse(r.pulls) as { copyId?: number }[]).map((p) => p.copyId).filter((id): id is number => typeof id === "number");
    } catch {
      return [];
    }
  });
  const owners = new Map(
    copyIds.length
      ? getDb().select({ id: planeCardCopies.id, ownerId: planeCardCopies.ownerId }).from(planeCardCopies).where(inArray(planeCardCopies.id, copyIds)).all().map((r) => [r.id, r.ownerId])
      : [],
  );
  return rows.map((row) => {
    let pulls: { copyId?: number; cardTypeId?: number; rarity?: string; livery?: string; forced?: string | null }[] = [];
    try {
      pulls = JSON.parse(row.pulls);
    } catch {
      pulls = [];
    }
    if (pulls.length === 0) {
      // Pre-Hangar openings only stored card type ids.
      try {
        pulls = (JSON.parse(row.planeTypeIds) as number[]).map((cardTypeId) => ({ cardTypeId }));
      } catch {
        pulls = [];
      }
    }
    return {
      openingId: row.id,
      source: row.source,
      packKey: row.packKey ?? null,
      createdAt: row.createdAt.toISOString(),
      pulls: pulls.map((p) => {
        const card = p.cardTypeId ? ctx.cards.get(p.cardTypeId) : undefined;
        return {
          copyId: p.copyId ?? null,
          card: card ? cardTypeView(card, ctx) : null,
          rarity: p.rarity ?? card?.rarity ?? "common",
          livery: p.livery ?? "standard",
          forced: p.forced ?? null,
          stillOwned: p.copyId ? owners.get(p.copyId) === row.userId : false,
        };
      }),
    };
  });
}

export function hangarOverview(userId: string) {
  const ctx = viewContext();
  const state = getUserState(userId);
  const fleetValue = state?.fleetValue ?? 0;
  const capacity = hangarCapacity(userId);
  const trades = listTrades(userId, { status: "pending", limit: 100 });
  const at = new Date();
  return {
    userId,
    coins: getCoinBalance(userId),
    parts: getPartsBalance(userId),
    fleetValue,
    pilotRank: pilotRankView(fleetValue),
    globalRank: globalFleetRank(userId),
    copies: state?.copiesCount ?? 0,
    distinctCards: state?.distinctCards ?? 0,
    setsCompleted: state?.setsCompleted ?? 0,
    mythicsOwned: state?.mythicsOwned ?? 0,
    flightsFlown: totalFlightsFlown(userId),
    hangar: {
      used: capacity.used,
      slots: capacity.slots,
      maxSlots: HANGAR_MAX_SLOTS,
      expandStep: HANGAR_SLOT_STEP,
      expandCost: capacity.slots >= HANGAR_MAX_SLOTS ? null : HANGAR_SLOT_STEP_PRICE,
    },
    boarding: boardingStatus(userId, at),
    activeFlights: listActiveFlights(userId).map((f) => flightView(f, ctx, at)),
    recentPulls: recentPulls(userId, 5, ctx),
    showcase: copyViews(getShowcase(userId).map((id) => getCopy(id)!).filter(Boolean), ctx),
    trades: {
      incoming: trades.filter((t) => t.toUserId === userId).length,
      outgoing: trades.filter((t) => t.fromUserId === userId).length,
    },
    activeListings: listUserListings(userId, 100).filter((l) => l.status === "active").length,
  };
}

export type CollectionFilters = {
  rarity?: string | null;
  livery?: string | null;
  setId?: number | null;
  cardType?: string | null;
  cardTypeId?: number | null;
  locked?: boolean | null;
  minLevel?: number | null;
  q?: string | null;
  sort?: "newest" | "oldest" | "rarity" | "level" | "serial" | "name" | null;
  page?: number;
  pageSize?: number;
};

export function hangarCollection(userId: string, filters: CollectionFilters = {}) {
  const pageSize = Math.max(1, Math.min(60, Math.floor(filters.pageSize ?? 24)));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const conditions: SQL[] = [eq(planeCardCopies.ownerId, userId)];
  if (filters.rarity && isRarity(filters.rarity)) conditions.push(eq(planeCardTypes.rarity, filters.rarity));
  if (filters.livery && isLivery(filters.livery)) conditions.push(eq(planeCardCopies.livery, filters.livery));
  if (filters.cardType === "plane" || filters.cardType === "airline") conditions.push(eq(planeCardTypes.cardType, filters.cardType));
  if (filters.cardTypeId) conditions.push(eq(planeCardCopies.cardTypeId, filters.cardTypeId));
  if (filters.locked === true) conditions.push(sql`${planeCardCopies.lockedReason} IS NOT NULL`);
  if (filters.locked === false) conditions.push(sql`${planeCardCopies.lockedReason} IS NULL`);
  if (filters.minLevel) conditions.push(sql`${planeCardCopies.level} >= ${Math.floor(filters.minLevel)}`);
  if (filters.q && filters.q.trim()) conditions.push(like(planeCardTypes.name, `%${filters.q.trim().replace(/[%_]/g, "")}%`));
  if (filters.setId) {
    const set = listSets().find((s) => s.id === filters.setId);
    if (!set || set.cardTypeIds.length === 0) return { copies: [] as HangarCopyView[], total: 0, page, pageSize };
    conditions.push(inArray(planeCardCopies.cardTypeId, set.cardTypeIds));
  }
  const rarityOrder = sql`CASE ${planeCardTypes.rarity} WHEN 'mythic' THEN 5 WHEN 'legendary' THEN 4 WHEN 'epic' THEN 3 WHEN 'rare' THEN 2 WHEN 'uncommon' THEN 1 ELSE 0 END`;
  const order =
    filters.sort === "oldest"
      ? [asc(planeCardCopies.acquiredAt), asc(planeCardCopies.id)]
      : filters.sort === "level"
        ? [desc(planeCardCopies.level), desc(planeCardCopies.xp), asc(planeCardCopies.id)]
        : filters.sort === "serial"
          ? [asc(planeCardCopies.serial), asc(planeCardCopies.id)]
          : filters.sort === "name"
            ? [asc(planeCardTypes.name), asc(planeCardCopies.serial)]
            : filters.sort === "rarity"
              ? [desc(rarityOrder), asc(planeCardTypes.name), asc(planeCardCopies.serial)]
              : [desc(planeCardCopies.acquiredAt), desc(planeCardCopies.id)];
  const where = and(...conditions);
  const rows = getDb()
    .select({ copy: planeCardCopies })
    .from(planeCardCopies)
    .innerJoin(planeCardTypes, eq(planeCardTypes.id, planeCardCopies.cardTypeId))
    .where(where)
    .orderBy(...order)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const total = Number(
    getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(planeCardCopies)
      .innerJoin(planeCardTypes, eq(planeCardTypes.id, planeCardCopies.cardTypeId))
      .where(where)
      .get()?.n ?? 0,
  );
  return { copies: copyViews(rows.map((r) => r.copy)), total, page, pageSize };
}

/** One copy with its history. Owner-only extras (routes, open listing/trades) when `viewerId` owns it. */
export function hangarCopyDetail(copyId: number, viewerId: string | null, isSuperuser = false) {
  const copy = getCopy(copyId);
  if (!copy) throw hangarError("not_found", "That card copy doesn't exist.");
  const ctx = viewContext();
  const view = copyView(copy, ctx);
  if (!view) throw hangarError("not_found", "That card copy doesn't exist.");
  const owner = viewerId === copy.ownerId;
  const events = listCopyEvents(copy.id).map((e) => {
    let detail: Record<string, unknown> | null = null;
    try {
      detail = e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    return { id: e.id, kind: e.kind, fromUserId: e.fromUserId, toUserId: e.toUserId, detail, createdAt: e.createdAt.toISOString() };
  });
  return {
    copy: view,
    owner,
    events,
    routes: owner && view.card.cardType === "plane"
      ? routesForCopy(copy, isSuperuser).map((r) => ({
          key: r.route.key,
          label: r.route.label,
          description: r.route.description,
          durationMs: r.route.durationMs,
          eligible: r.eligible,
          missing: r.missing,
          expectedParts: r.expectedParts,
          expectedPartsWithOperator: r.expectedPartsWithOperator,
          xp: r.route.xp,
          bonusCardChance: r.route.bonusCardChance,
        }))
      : [],
    listing: owner ? (listUserListings(copy.ownerId, 100).find((l) => l.copyId === copy.id && l.status === "active") ?? null) : null,
  };
}

export function setsProgress(userId: string | null) {
  const ctx = viewContext();
  const owned = new Set<number>(
    userId
      ? getDb().selectDistinct({ id: planeCardCopies.cardTypeId }).from(planeCardCopies).where(eq(planeCardCopies.ownerId, userId)).all().map((r) => r.id)
      : [],
  );
  const completions = userId ? listUserCompletions(userId) : new Map<number, Date>();
  return listSets({ enabledOnly: true }).map((set) => {
    const ownedIds = set.cardTypeIds.filter((id) => owned.has(id));
    return {
      id: set.id,
      key: set.key,
      name: set.name,
      description: set.description,
      bonusParts: set.bonusParts,
      total: set.cardTypeIds.length,
      owned: ownedIds.length,
      ownedCardTypeIds: ownedIds,
      completed: set.cardTypeIds.length > 0 && ownedIds.length === set.cardTypeIds.length,
      bonusClaimedAt: completions.get(set.id)?.toISOString() ?? null,
      cards: set.cardTypeIds
        .map((id) => ctx.cards.get(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => cardTypeView(c, ctx))
        .sort((a, b) => rarityIndex(b.rarity) - rarityIndex(a.rarity) || a.name.localeCompare(b.name)),
    };
  });
}

/** Every card type for the catalog/craft views. */
export function catalogView(opts: { includeDisabled?: boolean } = {}): HangarCardTypeView[] {
  const ctx = viewContext();
  return [...ctx.cards.values()]
    .filter((c) => opts.includeDisabled || c.enabled)
    .map((c) => cardTypeView(c, ctx))
    .sort((a, b) => rarityIndex(b.rarity) - rarityIndex(a.rarity) || a.name.localeCompare(b.name));
}

export function recentFlightsView(userId: string, limit = 10): FlightView[] {
  const ctx = viewContext();
  return listRecentFlights(userId, limit).map((f) => flightView(f, ctx));
}
