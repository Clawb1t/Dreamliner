import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";

// Isolated scratch DB, set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-webhangar-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../db/client.js");
const money = await import("../plugins/economy/functions/money.js");
const web = await import("./webHangar.js");
const { buildPublicProfileCards } = await import("./userPublicProfile.js");
const { upsertUserProfileFields } = await import("./userProfiles.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* harmless */
  }
});

/** Just enough of a Client for the user lookups (nobody resolves; entries get `user: null`). */
const client = {
  users: { cache: new Map(), fetch: async () => null },
  guilds: { cache: new Map() },
} as unknown as Client;

const ME = "600000000000000001";
const YOU = "600000000000000002";

type Body = Record<string, unknown> & { ok: boolean };

async function call(userId: string, method: string, rest: string, body: Record<string, unknown> = {}, query = ""): Promise<{ status: number; body: Body }> {
  const result = await web.handleUserHangar({
    client,
    userId,
    rest,
    method,
    query: new URLSearchParams(query),
    readJson: async () => body,
    isSuperuser: false,
  });
  assert.ok(!("binary" in result));
  return result as { status: number; body: Body };
}

async function admin(method: string, rest: string, body: Record<string, unknown> = {}, query = ""): Promise<{ status: number; body: Body }> {
  return (await web.handlePlatformHangar({ rest, method, query: new URLSearchParams(query), body })) as { status: number; body: Body };
}

describe("user-scoped Hangar routes", () => {
  it("covers a full session: boarding, packs, collection, flights, market, trades, leaderboards", async () => {
    money.creditGlobal(ME, 1000);
    money.creditGlobal(YOU, 1000);

    const overview = await call(ME, "GET", "");
    assert.equal(overview.status, 200);
    assert.equal((overview.body.overview as { boarding: { available: boolean } }).boarding.available, true);

    const packs = await call(ME, "GET", "packs");
    assert.deepEqual((packs.body.packs as { key: string }[]).map((p) => p.key), ["economy", "business", "first_class"]);

    const boarding = await call(ME, "POST", "boarding/claim");
    assert.equal(boarding.status, 200);
    assert.equal((boarding.body.copies as unknown[]).length, 1);
    const again = await call(ME, "POST", "boarding/claim");
    assert.equal(again.status, 429);
    assert.equal(again.body.code, "cooldown");

    const opened = await call(ME, "POST", "packs/business/open");
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal((opened.body.copies as unknown[]).length, 5);
    await call(YOU, "POST", "packs/first_class/open");

    for (const sort of ["newest", "oldest", "rarity", "level", "serial", "name"]) {
      const page = await call(ME, "GET", "collection", {}, `sort=${sort}&pageSize=3&locked=false`);
      assert.equal(page.status, 200);
      assert.equal(page.body.total, 6);
      assert.equal((page.body.copies as unknown[]).length, 3);
    }
    const all = (await call(ME, "GET", "collection", {}, "pageSize=60")).body.copies as { id: number; card: { cardType: string; id: number } }[];
    const detail = await call(ME, "GET", `copies/${all[0]!.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.owner, true);

    // Someone else's copy is hidden unless they show their cards.
    const theirs = (await call(YOU, "GET", "collection")).body.copies as { id: number }[];
    assert.equal((await call(ME, "GET", `copies/${theirs[0]!.id}`)).status, 404);

    assert.equal((await call(ME, "GET", "catalog")).status, 200);
    assert.equal((await call(ME, "GET", "sets")).status, 200);
    assert.equal((await call(ME, "PUT", "showcase", { copyIds: [all[0]!.id] })).status, 200);

    // Flights.
    const flightsInfo = await call(ME, "GET", "flights");
    assert.ok(!(flightsInfo.body.routes as { key: string }[]).some((r) => r.key === "test"), "test route hidden from non-superusers");
    const plane = all.find((c) => c.card.cardType === "plane");
    if (plane) {
      const routes = await call(ME, "GET", "flights/routes", {}, `copyId=${plane.id}`);
      assert.equal(routes.status, 200);
      const started = await call(ME, "POST", "flights/start", { copyId: plane.id, route: "short" });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const locked = await call(ME, "POST", "salvage", { copyIds: [plane.id] });
      assert.equal(locked.body.code, "locked");
      assert.equal((await call(ME, "POST", "flights/claim")).status, 200);
    }

    // Market.
    const sellable = ((await call(ME, "GET", "collection", {}, "locked=false&pageSize=60")).body.copies as { id: number }[])[0]!;
    const listed = await call(ME, "POST", "market/list", { copyId: sellable.id, price: 150 });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const listingId = (listed.body.listing as { id: number }).id;
    const browse = await call(YOU, "GET", "market", {}, "sort=price_asc");
    assert.ok((browse.body.listings as { id: number }[]).some((l) => l.id === listingId));
    const bought = await call(YOU, "POST", `market/${listingId}/buy`);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    assert.equal(bought.body.fee, 7.5);
    assert.equal((await call(ME, "POST", `market/${listingId}/buy`)).body.code, "conflict");
    assert.equal((await call(ME, "GET", "market", {}, "mine=true")).status, 200);

    // Trades.
    const mine = ((await call(ME, "GET", "collection", {}, "locked=false")).body.copies as { id: number }[])[0]!;
    const want = ((await call(YOU, "GET", "collection", {}, "locked=false")).body.copies as { id: number }[])[0]!;
    const offer = await call(ME, "POST", "trades", { toUserId: YOU, giveCopyIds: [mine.id], wantCopyIds: [want.id], giveCoins: 10 });
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    const tradeId = (offer.body.trade as { id: number }).id;
    assert.equal((await call(ME, "POST", `trades/${tradeId}/accept`)).body.code, "forbidden");
    const inbox = await call(YOU, "GET", "trades");
    assert.equal((inbox.body.trades as { direction: string }[])[0]!.direction, "incoming");
    const accepted = await call(YOU, "POST", `trades/${tradeId}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((accepted.body.trade as { status: string }).status, "accepted");

    for (const board of ["fleet_value", "rarest", "sets", "flights_weekly"]) {
      const lb = await call(ME, "GET", "leaderboard", {}, `board=${board}`);
      assert.equal(lb.status, 200);
      assert.equal(lb.body.board, board);
    }
    assert.equal((await call(ME, "GET", "leaderboard", {}, "guildId=123456789012345678")).status, 404);
    assert.equal((await call(ME, "GET", "nope")).status, 404);
  });

  it("renders copy and type faces as PNG", async () => {
    const copies = (await call(ME, "GET", "collection")).body.copies as { id: number; card: { id: number } }[];
    const copy = await web.handleHangarRender("copy", copies[0]!.id, new URLSearchParams({ viewer: ME }));
    assert.ok("binary" in copy && copy.binary.subarray(1, 4).toString() === "PNG");
    // A hidden collection's copies don't render for anyone else.
    assert.equal((await web.handleHangarRender("copy", copies[0]!.id, new URLSearchParams())).status, 404);
    const type = await web.handleHangarRender("type", copies[0]!.card.id, new URLSearchParams("livery=gold&edition=first&level=5"));
    assert.ok("binary" in type && type.contentType === "image/png");
    assert.equal((await web.handleHangarRender("copy", 999999, new URLSearchParams())).status, 404);
  });

  it("public profile cards respect showTradingCards", async () => {
    const hidden = await buildPublicProfileCards(ME);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.cards.length, 0);
    await upsertUserProfileFields(ME, { showTradingCards: true });
    const shown = await buildPublicProfileCards(ME);
    assert.equal(shown.visible, true);
    assert.ok(shown.totalCards > 0);
    assert.ok(shown.pilotRank);
    assert.equal(shown.showcase.length <= 3, true);
    // Now ME's copies are visible to others.
    const copies = (await call(ME, "GET", "collection")).body.copies as { id: number }[];
    assert.equal((await call(YOU, "GET", `copies/${copies[0]!.id}`)).status, 200);
  });
});

