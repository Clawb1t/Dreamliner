import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardCopies, planeCardFlights } from "../../../db/schema.js";
import { getPlaneTypeById, type PlaneTypeRow } from "../functions/catalog.js";
import {
  FLIGHT_SCORE_MIN,
  FLIGHT_SCORE_SPAN,
  LEVEL_STAT_BONUS,
  MAX_ACTIVE_FLIGHTS,
  MAX_FLIGHTS_PER_DAY,
  OPERATOR_PARTS_BONUS,
  ROUTES,
  type RouteDefinition,
  type RouteKey,
} from "./constants.js";
import { addCopyXp, assertOwnedFree, hangarCapacity, lockCopy, logCopyEvent, requireCopy, unlockCopy, type CopyRow } from "./copies.js";
import { hangarError } from "./errors.js";
import { grantParts, inTx } from "./ledger.js";
import { mintFreeCards } from "./packs.js";
import { defaultRng, type Rng } from "./random.js";
import { refreshUserScore } from "./score.js";

export type FlightRow = typeof planeCardFlights.$inferSelect;

export type EffectiveStats = {
  speed: number;
  agility: number;
  safety: number;
  passengerCount: number;
  reputation: number;
  fleetSize: number;
  destinations: number;
};

/** A card's stats raised by its level (0-100 stats only, capped at 100). */
export function effectiveStats(card: PlaneTypeRow, level: number): EffectiveStats {
  const factor = 1 + LEVEL_STAT_BONUS * (Math.max(1, level) - 1);
  const boost = (v: number) => Math.min(100, Math.round(v * factor));
  return {
    speed: boost(card.speed),
    agility: boost(card.agility),
    safety: boost(card.safety),
    passengerCount: card.passengerCount,
    reputation: boost(card.reputation),
    fleetSize: card.fleetSize,
    destinations: card.destinations,
  };
}

/** 0..1 performance score from a plane's effective stats. */
export function flightScore(stats: EffectiveStats): number {
  return Math.max(0, Math.min(1, (stats.speed * 0.4 + stats.agility * 0.2 + stats.safety * 0.4) / 100));
}

export function routeEligibility(route: RouteDefinition, stats: EffectiveStats): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (stats.safety < route.minSafety) missing.push(`safety ${route.minSafety}+`);
  if (stats.speed < route.minSpeed) missing.push(`speed ${route.minSpeed}+`);
  if (stats.passengerCount < route.minPassengers) missing.push(`${route.minPassengers}+ passengers`);
  return { ok: missing.length === 0, missing };
}

/** Parts a flight pays (deterministic; the bonus card roll is separate). */
export function flightParts(route: RouteDefinition, stats: EffectiveStats, hasOperator: boolean): number {
  const multiplier = (FLIGHT_SCORE_MIN + FLIGHT_SCORE_SPAN * flightScore(stats)) * (hasOperator ? OPERATOR_PARTS_BONUS : 1);
  return Math.max(1, Math.round(route.parts * multiplier));
}

function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === "string" && value in ROUTES;
}

export function listActiveFlights(userId: string): FlightRow[] {
  return getDb()
    .select()
    .from(planeCardFlights)
    .where(and(eq(planeCardFlights.userId, userId), isNull(planeCardFlights.claimedAt)))
    .orderBy(asc(planeCardFlights.endsAt))
    .all();
}

export function listRecentFlights(userId: string, limit = 10): FlightRow[] {
  return getDb()
    .select()
    .from(planeCardFlights)
    .where(eq(planeCardFlights.userId, userId))
    .orderBy(desc(planeCardFlights.id))
    .limit(limit)
    .all();
}

export function flightsStartedToday(userId: string, at = new Date()): number {
  return (
    getDb()
      .select({ n: count() })
      .from(planeCardFlights)
      .where(and(eq(planeCardFlights.userId, userId), gte(planeCardFlights.startedAt, utcDayStart(at))))
      .get()?.n ?? 0
  );
}

