import type { Client, Guild } from "discord.js";
import { CatalogError, getPlaneTypeById } from "../plugins/economy/functions/catalog.js";
import {
  DEFAULT_LIVERY_ODDS,
  LEADERBOARD_BOARDS,
  LIVERIES,
  MARKET_FEE_RATE,
  MARKET_LISTING_MS,
  MARKET_MAX_LISTINGS_PER_USER,
  MAX_ACTIVE_FLIGHTS,
  MAX_FLIGHTS_PER_DAY,
  MAX_PENDING_TRADES_PER_USER,
  MAX_TRADE_ITEMS_PER_SIDE,
  RARITIES,
  RARITY_META,
  ROUTES,
  TRADE_EXPIRY_MS,
  isLivery,
  salvageValue,
  type LeaderboardBoard,
  type Livery,
  type Rarity,
} from "../plugins/economy/hangar/constants.js";
import {
  craftCard,
  expandHangar,
  getCopies,
  getCopy,
  giveCopy,
  repaintCopy,
  salvageCopies,
  setShowcase,
  upgradeCopy,
  type CopyRow,
} from "../plugins/economy/hangar/copies.js";
import { HangarError } from "../plugins/economy/hangar/errors.js";
import { claimFlights, flightsStartedToday, isRouteKey, listActiveFlights, routesForCopy, startFlight } from "../plugins/economy/hangar/flights.js";
import { hangarMembersOf } from "../plugins/economy/hangar/guildMembers.js";
import { economyHealth } from "../plugins/economy/hangar/health.js";
import { leaderboard } from "../plugins/economy/hangar/leaderboards.js";
import { browseListings, buyListing, cancelListing, createListing, getListing, listUserListings, type ListingRow } from "../plugins/economy/hangar/market.js";
import {
  buildPool,
  claimBoardingPass,
  boardingStatus,
  createPack,
  deletePack,
  getPackById,
  isPackActive,
  listPacks,
  normalizedOdds,
  openPack,
  planPulls,
  updatePack,
  validateOdds,
  type OpenedCopy,
  type PackDef,
  type PackInput,
} from "../plugins/economy/hangar/packs.js";
import { seededRng } from "../plugins/economy/hangar/random.js";
import { renderCopy, renderFace } from "../plugins/economy/hangar/render.js";
import {
  catalogView,
  hangarCollection,
  hangarCopyDetail,
  hangarOverview,
  recentFlightsView,
  flightView,
  setsProgress,
  type CollectionFilters,
} from "../plugins/economy/hangar/service.js";
import { createSet, deleteSet, getSet, listSets, updateSet, type SetInput } from "../plugins/economy/hangar/sets.js";
import { ensureUserState, parsePity } from "../plugins/economy/hangar/state.js";
import { acceptTrade, cancelTrade, counterTrade, createTrade, declineTrade, getTrade, listTrades, type TradeWithItems } from "../plugins/economy/hangar/trades.js";
import { copyView, copyViews, viewContext, type HangarCopyView } from "../plugins/economy/hangar/view.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { invalidateCached } from "./responseCache.js";
import { getUserProfile } from "./userProfiles.js";

/**
 * The Hangar's website API (contract: docs/hangar-bridge.md). Three groups:
 *  - user-scoped:  /bridge/users/:userId/hangar/...   (the website passes the signed-in user's id)
 *  - renders:      /bridge/hangar/render/(copy|type)/:id.png
 *  - superuser:    /bridge/platform/plane-cards/(sets|packs|health|images)...
 * plus the server dashboard leaderboard at /bridge/guilds/:guildId/economy/plane-cards/leaderboard.
 */

export type BridgeResult =
  | { status: number; body: unknown }
  | { status: number; binary: Buffer; contentType: string };

const ok = (body: Record<string, unknown> = {}): BridgeResult => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string, code = "invalid"): BridgeResult => ({ status, body: { ok: false, error, code } });

export function hangarErrorResult(error: unknown): BridgeResult | null {
  if (error instanceof HangarError) return { status: error.status, body: { ok: false, error: error.message, code: error.code, vars: error.vars } };
  if (error instanceof CatalogError) return fail(error.code === "not_found" ? 404 : error.code === "duplicate_key" ? 409 : 400, error.message, error.code);
  return null;
}

