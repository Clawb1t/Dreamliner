import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see credits.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-hangar-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const schema = await import("../../../db/schema.js");
const { eq, sql } = await import("drizzle-orm");
const money = await import("../functions/money.js");
const { createPlaneType } = await import("../functions/catalog.js");
const copies = await import("./copies.js");
const packs = await import("./packs.js");
const ledger = await import("./ledger.js");
const market = await import("./market.js");
const trades = await import("./trades.js");
const flights = await import("./flights.js");
const sets = await import("./sets.js");
const score = await import("./score.js");
const { HangarError } = await import("./errors.js");
const { seededRng } = await import("./random.js");
const { ROUTES } = await import("./constants.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";
const D = "100000000000000004";
const E = "100000000000000005";
const USERS = [A, B, C, D, E];

/** The only faucet in these tests: what the real economy pays out via messages, /daily and /exchange. */
let faucets = 0;
function faucet(userId: string, amount: number): void {
  money.creditGlobal(userId, amount);
  faucets = money.round2(faucets + amount);
}

function totalCoins(): number {
  return Number(getDb().get<{ total: number }>(sql`SELECT COALESCE(SUM(balance), 0) AS total FROM economy_global_accounts`)?.total ?? 0);
}

function coinLedgerSum(): number {
  return Number(getDb().get<{ total: number }>(sql`SELECT COALESCE(SUM(delta), 0) AS total FROM plane_coin_ledger`)?.total ?? 0);
}

function firstCopy(userId: string, free = true) {
  return copies.listUserCopies(userId).find((c) => !free || !c.lockedReason) ?? null;
}

function expectHangar(fn: () => unknown, code?: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HangarError, `expected a HangarError, got ${String(error)}`);
    if (code) assert.equal(error.code, code);
    return;
  }
  assert.fail("expected a HangarError");
}

describe("the migration seeds a playable Hangar", () => {
  it("has pack tiers, cards in every rarity up to mythic, and sets", () => {
    const keys = packs.listPacks().map((p) => p.key);
    assert.deepEqual(keys, ["economy", "business", "first_class"]);
    const business = packs.getPackByKey("business")!;
    assert.equal(business.price, 90);
    assert.equal(business.guaranteeRarity, "uncommon");
    const first = packs.getPackByKey("first_class")!;
    assert.equal(first.pityAfter, 40);
    const rarities = new Set(getDb().select().from(schema.planeCardTypes).all().map((c) => c.rarity));
    for (const r of ["common", "uncommon", "rare", "epic", "mythic"]) assert.ok(rarities.has(r), r);
    assert.ok(sets.listSets().length >= 4);
  });
});