export function totalFlightsFlown(userId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(planeCardFlights)
      .where(and(eq(planeCardFlights.userId, userId), sql`${planeCardFlights.claimedAt} IS NOT NULL`))
      .get()?.n ?? 0
  );
}

export type StartFlightInput = {
  userId: string;
  copyId: number;
  route: RouteKey;
  operatorCopyId?: number | null;
  isSuperuser?: boolean;
  at?: Date;
};

export function startFlight(input: StartFlightInput): FlightRow {
  const at = input.at ?? new Date();
  const route = ROUTES[input.route];
  if (!route) throw hangarError("invalid", "Unknown route.");
  if (route.superuserOnly && !input.isSuperuser) throw hangarError("forbidden", "That route is for testing only.");
  return inTx(() => {
    if (listActiveFlights(input.userId).length >= MAX_ACTIVE_FLIGHTS) {
      throw hangarError("limit", "You can have at most {max} flights in the air at once.", { max: MAX_ACTIVE_FLIGHTS });
    }
    if (flightsStartedToday(input.userId, at) >= MAX_FLIGHTS_PER_DAY) {
      throw hangarError("limit", "You've flown {max} flights today. Come back tomorrow (UTC).", { max: MAX_FLIGHTS_PER_DAY });
    }
    const copy = requireCopy(input.copyId);
    assertOwnedFree(copy, input.userId);
    const card = getPlaneTypeById(copy.cardTypeId);
    if (!card || card.cardType !== "plane") throw hangarError("invalid", "Only plane cards can fly. Airline cards can operate a flight.");
    if (copy.lastFlightAt && copy.lastFlightAt >= utcDayStart(at)) {
      throw hangarError("cooldown", "That plane already flew today. Each card flies once per day (UTC).");
    }
    const stats = effectiveStats(card, copy.level);
    const eligibility = routeEligibility(route, stats);
    if (!eligibility.ok) throw hangarError("requirements", "That plane can't fly this route. Needs {missing}.", { missing: eligibility.missing.join(", ") });

    let operator: CopyRow | null = null;
    if (input.operatorCopyId) {
      operator = requireCopy(input.operatorCopyId);
      assertOwnedFree(operator, input.userId);
      const operatorCard = getPlaneTypeById(operator.cardTypeId);
      if (!operatorCard || operatorCard.cardType !== "airline") throw hangarError("invalid", "The operator must be an airline card.");
    }

    const flight = getDb()
      .insert(planeCardFlights)
      .values({
        userId: input.userId,
        copyId: copy.id,
        operatorCopyId: operator?.id ?? null,
        route: route.key,
        startedAt: at,
        endsAt: new Date(at.getTime() + route.durationMs),
      })
      .returning()
      .get();
    lockCopy(copy.id, "flight", flight.id);
    if (operator) lockCopy(operator.id, "flight", flight.id);
    getDb().update(planeCardCopies).set({ lastFlightAt: at }).where(eq(planeCardCopies.id, copy.id)).run();
    logCopyEvent(copy.id, "flight_start", input.userId, input.userId, { flightId: flight.id, route: route.key });
    return flight;
  });
}

export type FlightReward = { parts: number; xp: number; levelsGained: number; level: number; bonusCopyId: number | null; bonusFallbackParts: number };
export type ClaimedFlight = { flight: FlightRow; reward: FlightReward };

/**
 * Settles every landed flight (ends_at in the past, not yet claimed). Settlement only reads the
 * stored completion time, so a restart can never lose or double-pay a flight.
 */