describe("superuser Hangar routes", () => {
  it("sets, packs (with odds validation and preview) and health", async () => {
    const set = await admin("POST", "sets", { key: "My Set", name: "My Set", bonusParts: 10, cardTypeIds: [1, 2] });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const setId = (set.body.set as { id: number; key: string }).id;
    assert.equal((set.body.set as { key: string }).key, "my-set");
    assert.equal((await admin("PUT", `sets/${setId}`, { cardTypeIds: [1] })).status, 200);

    const bad = await admin("POST", "packs", { key: "x", name: "X", price: 10, size: 3, rarityOdds: { common: 0 } });
    assert.equal(bad.status, 400);
    const unknownKey = await admin("POST", "packs", { key: "x", name: "X", price: 10, size: 3, rarityOdds: { shiny: 1 } });
    assert.equal(unknownKey.status, 400);
    const pityHalf = await admin("POST", "packs", { key: "x", name: "X", price: 10, size: 3, rarityOdds: { common: 1 }, pityRarity: "legendary" });
    assert.equal(pityHalf.status, 400);

    const limited = await admin("POST", "packs", {
      key: "Limited Launch",
      name: "Launch",
      price: 50,
      size: 2,
      rarityOdds: { common: 1, rare: 1 },
      featuredSetId: setId,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(limited.status, 200, JSON.stringify(limited.body));
    const pack = limited.body.pack as { id: number; key: string; active: boolean; availableCards: number };
    assert.equal(pack.key, "limited_launch");
    assert.equal(pack.active, true);
    assert.equal(pack.availableCards, 1);
    assert.equal((await admin("DELETE", `sets/${setId}`)).body.code, "conflict");

    const preview = await admin("POST", "packs/preview", { size: 5, rarityOdds: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }, guaranteeRarity: "uncommon", packs: 1000 });
    assert.equal(preview.status, 200);
    assert.ok((preview.body.preview as { expectedPartsPerPack: number }).expectedPartsPerPack > 0);

    assert.equal((await admin("PUT", `packs/${pack.id}`, { enabled: false })).status, 200);
    assert.equal((await admin("DELETE", `packs/${pack.id}`)).status, 200);
    const economy = (await admin("GET", "packs")).body.packs as { id: number; key: string }[];
    assert.equal((await admin("DELETE", `packs/${economy.find((p) => p.key === "economy")!.id}`)).status, 400);
    assert.equal((await admin("DELETE", `sets/${setId}`)).status, 200);

    const health = await admin("GET", "health");
    assert.equal(health.status, 200);
    const h = health.body.health as { coins: { netFlow: number; burned: number }; packs: { key: string; naturalPulls: number }[] };
    assert.ok(h.coins.netFlow <= 0);
    assert.ok(h.coins.burned > 0);
    assert.ok(h.packs.find((p) => p.key === "business")!.naturalPulls > 0);
  });
});