export type UserBrief = { id: string; username: string; displayName: string; avatarUrl: string } | null;

async function userBriefs(client: Client, ids: string[]): Promise<Map<string, UserBrief>> {
  const out = new Map<string, UserBrief>();
  await Promise.all(
    [...new Set(ids)].slice(0, 100).map(async (id) => {
      const user = await fetchUserCached(client, id).catch(() => null);
      out.set(id, user ? { id, username: user.username, displayName: user.displayName, avatarUrl: user.displayAvatarURL({ size: 64 }) } : null);
    }),
  );
  return out;
}

function int(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function num(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function idList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
}

function packView(pack: PackDef, userId: string | null, pity: Record<string, number>) {
  const set = pack.featuredSetId ? getSet(pack.featuredSetId) : null;
  return {
    id: pack.id,
    key: pack.key,
    name: pack.name,
    description: pack.description,
    price: pack.price,
    size: pack.size,
    rarityOdds: normalizedOdds(pack.rarityOdds),
    liveryOdds: normalizedOdds(pack.liveryOdds),
    guaranteeRarity: pack.guaranteeRarity,
    pityRarity: pack.pityRarity,
    pityAfter: pack.pityAfter,
    pityProgress: userId && pack.pityAfter ? (pity[pack.key] ?? 0) : null,
    featuredSet: set ? { id: set.id, key: set.key, name: set.name } : null,
    startsAt: pack.startsAt ? pack.startsAt.toISOString() : null,
    endsAt: pack.endsAt ? pack.endsAt.toISOString() : null,
    active: isPackActive(pack),
    availableCards: buildPool(pack).length,
  };
}

function openedViews(copies: OpenedCopy[]) {
  const ctx = viewContext();
  return copies
    .map((c) => {
      const view = copyView(c.copy, ctx);
      return view ? { ...view, forced: c.forced } : null;
    })
    .filter(Boolean);
}

async function tradeViews(client: Client, userId: string, trades: TradeWithItems[]) {
  const ctx = viewContext();
  const allIds = trades.flatMap((t) => [...t.fromCopyIds, ...t.toCopyIds]);
  const copies = new Map(getCopies(allIds).map((c) => [c.id, c]));
  const users = await userBriefs(client, trades.flatMap((t) => [t.fromUserId, t.toUserId]));
  const view = (id: number) => {
    const copy = copies.get(id);
    return copy ? copyView(copy, ctx) : null;
  };
  return trades.map((t) => ({
    id: t.id,
    fromUserId: t.fromUserId,
    toUserId: t.toUserId,
    direction: t.toUserId === userId ? "incoming" : "outgoing",
    fromCoins: t.fromCoins,
    toCoins: t.toCoins,
    status: t.status,
    parentTradeId: t.parentTradeId ?? null,
    note: t.note ?? null,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
    resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
    fromCopyIds: t.fromCopyIds,
    toCopyIds: t.toCopyIds,
    fromCopies: t.fromCopyIds.map(view),
    toCopies: t.toCopyIds.map(view),
    from: users.get(t.fromUserId) ?? null,
    to: users.get(t.toUserId) ?? null,
  }));
}

async function listingViews(client: Client, rows: { listing: ListingRow; copy: CopyRow }[]) {
  const ctx = viewContext();
  const users = await userBriefs(client, rows.map((r) => r.listing.sellerId));
  return rows.map(({ listing, copy }) => ({
    id: listing.id,
    sellerId: listing.sellerId,
    seller: users.get(listing.sellerId) ?? null,
    price: listing.price,
    fee: listing.fee ?? null,
    sellerReceives: Math.round((listing.price - (listing.fee ?? Math.round(listing.price * MARKET_FEE_RATE * 100) / 100)) * 100) / 100,
    status: listing.status,
    buyerId: listing.buyerId ?? null,
    createdAt: listing.createdAt.toISOString(),
    expiresAt: listing.expiresAt.toISOString(),
    resolvedAt: listing.resolvedAt ? listing.resolvedAt.toISOString() : null,
    copy: copyView(copy, ctx),
  }));
}

async function leaderboardView(client: Client, board: LeaderboardBoard, memberIds: string[] | null, limit: number) {
  const entries = leaderboard(board, { memberIds, limit });
  const users = await userBriefs(client, entries.map((e) => e.userId));
  const rarestIds = entries.map((e) => e.rarestCopyId).filter((id): id is number => typeof id === "number");
  const ctx = viewContext();
  const rarest = new Map(getCopies(rarestIds).map((c) => [c.id, copyView(c, ctx)]));
  return entries.map((e) => ({
    rank: e.rank,
    userId: e.userId,
    user: users.get(e.userId) ?? null,
    value: e.value,
    ...(board === "rarest" ? { rarestCopy: e.rarestCopyId ? (rarest.get(e.rarestCopyId) ?? null) : null } : {}),
  }));
}

function parseBoard(raw: string | null): LeaderboardBoard {
  return (LEADERBOARD_BOARDS as readonly string[]).includes(raw ?? "") ? (raw as LeaderboardBoard) : "fleet_value";
}

function invalidateProfile(userId: string): void {
  invalidateCached(`pp-cards:${userId}:`);
  invalidateCached(`pp:${userId}:`);
}

export type UserHangarRequest = {
  client: Client;
  userId: string;
  /** Path after /hangar, without a leading slash ("" for the overview). */
  rest: string;
  method: string;
  query: URLSearchParams;
  readJson: () => Promise<Record<string, unknown>>;
  isSuperuser: boolean;
};

/** User-scoped Hangar routes. */
export async function handleUserHangar(req: UserHangarRequest): Promise<BridgeResult> {
  const { client, userId, method, query } = req;
  const parts = req.rest.split("/").filter(Boolean);
  const [section, id, action] = parts;
  try {
    // GET /hangar
    if (!section) {
      if (method !== "GET") return fail(405, "Method not allowed");
      return ok({ overview: hangarOverview(userId) });
    }

    if (section === "collection" && !id && method === "GET") {
      const filters: CollectionFilters = {
        rarity: query.get("rarity"),
        livery: query.get("livery"),
        setId: int(query.get("setId")),
        cardType: query.get("cardType"),
        cardTypeId: int(query.get("cardTypeId")),
        locked: query.get("locked") === "true" ? true : query.get("locked") === "false" ? false : null,
        minLevel: int(query.get("minLevel")),
        q: query.get("q"),
        sort: (query.get("sort") as CollectionFilters["sort"]) ?? null,
        page: int(query.get("page")) ?? 1,
        pageSize: int(query.get("pageSize")) ?? 24,
      };
      return ok(hangarCollection(userId, filters));
    }

    if (section === "copies" && id && !action && method === "GET") {
      // Someone else's copy is only visible when its owner shows their cards publicly, it's on the
      // market, or it's part of a trade with the requester (so ids can't be walked to map hidden
      // collections).
      const target = getCopy(Number(id));
      if (target && target.ownerId !== userId && !req.isSuperuser) {
        const profile = await getUserProfile(target.ownerId);
        const listed = target.lockedReason === "listing";
        const inTrade = listTrades(userId, { status: "pending", limit: 100 }).some((t) => t.fromCopyIds.includes(target.id) || t.toCopyIds.includes(target.id));
        if (!(profile.showTradingCards && profile.profileVisible) && !listed && !inTrade) return fail(404, "That card copy doesn't exist.", "not_found");
      }
      return ok(hangarCopyDetail(Number(id), userId, req.isSuperuser));
    }

    if (section === "catalog" && !id && method === "GET") {
      return ok({ cards: catalogView({ includeDisabled: query.get("includeDisabled") === "true" }) });
    }

    if (section === "packs") {
      if (!id && method === "GET") {
        const pity = parsePity(ensureUserState(userId).pity);
        return ok({ packs: listPacks({ activeOnly: true }).map((p) => packView(p, userId, pity)) });
      }
      if (id && action === "open" && method === "POST") {
        const body = await req.readJson();
        const guildId = typeof body.guildId === "string" && /^\d{15,25}$/.test(body.guildId) ? body.guildId : "web";
        const result = openPack(userId, guildId, id);
        invalidateProfile(userId);
        return ok({
          pack: { key: result.pack.key, name: result.pack.name },
          cost: result.cost,
          balance: result.balance,
          pityCount: result.pityCount,
          openingId: result.openingId,
          copies: openedViews(result.copies),
          newlyCompletedSets: result.newlyCompletedSets,
        });
      }
    }

    if (section === "boarding") {
      if (!id && method === "GET") return ok({ boarding: boardingStatus(userId) });
      if (id === "claim" && method === "POST") {
        const body = await req.readJson();
        const guildId = typeof body.guildId === "string" && /^\d{15,25}$/.test(body.guildId) ? body.guildId : "web";
        const result = claimBoardingPass(userId, guildId);
        invalidateProfile(userId);
        return ok({
          copies: openedViews(result.copies),
          streak: result.streak,
          streakBonusParts: result.streakBonusParts,
          nextAt: result.nextAt,
          newlyCompletedSets: result.newlyCompletedSets,
        });
      }
    }

    if (section === "salvage" && !id && method === "POST") {
      const body = await req.readJson();
      const result = salvageCopies(userId, idList(body.copyIds));
      invalidateProfile(userId);
      return ok({ parts: result.parts, balance: result.balance, salvaged: result.copies });
    }

    if (section === "craft" && !id && method === "POST") {
      const body = await req.readJson();
      const result = craftCard(userId, Number(body.cardTypeId));
      invalidateProfile(userId);
      return ok({ copy: copyView(result.copy, viewContext()), cost: result.cost, balance: result.balance });
    }

    if (section === "repaint" && !id && method === "POST") {
      const body = await req.readJson();
      const result = repaintCopy(userId, Number(body.copyId));
      invalidateProfile(userId);
      return ok({ copy: copyView(result.copy, viewContext()), from: result.from, to: result.to, cost: result.cost, balance: result.balance });
    }

    if (section === "upgrade" && !id && method === "POST") {
      const body = await req.readJson();
      const result = upgradeCopy(userId, Number(body.copyId));
      invalidateProfile(userId);
      return ok({ copy: copyView(result.copy, viewContext()), cost: result.cost, balance: result.balance });
    }

    if (section === "give" && !id && method === "POST") {
      const body = await req.readJson();
      const toUserId = typeof body.toUserId === "string" ? body.toUserId.trim() : "";
      if (!/^\d{15,25}$/.test(toUserId)) return fail(400, "toUserId is required.");
      const target = await fetchUserCached(client, toUserId).catch(() => null);
      if (!target) return fail(404, "That user doesn't exist.", "not_found");
      if (target.bot) return fail(400, "You can't give a card to a bot.");
      const copy = giveCopy(userId, toUserId, Number(body.copyId));
      invalidateProfile(userId);
      invalidateProfile(toUserId);
      return ok({ copy: copyView(copy, viewContext()) });
    }

    if (section === "expand" && !id && method === "POST") {
      return ok(expandHangar(userId));
    }

    if (section === "showcase" && !id && (method === "PUT" || method === "POST")) {
      const body = await req.readJson();
      const ids = setShowcase(userId, idList(body.copyIds));
      invalidateProfile(userId);
      return ok({ showcase: ids });
    }

    if (section === "sets" && !id && method === "GET") {
      return ok({ sets: setsProgress(userId) });
    }

    if (section === "flights") {
      if (!id && method === "GET") {
        const ctx = viewContext();
        return ok({
          active: listActiveFlights(userId).map((f) => flightView(f, ctx)),
          recent: recentFlightsView(userId, 10),
          startedToday: flightsStartedToday(userId),
          limits: { maxActive: MAX_ACTIVE_FLIGHTS, maxPerDay: MAX_FLIGHTS_PER_DAY },
          routes: Object.values(ROUTES)
            .filter((r) => !r.superuserOnly || req.isSuperuser)
            .map((r) => ({
              key: r.key,
              label: r.label,
              description: r.description,
              durationMs: r.durationMs,
              parts: r.parts,
              xp: r.xp,
              bonusCardChance: r.bonusCardChance,
              minSafety: r.minSafety,
              minSpeed: r.minSpeed,
              minPassengers: r.minPassengers,
            })),
        });
      }
      if (id === "routes" && method === "GET") {
        const copy = getCopy(int(query.get("copyId")) ?? 0);
        if (!copy || copy.ownerId !== userId) return fail(404, "That card copy doesn't exist.", "not_found");
        return ok({
          copyId: copy.id,
          routes: routesForCopy(copy, req.isSuperuser).map((r) => ({
            key: r.route.key,
            label: r.route.label,
            durationMs: r.route.durationMs,
            eligible: r.eligible,
            missing: r.missing,
            expectedParts: r.expectedParts,
            expectedPartsWithOperator: r.expectedPartsWithOperator,
            xp: r.route.xp,
          })),
        });
      }
      if (id === "start" && method === "POST") {
        const body = await req.readJson();
        if (!isRouteKey(body.route)) return fail(400, "route must be one of: short, medium, long.");
        const flight = startFlight({
          userId,
          copyId: Number(body.copyId),
          route: body.route,
          operatorCopyId: body.operatorCopyId == null ? null : Number(body.operatorCopyId),
          isSuperuser: req.isSuperuser,
        });
        return ok({ flight: flightView(flight, viewContext()) });
      }
      if (id === "claim" && method === "POST") {
        const result = claimFlights(userId);
        invalidateProfile(userId);
        const ctx = viewContext();
        return ok({ parts: result.parts, claimed: result.claimed.map((c) => ({ ...flightView(c.flight, ctx), reward: c.reward })) });
      }
    }

    if (section === "market") {
      if (!id && method === "GET") {
        const mine = query.get("mine") === "true";
        if (mine) {
          const listings = listUserListings(userId, 100);
          const copies = new Map(getCopies(listings.map((l) => l.copyId)).map((c) => [c.id, c]));
          const rows = listings.filter((l) => copies.has(l.copyId)).map((l) => ({ listing: l, copy: copies.get(l.copyId)! }));
          return ok({ listings: await listingViews(client, rows), total: rows.length, page: 1, pageSize: rows.length });
        }
        const result = browseListings({
          rarity: query.get("rarity"),
          livery: query.get("livery"),
          setId: int(query.get("setId")),
          cardTypeId: int(query.get("cardTypeId")),
          minPrice: num(query.get("minPrice")),
          maxPrice: num(query.get("maxPrice")),
          sort: (query.get("sort") as "newest" | "price_asc" | "price_desc" | null) ?? "newest",
          page: int(query.get("page")) ?? 1,
          pageSize: int(query.get("pageSize")) ?? 20,
        });
        return ok({
          listings: await listingViews(client, result.rows),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          feeRate: MARKET_FEE_RATE,
          floors: Object.fromEntries(RARITIES.map((r) => [r, RARITY_META[r].marketFloor])),
          maxListings: MARKET_MAX_LISTINGS_PER_USER,
          listingDays: MARKET_LISTING_MS / 86_400_000,
        });
      }
      if (id === "list" && method === "POST") {
        const body = await req.readJson();
        const listing = createListing(userId, Number(body.copyId), Number(body.price));
        return ok({ listing: (await listingViews(client, [{ listing, copy: getCopy(listing.copyId)! }]))[0] });
      }
      if (id && action === "cancel" && method === "POST") {
        const listing = cancelListing(userId, Number(id));
        const copy = getCopy(listing.copyId);
        return ok({ listing: copy ? (await listingViews(client, [{ listing, copy }]))[0] : null });
      }
      if (id && action === "buy" && method === "POST") {
        const result = buyListing(userId, Number(id));
        invalidateProfile(userId);
        invalidateProfile(result.listing.sellerId);
        const copy = getCopy(result.listing.copyId);
        return ok({
          listing: copy ? (await listingViews(client, [{ listing: result.listing, copy }]))[0] : null,
          price: result.price,
          fee: result.fee,
          balance: result.buyerBalance,
        });
      }
      if (id && !action && method === "GET") {
        const listing = getListing(Number(id));
        const copy = listing ? getCopy(listing.copyId) : null;
        if (!listing || !copy) return fail(404, "That listing doesn't exist.", "not_found");
        return ok({ listing: (await listingViews(client, [{ listing, copy }]))[0] });
      }
    }

    if (section === "trades") {
      if (!id && method === "GET") {
        const status = query.get("status") === "all" ? "all" : "pending";
        return ok({
          trades: await tradeViews(client, userId, listTrades(userId, { status, limit: 50 })),
          limits: { maxItemsPerSide: MAX_TRADE_ITEMS_PER_SIDE, maxPending: MAX_PENDING_TRADES_PER_USER, expiryHours: TRADE_EXPIRY_MS / 3_600_000 },
        });
      }
      if (!id && method === "POST") {
        const body = await req.readJson();
        const toUserId = typeof body.toUserId === "string" ? body.toUserId.trim() : "";
        if (!/^\d{15,25}$/.test(toUserId)) return fail(400, "toUserId is required.");
        const target = await fetchUserCached(client, toUserId).catch(() => null);
        // A failed lookup isn't fatal (the offer just expires unanswered); bots are refused.
        if (target?.bot) return fail(400, "You can't trade with that user.");
        const trade = createTrade({
          fromUserId: userId,
          toUserId,
          giveCopyIds: idList(body.giveCopyIds),
          wantCopyIds: idList(body.wantCopyIds),
          giveCoins: Number(body.giveCoins ?? 0),
          wantCoins: Number(body.wantCoins ?? 0),
          note: typeof body.note === "string" ? body.note : null,
        });
        return ok({ trade: (await tradeViews(client, userId, [trade]))[0] });
      }
      if (id && !action && method === "GET") {
        const trade = getTrade(Number(id));
        if (!trade || (trade.fromUserId !== userId && trade.toUserId !== userId)) return fail(404, "That trade doesn't exist.", "not_found");
        return ok({ trade: (await tradeViews(client, userId, [trade]))[0] });
      }
      if (id && action && method === "POST") {
        const tradeId = Number(id);
        const existing = getTrade(tradeId);
        if (!existing || (existing.fromUserId !== userId && existing.toUserId !== userId)) return fail(404, "That trade doesn't exist.", "not_found");
        let trade: TradeWithItems;
        if (action === "accept") trade = acceptTrade(tradeId, userId);
        else if (action === "decline") trade = declineTrade(tradeId, userId);
        else if (action === "cancel") trade = cancelTrade(tradeId, userId);
        else if (action === "counter") {
          const body = await req.readJson();
          trade = counterTrade(tradeId, userId, {
            giveCopyIds: idList(body.giveCopyIds),
            wantCopyIds: idList(body.wantCopyIds),
            giveCoins: Number(body.giveCoins ?? 0),
            wantCoins: Number(body.wantCoins ?? 0),
            note: typeof body.note === "string" ? body.note : null,
          });
        } else return fail(404, "Not found", "not_found");
        if (action === "accept") {
          invalidateProfile(existing.fromUserId);
          invalidateProfile(existing.toUserId);
        }
        return ok({ trade: (await tradeViews(client, userId, [trade]))[0] });
      }
    }

    if (section === "leaderboard" && !id && method === "GET") {
      const board = parseBoard(query.get("board"));
      const limit = Math.min(50, int(query.get("limit")) ?? 25);
      const guildId = query.get("guildId");
      let memberIds: string[] | null = null;
      let guildInfo: { id: string; name: string } | null = null;
      if (guildId) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return fail(404, "Dreamliner is not in that server.", "not_found");
        if (!req.isSuperuser && !(await fetchMemberCached(guild, userId))) return fail(403, "You aren't a member of that server.", "forbidden");
        memberIds = await hangarMembersOf(guild);
        guildInfo = { id: guild.id, name: guild.name };
      }
      return ok({ board, guild: guildInfo, entries: await leaderboardView(client, board, memberIds, limit) });
    }

    return fail(404, "Not found", "not_found");
  } catch (error) {
    const mapped = hangarErrorResult(error);
    if (mapped) return mapped;
    throw error;
  }
}