describe("coin conservation", () => {
  it("a random mix of packs, salvage, crafts, trades, market buys and flights never creates coins", () => {
    for (const u of USERS) faucet(u, 2000);
    const rng = seededRng(424242);
    const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)]!;
    let at = new Date("2026-01-01T00:00:00Z").getTime();
    const ops: Record<string, number> = {};

    for (let step = 0; step < 1500; step++) {
      at += 20 * 60 * 1000;
      const now = new Date(at);
      const user = pick(USERS);
      const other = pick(USERS.filter((u) => u !== user));
      const op = pick(["pack", "pack", "boarding", "salvage", "craft", "repaint", "upgrade", "list", "buy", "cancel", "trade", "accept", "decline", "fly", "claim", "give", "expand", "faucet"]);
      try {
        switch (op) {
          case "pack":
            packs.openPack(user, "g", pick(["economy", "business", "first_class"]), rng);
            break;
          case "boarding":
            packs.claimBoardingPass(user, "g", rng, now);
            break;
          case "salvage": {
            const copy = firstCopy(user);
            if (copy) copies.salvageCopies(user, [copy.id]);
            break;
          }
          case "craft": {
            const card = pick(getDb().select().from(schema.planeCardTypes).all());
            copies.craftCard(user, card.id);
            break;
          }
          case "repaint": {
            const copy = firstCopy(user);
            if (copy) copies.repaintCopy(user, copy.id, rng);
            break;
          }
          case "upgrade": {
            const copy = firstCopy(user);
            if (copy) copies.upgradeCopy(user, copy.id);
            break;
          }
          case "list": {
            const copy = firstCopy(user);
            if (copy) market.createListing(user, copy.id, 5 + Math.floor(rng() * 200), now);
            break;
          }
          case "buy": {
            const listing = market.browseListings({ pageSize: 50 }, now).rows.find((r) => r.listing.sellerId !== user);
            if (listing) market.buyListing(user, listing.listing.id, now);
            break;
          }
          case "cancel": {
            const listing = market.listUserListings(user).find((l) => l.status === "active");
            if (listing) market.cancelListing(user, listing.id, now);
            break;
          }
          case "trade": {
            const give = firstCopy(user);
            const want = firstCopy(other);
            trades.createTrade({
              fromUserId: user,
              toUserId: other,
              giveCopyIds: give ? [give.id] : [],
              wantCopyIds: want ? [want.id] : [],
              giveCoins: rng() < 0.5 ? Math.floor(rng() * 300) : 0,
              at: now,
            });
            break;
          }
          case "accept": {
            const trade = trades.listTrades(user, { status: "pending" }).find((t) => t.toUserId === user);
            if (trade) trades.acceptTrade(trade.id, user, now);
            break;
          }
          case "decline": {
            const trade = trades.listTrades(user, { status: "pending" }).find((t) => t.toUserId === user);
            if (trade) trades.declineTrade(trade.id, user, now);
            break;
          }
          case "fly": {
            const plane = copies.listUserCopies(user).find((c) => !c.lockedReason && getDb().select().from(schema.planeCardTypes).where(eq(schema.planeCardTypes.id, c.cardTypeId)).get()?.cardType === "plane");
            if (plane) flights.startFlight({ userId: user, copyId: plane.id, route: "short", at: now });
            break;
          }
          case "claim":
            flights.claimFlights(user, rng, now);
            break;
          case "give": {
            const copy = firstCopy(user);
            if (copy) copies.giveCopy(user, other, copy.id);
            break;
          }
          case "expand":
            copies.expandHangar(user);
            break;
          case "faucet":
            faucet(user, Math.floor(rng() * 50));
            break;
        }
        ops[op] = (ops[op] ?? 0) + 1;
      } catch (error) {
        if (!(error instanceof HangarError)) throw error;
      }

      const total = totalCoins();
      const burned = -coinLedgerSum();
      assert.ok(total <= faucets + 1e-6, `step ${step} (${op}): ${total} coins > ${faucets} paid out`);
      assert.ok(Math.abs(total + burned - faucets) < 0.02, `step ${step} (${op}): ${total} + burned ${burned} != ${faucets}`);
      assert.ok(burned >= -1e-9, "the card system's coin ledger is never positive");
    }

    for (const u of USERS) {
      assert.ok(money.getGlobalBalance(u) >= 0, "no negative balances");
      assert.ok(ledger.getPartsBalance(u) >= 0, "no negative Parts");
    }
    // The run exercised the interesting paths, not just failures.
    for (const op of ["pack", "salvage", "buy", "accept", "claim"]) assert.ok((ops[op] ?? 0) > 0, `${op} never succeeded`);
    // Transfers net to zero.
    const transfers = Number(
      getDb().get<{ total: number }>(sql`SELECT COALESCE(SUM(delta), 0) AS total FROM plane_coin_ledger WHERE kind IN ('market_buy','market_sale','trade_out','trade_in')`)?.total ?? 0,
    );
    assert.ok(Math.abs(transfers) < 0.01, `transfers sum to ${transfers}`);
  });
});

/** A fresh plane card type for the conflict tests (uncommon: market floor 2). */
let cardCounter = 0;
function newCard(opts: { printRun?: number | null; rarity?: "common" | "uncommon" | "rare" | "legendary" } = {}) {
  cardCounter++;
  return createPlaneType({
    key: `test-card-${cardCounter}`,
    name: `Test Card ${cardCounter}`,
    cardType: "plane",
    subtitle: "",
    rarity: opts.rarity ?? "uncommon",
    safety: 70,
    speed: 70,
    agility: 50,
    passengerCount: 200,
    imageKey: "",
    createdBy: "test",
    printRun: opts.printRun ?? null,
  });
}