export function claimFlights(userId: string, rng: Rng = defaultRng, at = new Date()): { claimed: ClaimedFlight[]; parts: number } {
  return inTx(() => {
    const landed = getDb()
      .select()
      .from(planeCardFlights)
      .where(and(eq(planeCardFlights.userId, userId), isNull(planeCardFlights.claimedAt), lte(planeCardFlights.endsAt, at)))
      .orderBy(asc(planeCardFlights.endsAt))
      .all();
    const claimed: ClaimedFlight[] = [];
    let totalParts = 0;
    for (const flight of landed) {
      const marked = getDb()
        .update(planeCardFlights)
        .set({ claimedAt: at })
        .where(and(eq(planeCardFlights.id, flight.id), isNull(planeCardFlights.claimedAt)))
        .run();
      if (marked.changes !== 1) continue;
      const route = ROUTES[flight.route as RouteKey] ?? ROUTES.short;
      const copy = getDb().select().from(planeCardCopies).where(eq(planeCardCopies.id, flight.copyId)).get();
      unlockCopy(flight.copyId, "flight", flight.id);
      if (flight.operatorCopyId) unlockCopy(flight.operatorCopyId, "flight", flight.id);
      const reward: FlightReward = { parts: 0, xp: 0, levelsGained: 0, level: copy?.level ?? 1, bonusCopyId: null, bonusFallbackParts: 0 };
      // The copy could only have left the owner while locked by an admin action; pay nothing for it then.
      if (copy && copy.ownerId === userId) {
        const card = getPlaneTypeById(copy.cardTypeId);
        const stats = card ? effectiveStats(card, copy.level) : null;
        const operatorStillOwned = flight.operatorCopyId
          ? getDb().select().from(planeCardCopies).where(eq(planeCardCopies.id, flight.operatorCopyId)).get()?.ownerId === userId
          : false;
        reward.parts = stats ? flightParts(route, stats, operatorStillOwned) : route.parts;
        reward.xp = route.xp;
        const xp = addCopyXp(copy.id, route.xp);
        reward.levelsGained = xp.levelsGained;
        reward.level = xp.level;
        getDb().update(planeCardCopies).set({ flights: sql`${planeCardCopies.flights} + 1` }).where(eq(planeCardCopies.id, copy.id)).run();
        if (rng() < route.bonusCardChance) {
          if (hangarCapacity(userId).free > 0) {
            try {
              reward.bonusCopyId = mintFreeCards(userId, 1, "flight", rng)[0]?.copy.id ?? null;
            } catch {
              reward.bonusFallbackParts = route.parts;
            }
          } else {
            reward.bonusFallbackParts = route.parts;
          }
        }
        const parts = reward.parts + reward.bonusFallbackParts;
        grantParts(userId, parts, "flight", { copyId: copy.id, ref: `flight:${flight.id}` });
        totalParts += parts;
        logCopyEvent(copy.id, "flight_land", userId, userId, { flightId: flight.id, route: route.key, parts, xp: route.xp });
      }
      getDb().update(planeCardFlights).set({ reward: JSON.stringify(reward) }).where(eq(planeCardFlights.id, flight.id)).run();
      claimed.push({ flight: { ...flight, claimedAt: at, reward: JSON.stringify(reward) }, reward });
    }
    if (claimed.length) refreshUserScore(userId);
    return { claimed, parts: totalParts };
  });
}

/** Routes with the eligibility and expected Parts for one plane copy. */
export function routesForCopy(copy: CopyRow, isSuperuser = false) {
  const card = getPlaneTypeById(copy.cardTypeId);
  const stats = card ? effectiveStats(card, copy.level) : null;
  return Object.values(ROUTES)
    .filter((route) => !route.superuserOnly || isSuperuser)
    .map((route) => {
      const eligibility = stats && card?.cardType === "plane" ? routeEligibility(route, stats) : { ok: false, missing: ["a plane card"] };
      return {
        route,
        eligible: eligibility.ok,
        missing: eligibility.missing,
        expectedParts: stats ? flightParts(route, stats, false) : 0,
        expectedPartsWithOperator: stats ? flightParts(route, stats, true) : 0,
      };
    });
}