/** Server dashboard: this server's members ranked (staff only, checked by the caller). */
export async function guildHangarLeaderboard(client: Client, guild: Guild, query: URLSearchParams): Promise<BridgeResult> {
  const board = parseBoard(query.get("board"));
  const limit = Math.min(50, int(query.get("limit")) ?? 50);
  const memberIds = await hangarMembersOf(guild);
  return ok({ board, guild: { id: guild.id, name: guild.name }, players: memberIds.length, entries: await leaderboardView(client, board, memberIds, limit) });
}

/** PNG renders. `kind` is copy (by copy id) or type (by card type id, with livery/edition/level). */
export async function handleHangarRender(kind: "copy" | "type", id: number, query: URLSearchParams): Promise<BridgeResult> {
  if (kind === "copy") {
    const copy = getCopy(id);
    const card = copy ? getPlaneTypeById(copy.cardTypeId) : null;
    if (!copy || !card) return fail(404, "Card not found.", "not_found");
    // Same rule as the copy detail route: a hidden collection can't be mapped by walking copy ids.
    const viewer = query.get("viewer");
    if (copy.ownerId !== viewer) {
      const profile = await getUserProfile(copy.ownerId);
      const listed = copy.lockedReason === "listing";
      const inTrade = viewer
        ? listTrades(viewer, { status: "pending", limit: 100 }).some((t) => t.fromCopyIds.includes(copy.id) || t.toCopyIds.includes(copy.id))
        : false;
      if (!(profile.showTradingCards && profile.profileVisible) && !listed && !inTrade) return fail(404, "Card not found.", "not_found");
    }
    const buffer = await renderCopy({ card, livery: copy.livery as Livery, firstEdition: copy.firstEdition, level: copy.level, serial: copy.serial });
    return { status: 200, binary: buffer, contentType: "image/png" };
  }
  const card = getPlaneTypeById(id);
  if (!card) return fail(404, "Card not found.", "not_found");
  const liveryRaw = query.get("livery");
  const livery: Livery = isLivery(liveryRaw) ? liveryRaw : "standard";
  const level = Math.max(1, Math.min(10, int(query.get("level")) ?? 1));
  const firstEdition = query.get("edition") === "first" || query.get("edition") === "1";
  const buffer = await renderFace({ card, livery, firstEdition, level });
  return { status: 200, binary: buffer, contentType: "image/png" };
}