function mintTo(userId: string, cardTypeId?: number) {
  return copies.mintCopy({ cardTypeId: cardTypeId ?? newCard().id, ownerId: userId, livery: "standard", via: "gift" });
}

describe("atomic market settlement", () => {
  const S = "200000000000000001";
  const B1 = "200000000000000002";
  const B2 = "200000000000000003";

  it("two buyers race for one listing: exactly one gets it, the other pays nothing", () => {
    money.creditGlobal(B1, 100);
    money.creditGlobal(B2, 100);
    const copy = mintTo(S);
    const listing = market.createListing(S, copy.id, 40);
    const result = market.buyListing(B1, listing.id);
    assert.equal(result.fee, 2);
    expectHangar(() => market.buyListing(B2, listing.id), "conflict");
    assert.equal(money.getGlobalBalance(B1), 60);
    assert.equal(money.getGlobalBalance(B2), 100);
    assert.equal(money.getGlobalBalance(S), 38); // 40 minus the burned 5% fee
    assert.equal(copies.getCopy(copy.id)!.ownerId, B1);
    assert.equal(copies.getCopy(copy.id)!.lockedReason, null);
  });

  it("a buyer without the coins changes nothing", () => {
    const poor = "200000000000000009";
    const copy = mintTo(S);
    const listing = market.createListing(S, copy.id, 50);
    expectHangar(() => market.buyListing(poor, listing.id), "insufficient_coins");
    assert.equal(market.getListing(listing.id)!.status, "active");
    assert.equal(copies.getCopy(copy.id)!.ownerId, S);
    assert.equal(copies.getCopy(copy.id)!.lockedReason, "listing");
  });

  it("listed copies can't be salvaged, given, traded or listed twice", () => {
    const copy = mintTo(S);
    market.createListing(S, copy.id, 10);
    expectHangar(() => copies.salvageCopies(S, [copy.id]), "locked");
    expectHangar(() => copies.giveCopy(S, B1, copy.id), "locked");
    expectHangar(() => trades.createTrade({ fromUserId: S, toUserId: B1, giveCopyIds: [copy.id], wantCopyIds: [] }), "locked");
    expectHangar(() => market.createListing(S, copy.id, 10), "locked");
  });

  it("an expired listing can't be bought and releases its card", () => {
    const copy = mintTo(S);
    const listedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const listing = market.createListing(S, copy.id, 10, listedAt);
    expectHangar(() => market.buyListing(B1, listing.id), "expired");
    assert.equal(market.getListing(listing.id)!.status, "expired");
    assert.equal(copies.getCopy(copy.id)!.lockedReason, null);
  });

  it("enforces the per-rarity price floor", () => {
    const copy = copies.mintCopy({ cardTypeId: newCard({ rarity: "legendary" }).id, ownerId: S, livery: "standard", via: "gift" });
    expectHangar(() => market.createListing(S, copy.id, 5), "invalid");
  });
});

describe("atomic trade settlement", () => {
  const X = "300000000000000001";
  const Y = "300000000000000002";
  const Z = "300000000000000003";

  it("moves both sides and the coins together", () => {
    money.creditGlobal(X, 50);
    const mine = mintTo(X);
    const theirs = mintTo(Y);
    const trade = trades.createTrade({ fromUserId: X, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [theirs.id], giveCoins: 20 });
    assert.equal(copies.getCopy(mine.id)!.lockedReason, "trade");
    trades.acceptTrade(trade.id, Y);
    assert.equal(copies.getCopy(mine.id)!.ownerId, Y);
    assert.equal(copies.getCopy(theirs.id)!.ownerId, X);
    assert.equal(copies.getCopy(mine.id)!.lockedReason, null);
    assert.equal(money.getGlobalBalance(X), 30);
    assert.equal(money.getGlobalBalance(Y), 20);
  });

  it("fails cleanly when the asked-for card moved before accepting", () => {
    const mine = mintTo(X);
    const theirs = mintTo(Y);
    const trade = trades.createTrade({ fromUserId: X, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [theirs.id] });
    copies.giveCopy(Y, Z, theirs.id);
    expectHangar(() => trades.acceptTrade(trade.id, Y), "conflict");
    assert.equal(copies.getCopy(mine.id)!.ownerId, X);
    assert.equal(copies.getCopy(mine.id)!.lockedReason, "trade");
    assert.equal(copies.getCopy(theirs.id)!.ownerId, Z);
    assert.equal(trades.getTrade(trade.id)!.status, "pending");
  });

  it("fails cleanly when the asked-for card is locked by a listing", () => {
    const mine = mintTo(X);
    const theirs = mintTo(Y);
    const trade = trades.createTrade({ fromUserId: X, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [theirs.id] });
    market.createListing(Y, theirs.id, 10);
    expectHangar(() => trades.acceptTrade(trade.id, Y), "locked");
    assert.equal(copies.getCopy(mine.id)!.ownerId, X);
    assert.equal(copies.getCopy(theirs.id)!.ownerId, Y);
  });

  it("rolls back the card moves when the sender can't pay the coins", () => {
    const broke = "300000000000000009";
    money.creditGlobal(broke, 60);
    const mine = mintTo(broke);
    const theirs = mintTo(Y);
    const trade = trades.createTrade({ fromUserId: broke, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [theirs.id], giveCoins: 30 });
    // The sender spends the coins elsewhere before the accept.
    copies.expandHangar(broke);
    expectHangar(() => trades.acceptTrade(trade.id, Y), "insufficient_coins");
    assert.equal(copies.getCopy(mine.id)!.ownerId, broke);
    assert.equal(copies.getCopy(theirs.id)!.ownerId, Y);
    assert.equal(trades.getTrade(trade.id)!.status, "pending");
  });

  it("only the recipient accepts, declining unlocks, counters flip direction", () => {
    const mine = mintTo(X);
    const trade = trades.createTrade({ fromUserId: X, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [] });
    expectHangar(() => trades.acceptTrade(trade.id, X), "forbidden");
    expectHangar(() => trades.acceptTrade(trade.id, Z), "forbidden");
    const theirs = mintTo(Y);
    const counter = trades.counterTrade(trade.id, Y, { giveCopyIds: [theirs.id], wantCopyIds: [mine.id] });
    assert.equal(trades.getTrade(trade.id)!.status, "countered");
    assert.equal(copies.getCopy(mine.id)!.lockedReason, null);
    assert.equal(counter.fromUserId, Y);
    assert.equal(counter.parentTradeId, trade.id);
    trades.declineTrade(counter.id, X);
    assert.equal(copies.getCopy(theirs.id)!.lockedReason, null);
  });

  it("expired trades release their locks", () => {
    const mine = mintTo(X);
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    const trade = trades.createTrade({ fromUserId: X, toUserId: Y, giveCopyIds: [mine.id], wantCopyIds: [], at: old });
    assert.ok(trades.expireTrades() >= 1);
    assert.equal(trades.getTrade(trade.id)!.status, "expired");
    assert.equal(copies.getCopy(mine.id)!.lockedReason, null);
  });
});

describe("print runs end to end", () => {
  it("mints serials 1..N, then retires the card and refuses more", () => {
    const owner = "400000000000000001";
    const card = newCard({ printRun: 3, rarity: "rare" });
    const serials = [1, 2, 3].map(() => copies.mintCopy({ cardTypeId: card.id, ownerId: owner, livery: "standard", via: "pack" }).serial);
    assert.deepEqual(serials, [1, 2, 3]);
    const row = getDb().select().from(schema.planeCardTypes).where(eq(schema.planeCardTypes.id, card.id)).get()!;
    assert.ok(row.retiredAt, "retired after the last print");
    expectHangar(() => copies.mintCopy({ cardTypeId: card.id, ownerId: owner, livery: "standard", via: "pack" }), "empty_pool");
    assert.ok(!packs.buildPool({ featuredSetId: null }).some((c) => c.id === card.id));
    expectHangar(() => copies.craftCard(owner, card.id), "not_craftable");
  });

  it("marks the first 100 serials First Edition", () => {
    const owner = "400000000000000002";
    const card = newCard();
    let last = copies.mintCopy({ cardTypeId: card.id, ownerId: owner, livery: "standard", via: "pack" });
    assert.equal(last.firstEdition, true);
    getDb().update(schema.planeCardMintCounters).set({ nextSerial: 101 }).where(eq(schema.planeCardMintCounters.cardTypeId, card.id)).run();
    last = copies.mintCopy({ cardTypeId: card.id, ownerId: owner, livery: "standard", via: "pack" });
    assert.equal(last.serial, 101);
    assert.equal(last.firstEdition, false);
  });
});