// ── Superuser admin ──────────────────────────────────────────────────────────

function adminPackView(pack: PackDef) {
  const set = pack.featuredSetId ? getSet(pack.featuredSetId) : null;
  return {
    ...pack,
    startsAt: pack.startsAt ? pack.startsAt.toISOString() : null,
    endsAt: pack.endsAt ? pack.endsAt.toISOString() : null,
    normalizedRarityOdds: normalizedOdds(pack.rarityOdds),
    normalizedLiveryOdds: normalizedOdds(pack.liveryOdds),
    featuredSet: set ? { id: set.id, key: set.key, name: set.name } : null,
    active: isPackActive(pack),
    availableCards: buildPool(pack).length,
  };
}

function adminSetView(set: ReturnType<typeof listSets>[number]) {
  return { ...set, createdAt: set.createdAt.toISOString(), updatedAt: set.updatedAt.toISOString() };
}

/**
 * Simulates `packs` openings of a (possibly unsaved) pack definition against the live card pool:
 * the odds preview and expected-Parts calculator on the admin page.
 */
export function previewPack(input: PackInput, packs = 5000) {
  const rarityOdds = validateOdds(input.rarityOdds, RARITIES, "rarityOdds");
  const liveryOdds = input.liveryOdds === undefined ? { ...DEFAULT_LIVERY_ODDS } : validateOdds(input.liveryOdds, LIVERIES, "liveryOdds");
  const size = Math.max(1, Math.min(10, Math.round(Number(input.size ?? 1))));
  const guaranteeRarity = RARITIES.includes(input.guaranteeRarity as Rarity) ? (input.guaranteeRarity as Rarity) : null;
  const pityRarity = RARITIES.includes(input.pityRarity as Rarity) ? (input.pityRarity as Rarity) : null;
  const pityAfter = pityRarity && Number(input.pityAfter) > 0 ? Math.round(Number(input.pityAfter)) : null;
  const featuredSetId = input.featuredSetId == null || input.featuredSetId === "" ? null : Number(input.featuredSetId);
  const basePool = buildPool({ featuredSetId });
  if (basePool.length === 0) return { availableCards: 0, packsSimulated: 0, expectedPartsPerPack: 0, expectedPartsPerCard: 0, rarity: {}, livery: {} };
  const rng = seededRng(12345);
  const rarityCounts = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<Rarity, number>;
  const liveryCounts = Object.fromEntries(LIVERIES.map((l) => [l, 0])) as Record<Livery, number>;
  let parts = 0;
  let cards = 0;
  let pity = 0;
  const n = Math.max(100, Math.min(20_000, packs));
  for (let i = 0; i < n; i++) {
    const pool = basePool.map((c) => ({ ...c }));
    const plan = planPulls({ size, rarityOdds, liveryOdds, guaranteeRarity, pityRarity, pityAfter }, pool, pity, rng);
    pity = plan.pityCount;
    for (const pull of plan.pulls) {
      rarityCounts[pull.rarity]++;
      liveryCounts[pull.livery]++;
      parts += salvageValue(pull.rarity, pull.livery, false);
      cards++;
    }
  }
  return {
    availableCards: basePool.length,
    packsSimulated: n,
    expectedPartsPerPack: Math.round((parts / n) * 10) / 10,
    expectedPartsPerCard: Math.round((parts / cards) * 10) / 10,
    rarity: Object.fromEntries(RARITIES.map((r) => [r, Math.round((rarityCounts[r] / cards) * 10000) / 10000])),
    livery: Object.fromEntries(LIVERIES.map((l) => [l, Math.round((liveryCounts[l] / cards) * 10000) / 10000])),
    configured: { rarity: normalizedOdds(rarityOdds), livery: normalizedOdds(liveryOdds) },
  };
}