describe("Parts, sets and flights", () => {
  const P = "500000000000000001";

  it("salvage pays Parts and crafting spends 4x", () => {
    const card = newCard({ rarity: "rare" });
    const copy = copies.mintCopy({ cardTypeId: card.id, ownerId: P, livery: "gold", via: "pack" });
    const before = ledger.getPartsBalance(P);
    const salvaged = copies.salvageCopies(P, [copy.id]);
    assert.equal(salvaged.parts, Math.round(30 * 3 * 1.25));
    assert.equal(ledger.getPartsBalance(P), before + salvaged.parts);
    assert.equal(copies.getCopy(copy.id), null);
    expectHangar(() => copies.craftCard(P, newCard({ rarity: "legendary" }).id), "insufficient_parts");
    ledger.grantParts(P, 10, "grant");
    const crafted = copies.craftCard(P, card.id);
    assert.equal(crafted.cost, 120);
    assert.equal(crafted.copy.livery, "standard");
  });

  it("completing a set pays its bonus exactly once", () => {
    const user = "500000000000000002";
    const c1 = newCard();
    const c2 = newCard();
    const set = sets.createSet({ key: "test-set", name: "Test Set", bonusParts: 77, cardTypeIds: [c1.id, c2.id] });
    copies.mintCopy({ cardTypeId: c1.id, ownerId: user, livery: "standard", via: "gift" });
    assert.equal(score.refreshUserScore(user).newlyCompletedSets.length, 0);
    const second = copies.mintCopy({ cardTypeId: c2.id, ownerId: user, livery: "standard", via: "gift" });
    const result = score.refreshUserScore(user);
    assert.deepEqual(result.newlyCompletedSets.map((s) => s.setId), [set.id]);
    assert.equal(ledger.getPartsBalance(user), 77);
    // Lose and regain it: no second bonus.
    copies.salvageCopies(user, [second.id]);
    copies.mintCopy({ cardTypeId: c2.id, ownerId: user, livery: "standard", via: "gift" });
    score.refreshUserScore(user);
    assert.equal(ledger.getPartsBalance(user), 77 + 15); // + the salvage of the uncommon copy (12 x 1.25)
  });

  it("flights lock the plane, settle once on claim, and allow one flight per card per day", () => {
    const user = "500000000000000003";
    const plane = mintTo(user);
    const start = new Date("2026-03-01T10:00:00Z");
    const flight = flights.startFlight({ userId: user, copyId: plane.id, route: "medium", at: start });
    assert.equal(copies.getCopy(plane.id)!.lockedReason, "flight");
    expectHangar(() => copies.salvageCopies(user, [plane.id]), "locked");
    // Not landed yet: nothing to claim.
    assert.equal(flights.claimFlights(user, seededRng(1), new Date(start.getTime() + 60_000)).claimed.length, 0);
    const landing = new Date(flight.endsAt.getTime() + 1000);
    const claim = flights.claimFlights(user, seededRng(1), landing);
    assert.equal(claim.claimed.length, 1);
    assert.ok(claim.parts > 0);
    assert.equal(copies.getCopy(plane.id)!.lockedReason, null);
    assert.equal(copies.getCopy(plane.id)!.xp, ROUTES.medium.xp);
    // Claiming again pays nothing.
    assert.equal(flights.claimFlights(user, seededRng(1), landing).claimed.length, 0);
    // Same UTC day: grounded.
    expectHangar(() => flights.startFlight({ userId: user, copyId: plane.id, route: "short", at: landing }), "cooldown");
    // Next day: fine.
    flights.startFlight({ userId: user, copyId: plane.id, route: "short", at: new Date("2026-03-02T01:00:00Z") });
  });

  it("checks route requirements and keeps the test route for superusers", () => {
    const user = "500000000000000004";
    const weak = createPlaneType({
      key: "weak-plane",
      name: "Weak Plane",
      cardType: "plane",
      subtitle: "",
      rarity: "common",
      safety: 30,
      speed: 20,
      agility: 50,
      passengerCount: 2,
      imageKey: "",
      createdBy: "test",
    });
    const copy = copies.mintCopy({ cardTypeId: weak.id, ownerId: user, livery: "standard", via: "gift" });
    expectHangar(() => flights.startFlight({ userId: user, copyId: copy.id, route: "long" }), "requirements");
    expectHangar(() => flights.startFlight({ userId: user, copyId: copy.id, route: "test" }), "forbidden");
  });

  it("the boarding pass pays once a day and keeps a streak", () => {
    const user = "500000000000000005";
    const day = 24 * 60 * 60 * 1000;
    const t0 = new Date("2026-04-01T12:00:00Z").getTime();
    const first = packs.claimBoardingPass(user, "g", seededRng(5), new Date(t0));
    assert.equal(first.copies.length, 1);
    assert.equal(first.streak, 1);
    expectHangar(() => packs.claimBoardingPass(user, "g", seededRng(5), new Date(t0 + day - 1000)), "cooldown");
    let streak = 1;
    let bonus = 0;
    for (let d = 1; d < 7; d++) {
      const r = packs.claimBoardingPass(user, "g", seededRng(5 + d), new Date(t0 + d * day));
      streak = r.streak;
      bonus += r.streakBonusParts;
    }
    assert.equal(streak, 7);
    assert.equal(bonus, 30);
    // Missing more than two days resets it.
    assert.equal(packs.claimBoardingPass(user, "g", seededRng(99), new Date(t0 + 10 * day)).streak, 1);
  });

  it("packs burn their price and respect hangar capacity", () => {
    const user = "500000000000000006";
    money.creditGlobal(user, 30);
    const result = packs.openPack(user, "g", "economy", seededRng(8));
    assert.equal(result.copies.length, 3);
    assert.equal(money.getGlobalBalance(user), 5);
    expectHangar(() => packs.openPack(user, "g", "economy", seededRng(8)), "insufficient_coins");
    assert.equal(copies.countUserCopies(user), 3);
  });
});