export type PlatformHangarRequest = {
  /** Path after /bridge/platform/plane-cards/, e.g. "sets", "packs/3", "health". */
  rest: string;
  method: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
};

/** Superuser routes for sets, packs and the economy health panel (caller checks superuser). */
export async function handlePlatformHangar(req: PlatformHangarRequest): Promise<BridgeResult> {
  const [section, id, action] = req.rest.split("/").filter(Boolean);
  const { method, body } = req;
  try {
    if (section === "health" && !id && method === "GET") {
      const sinceDays = num(req.query.get("sinceDays"));
      return ok({ health: economyHealth({ sinceDays: sinceDays && sinceDays > 0 ? sinceDays : null }) });
    }
    if (section === "sets") {
      if (!id && method === "GET") return ok({ sets: listSets().map(adminSetView) });
      if (!id && method === "POST") return ok({ set: adminSetView(createSet(body as SetInput)) });
      if (id && !action && method === "PUT") return ok({ set: adminSetView(updateSet(Number(id), body as SetInput)) });
      if (id && !action && method === "DELETE") {
        deleteSet(Number(id));
        return ok();
      }
    }
    if (section === "packs") {
      if (!id && method === "GET") return ok({ packs: listPacks().map(adminPackView) });
      if (!id && method === "POST") return ok({ pack: adminPackView(createPack(body as PackInput)) });
      if (id === "preview" && method === "POST") return ok({ preview: previewPack(body as PackInput, Number(body.packs ?? 5000)) });
      if (id && !action && method === "PUT") return ok({ pack: adminPackView(updatePack(Number(id), body as PackInput)) });
      if (id && !action && method === "DELETE") {
        deletePack(Number(id));
        return ok();
      }
      if (id && !action && method === "GET") {
        const pack = getPackById(Number(id));
        return pack ? ok({ pack: adminPackView(pack) }) : fail(404, "That pack doesn't exist.", "not_found");
      }
    }
    return fail(404, "Not found", "not_found");
  } catch (error) {
    const mapped = hangarErrorResult(error);
    if (mapped) return mapped;
    throw error;
  }
}

export type { HangarCopyView };
export { copyViews };