describe("erasing a user's Hangar", () => {
  const Q = "600000000000000001";
  const R = "600000000000000002";

  it("cancels their trades and listings, removes their copies, and keeps economy totals anonymous", async () => {
    const erase = await import("./erase.js");
    money.creditGlobal(Q, 60);
    const mine = mintTo(Q);
    const listed = mintTo(Q);
    const theirs = mintTo(R);
    market.createListing(Q, listed.id, 10);
    trades.createTrade({ fromUserId: R, toUserId: Q, giveCopyIds: [theirs.id], wantCopyIds: [mine.id] });
    assert.equal(copies.getCopy(theirs.id)!.lockedReason, "trade");
    packs.openPack(Q, "g", "economy", seededRng(3));

    erase.deleteUserHangarData(Q);

    assert.equal(copies.countUserCopies(Q), 0);
    assert.equal(copies.getCopy(mine.id), null);
    // The other side's card is released and still theirs.
    assert.equal(copies.getCopy(theirs.id)!.ownerId, R);
    assert.equal(copies.getCopy(theirs.id)!.lockedReason, null);
    const left = erase.exportUserHangarData(Q);
    assert.equal(left.copies.length + left.trades.length + left.listings.length + left.coins.length + left.packOpenings.length, 0);
    const burned = getDb()
      .select()
      .from(schema.planeCoinLedger)
      .where(eq(schema.planeCoinLedger.userId, erase.ERASED_USER_ID))
      .all();
    assert.ok(burned.some((row) => row.kind === "pack"));
  });
});
