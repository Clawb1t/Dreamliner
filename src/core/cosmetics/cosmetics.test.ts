import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see credits.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-cosmetics-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const products = await import("../store/products.js");
const credits = await import("../store/credits.js");
const miles = await import("../store/miles.js");
const settings = await import("../store/settings.js");
const equip = await import("./equip.js");
const { parseSlotStyle } = await import("./schema.js");
const { BACKGROUND_IDS, COSMETIC_SLOTS, SLOT_STYLE_KEY, leaderboardCosmetics } = await import("./types.js");
const { NAME_FONT_IDS } = await import("./fonts.js");
const { getDb } = await import("../../db/client.js");
const { storeCreditLedger, storeProducts } = await import("../../db/schema.js");
const { eq } = await import("drizzle-orm");

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

function giveMiles(userId: string, amount: number) {
  miles.grantCurrency({ actorId: "admin", targetUserId: userId, currency: "miles", amount, note: "test" });
}

function giveCredits(userId: string, amount: number) {
  miles.grantCurrency({ actorId: "admin", targetUserId: userId, currency: "credits", amount, note: "test" });
}

function buy(userId: string, productId: string, currency?: "miles" | "credits", requestId?: string) {
  return products.purchaseProduct({ userId, productId, input: {}, currency, requestId });
}

describe("starter catalog seed", () => {
  it("every seeded cosmetic parses and every slot is stocked", () => {
    const rows = getDb().select().from(storeProducts).all();
    const cosmetics = rows.filter((row) => row.type === "cosmetic");
    assert.ok(cosmetics.length >= 50);
    const slots = new Set<string>();
    for (const row of cosmetics) {
      const config = JSON.parse(row.configJson) as { slot: (typeof COSMETIC_SLOTS)[number]; style: unknown };
      const parsed = parseSlotStyle(config.slot, config.style);
      assert.ok(parsed.ok, `${row.id}: ${parsed.ok ? "" : parsed.error}`);
      assert.ok(row.priceMiles !== null && row.priceMiles >= 300 && row.priceMiles <= 2000, row.id);
      slots.add(config.slot);
      // Loads through the catalog too (a broken config would be skipped).
      assert.equal(products.getProduct(row.id)?.type, "cosmetic", row.id);
    }
    assert.deepEqual([...slots].sort(), [...COSMETIC_SLOTS].sort());
    const fonts = cosmetics.map((row) => JSON.parse(row.configJson) as { slot: string; style: { fontId?: string } })
      .filter((config) => config.slot === "name_font")
      .map((config) => config.style.fontId);
    assert.deepEqual([...fonts].sort(), [...NAME_FONT_IDS].sort());
    // One background product per registry id, no stills yet; the retired slots are gone.
    const backgrounds = cosmetics
      .map((row) => ({ row, config: JSON.parse(row.configJson) as { slot: string; style: Record<string, unknown> } }))
      .filter(({ config }) => config.slot === "background");
    assert.deepEqual(backgrounds.map(({ config }) => config.style.bgId).sort(), [...BACKGROUND_IDS].sort());
    for (const { row, config } of backgrounds) {
      assert.equal(row.id, `bg-${config.style.bgId}`);
      assert.equal(row.section, "Backgrounds");
      assert.ok(row.priceMiles! >= 1200 && row.priceMiles! <= 2000, row.id);
      assert.equal(config.style.rankStillAssetId, null);
      assert.equal(config.style.profileStillAssetId, null);
    }
    assert.equal(cosmetics.filter((row) => /"slot":"(card_theme|profile_effect)"/.test(row.configJson)).length, 0);
  });

  it("seeds three discounted bundles of real cosmetics, Halloween ending soon", () => {
    for (const id of ["bundle-halloween", "bundle-night-owl", "bundle-starter"]) {
      const bundle = products.getProduct(id);
      assert.ok(bundle && bundle.type === "bundle", id);
      const payload = products.toProductPayload(bundle);
      assert.ok(payload.bundleItems && payload.bundleItems.length >= 4, id);
      assert.equal(payload.bundleItems.length, products.bundleConfigOf(bundle)!.productIds.length, `${id} has a missing item`);
      assert.ok(payload.priceMiles! >= 2000 && payload.priceMiles! <= 4000);
      assert.ok(payload.priceMiles! < payload.bundleValueMiles!, `${id} isn't a discount`);
    }
    assert.ok(products.getProduct("bundle-halloween")!.endsAt);
    assert.ok(products.bundleConfigOf(products.getProduct("bundle-night-owl")!)!.productIds.includes("bg-shooting-stars"));
    assert.ok(products.bundleConfigOf(products.getProduct("bundle-halloween")!)!.productIds.includes("bg-fog"));
  });

  it("the catalog carries the Miles rate and packs", () => {
    const catalog = products.getStoreCatalog();
    assert.equal(catalog.pricing.creditsPerMile, 2);
    assert.deepEqual(
      catalog.milesPacks.map((pack) => [pack.id, pack.miles, pack.price]),
      [
        ["miles_2000", 2000, "£1.99"],
        ["miles_5500", 5500, "£4.99"],
        ["miles_12000", 12000, "£9.99"],
        ["miles_26000", 26000, "£39.99"],
      ],
    );
    const glow = catalog.products.find((product) => product.id === "glow-aurora")!;
    assert.equal(glow.slot, "profile_glow");
    assert.deepEqual(glow.style, { glow: { colors: ["#4ade80", "#22d3ee"], intensity: 0.7 } });
    assert.equal(glow.priceCredits, 1200);
    const one = catalog.products.find((product) => product.id === "dreamliner-one")!;
    assert.equal(one.priceMiles, null);
    assert.equal(one.slot, null);
  });
});

describe("buying cosmetics", () => {
  it("buys once, auto-equips into an empty slot, then refuses already_owned", () => {
    giveMiles("c-once", 2000);
    const receipt = buy("c-once", "glow-aurora");
    assert.equal(receipt.currency, "miles");
    assert.equal(receipt.cost, 600);
    assert.equal(receipt.balance, 1400);
    assert.deepEqual(receipt.grantedProductIds, ["glow-aurora"]);
    assert.equal(equip.getEquippedCosmetics("c-once").profile_glow, "glow-aurora");
    assert.throws(() => buy("c-once", "glow-aurora"), { code: "already_owned" });
    assert.equal(products.purchaseErrorStatus("already_owned"), 409);
    assert.equal(miles.getMilesBalance("c-once"), 1400);

    // A second glow doesn't replace the one already worn.
    buy("c-once", "glow-ocean");
    assert.equal(equip.getEquippedCosmetics("c-once").profile_glow, "glow-aurora");
  });

  it("prices credits at ceil(priceMiles x creditsPerMile)", () => {
    giveCredits("c-credits", 5000);
    assert.equal(buy("c-credits", "font-pixel", "credits").cost, 800);
    settings.updateStoreSettings({ creditsPerMile: 1.25 }, "admin");
    assert.equal(products.unitPrice(products.getProduct("font-slab")!, "credits"), 375);
    assert.equal(buy("c-credits", "font-slab", "credits").cost, 375);
    assert.equal(credits.getCreditBalance("c-credits"), 5000 - 800 - 375);
    settings.updateStoreSettings({ creditsPerMile: 2 }, "admin");
    assert.equal(settings.creditsForMiles(333, 1.5), 500);
    assert.throws(() => settings.updateStoreSettings({ creditsPerMile: 0 }, "admin"));
  });

  it("refuses short balances with insufficient_miles / insufficient_credits", () => {
    giveMiles("c-poor", 100);
    giveCredits("c-poor", 100);
    assert.throws(() => buy("c-poor", "frame-gold"), { code: "insufficient_miles" });
    assert.throws(() => buy("c-poor", "frame-gold", "credits"), { code: "insufficient_credits" });
    assert.equal(miles.getMilesBalance("c-poor"), 100);
  });

  it("refuses Dreamliner One for Miles with wrong_currency", () => {
    giveMiles("c-one", 5000);
    assert.throws(
      () => products.purchaseProduct({ userId: "c-one", productId: "dreamliner-one", input: { guildId: "g1", days: 2 }, currency: "miles" }),
      { code: "wrong_currency" },
    );
    assert.equal(products.purchaseErrorStatus("wrong_currency"), 400);
  });

  it("claims a free (price 0) cosmetic without any balance, once", () => {
    products.createProduct(
      { id: "free-title", type: "cosmetic", name: "Free Title", priceMiles: 0, slot: "title", style: { text: "Beta Tester", color: "#ffffff" } },
      "admin",
    );
    const receipt = buy("c-free", "free-title", undefined, "claim-1");
    assert.equal(receipt.cost, 0);
    assert.equal(buy("c-free", "free-title", undefined, "claim-1").replayed, true);
    assert.throws(() => buy("c-free", "free-title"), { code: "already_owned" });
    assert.equal(equip.getEquippedCosmetics("c-free").title, "free-title");
  });

  it("a bundle grants only the missing items, and refuses when all are owned", () => {
    giveMiles("c-bundle", 10_000);
    buy("c-bundle", "icon-moon");
    const receipt = buy("c-bundle", "bundle-night-owl", undefined, "bundle-1");
    assert.equal(receipt.cost, 2100);
    assert.deepEqual(receipt.grantedProductIds.sort(), ["bg-shooting-stars", "glow-midnight", "title-night-owl"].sort());
    const replay = buy("c-bundle", "bundle-night-owl", undefined, "bundle-1");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.grantedProductIds.sort(), receipt.grantedProductIds.sort());
    assert.throws(() => buy("c-bundle", "bundle-night-owl"), { code: "already_owned" });
    const owned = equip.listOwnedCosmetics("c-bundle").map((product) => product.id).sort();
    assert.deepEqual(owned, ["bg-shooting-stars", "glow-midnight", "icon-moon", "title-night-owl"]);
    const equipped = equip.getEquippedCosmetics("c-bundle");
    assert.equal(equipped.background, "bg-shooting-stars");
    assert.equal(equipped.name_icon, "icon-moon");
  });
});

describe("equipping", () => {
  it("requires ownership and the right slot, and empties a slot with null", () => {
    giveMiles("c-equip", 3000);
    buy("c-equip", "font-mono");
    buy("c-equip", "font-pixel");
    assert.deepEqual(equip.equipCosmetic("c-equip", "name_font", "font-gold" as string), { ok: false, status: 403, error: "You don't own that cosmetic." });
    assert.equal((equip.equipCosmetic("c-equip", "name_font", "glow-aurora") as { status: number }).status, 403);
    assert.equal((equip.equipCosmetic("c-equip", "title", "font-pixel") as { status: number }).status, 400);
    assert.equal((equip.equipCosmetic("c-equip", "hat", "font-pixel") as { status: number }).status, 400);
    const ok = equip.equipCosmetic("c-equip", "name_font", "font-pixel");
    assert.ok(ok.ok);
    assert.equal(ok.equipped.name_font, "font-pixel");
    assert.deepEqual(equip.getEquippedStyle("c-equip"), { nameFont: { fontId: "pixel" } });
    const cleared = equip.equipCosmetic("c-equip", "name_font", null);
    assert.ok(cleared.ok && cleared.equipped.name_font === null);
    assert.deepEqual(equip.getEquippedStyle("c-equip"), {});
    assert.equal(equip.deleteEquippedCosmetics("c-equip"), 0);
  });

  it("resolves many users' styles in one batch, with uploaded art as URLs", () => {
    products.createProduct(
      {
        id: "art-frame",
        type: "cosmetic",
        name: "Art Frame",
        priceMiles: 0,
        slot: "avatar_frame",
        style: { frame: { preset: "gold", colors: ["#ffcc00"], imageUrl: "/api/store/assets/abc123" } },
      },
      "admin",
    );
    giveMiles("c-batch-a", 5000);
    buy("c-batch-a", "art-frame");
    buy("c-batch-a", "color-gold");
    buy("c-batch-a", "flair-gold");
    buy("c-batch-a", "bg-snow");
    // A background with generated stills resolves them to site URLs.
    products.updateProduct("bg-snow", { style: { bgId: "snow", colors: ["#FFFFFF"], rankStillAssetId: "rank123", profileStillUrl: "/api/store/assets/prof456" } }, "admin");
    const styles = equip.getEquippedCosmeticsForUsers(["c-batch-a", "c-batch-b", "c-batch-a"]);
    assert.equal(styles.size, 2);
    assert.deepEqual(styles.get("c-batch-b"), {});
    const a = styles.get("c-batch-a")!;
    assert.deepEqual(a.frame, { preset: "gold", colors: ["#ffcc00"], imageUrl: "/api/store/assets/abc123" });
    assert.deepEqual(a.nameColor, { style: "solid", colors: ["#facc15"] });
    assert.deepEqual(a.background, {
      bgId: "snow",
      colors: ["#ffffff"],
      rankStillUrl: "/api/store/assets/rank123",
      profileStillUrl: "/api/store/assets/prof456",
      rankFramesUrls: [],
      profileFramesUrls: [],
      frameCount: null,
      fps: null,
    });
    // Generated animation frames resolve to URL lists, and pruning keeps every sheet.
    products.updateProduct(
      "bg-snow",
      {
        style: {
          bgId: "snow",
          colors: [],
          rankFramesAssetIds: ["rf1", "/api/store/assets/rf2"],
          profileFramesUrls: ["/api/store/assets/pf1"],
          frameCount: 24,
          fps: 12,
        },
      },
      "admin",
    );
    const framed = equip.getEquippedCosmeticsForUsers(["c-batch-a"]).get("c-batch-a")!.background!;
    assert.deepEqual(framed.rankFramesUrls, ["/api/store/assets/rf1", "/api/store/assets/rf2"]);
    assert.deepEqual(framed.profileFramesUrls, ["/api/store/assets/pf1"]);
    assert.equal(framed.frameCount, 24);
    assert.equal(framed.fps, 12);
    const kept = products.referencedStoreAssetIds();
    for (const id of ["rf1", "rf2", "pf1"]) assert.ok(kept.has(id), `${id} would be pruned`);
    const subset = leaderboardCosmetics(a)!;
    assert.deepEqual(Object.keys(subset).sort(), ["background", "flair", "frame", "nameColor"]);
    assert.equal(leaderboardCosmetics({}), null);
    // Equipping drops the cache.
    equip.equipCosmetic("c-batch-a", "name_color", null);
    assert.equal(equip.getEquippedCosmeticsForUsers(["c-batch-a"]).get("c-batch-a")!.nameColor, undefined);
  });
});

describe("per-slot config validation", () => {
  it("accepts each slot's shape and rejects bad ones", () => {
    const good: Record<(typeof COSMETIC_SLOTS)[number], unknown> = {
      profile_glow: { colors: ["#FF0000"], intensity: 0.5 },
      name_font: { fontId: "mono" },
      name_color: { style: "gradient", colors: ["#ff0000", "00ff00"] },
      avatar_frame: { preset: "stars", colors: ["#ffffff"] },
      background: { bgId: "aurora" },
      title: { text: "  Captain  " },
      name_icon: { emoji: "✈️" },
      rank_bar: { style: "striped", colors: ["#123456"] },
      leaderboard_flair: { style: "shimmer", color: "#abcdef" },
    };
    for (const slot of COSMETIC_SLOTS) {
      const parsed = parseSlotStyle(slot, good[slot]);
      assert.ok(parsed.ok, `${slot}: ${parsed.ok ? "" : parsed.error}`);
      // The wrapped CosmeticStyle form works too.
      assert.ok(parseSlotStyle(slot, { [SLOT_STYLE_KEY[slot]]: good[slot] }).ok, slot);
    }
    const color = parseSlotStyle("name_color", good.name_color);
    assert.ok(color.ok && JSON.stringify(color.style) === JSON.stringify({ style: "gradient", colors: ["#ff0000", "#00ff00"] }));
    const title = parseSlotStyle("title", good.title);
    assert.ok(title.ok && JSON.stringify(title.style) === JSON.stringify({ text: "Captain", color: null }));

    const bad: Array<[(typeof COSMETIC_SLOTS)[number], unknown]> = [
      ["profile_glow", { colors: ["#ff0000"], intensity: 2 }],
      ["profile_glow", { colors: [], intensity: 0.5 }],
      ["name_font", { fontId: "comic-sans" }],
      ["name_color", { style: "gradient", colors: ["#ff0000"] }],
      ["name_color", { style: "rainbow", colors: ["#ff0000"] }],
      ["avatar_frame", { preset: "neon", colors: ["red"] }],
      ["avatar_frame", { preset: "neon", colors: ["#ff0000"], imageUrl: "https://evil.example/x.png" }],
      ["background", { bgId: "glitch" }],
      ["background", { bgId: "aurora", rankStillUrl: "https://evil.example/x.png" }],
      ["background", { bgId: "aurora", colors: ["#fff", "#000", "#111", "#222", "#333"] }],
      ["title", { text: "" }],
      ["title", { text: "x".repeat(33) }],
      ["name_icon", { emoji: "🔥🔥" }],
      ["name_icon", {}],
      ["rank_bar", { style: "dotted", colors: ["#ffffff"] }],
      ["leaderboard_flair", { style: "glow" }],
    ];
    for (const [slot, value] of bad) assert.equal(parseSlotStyle(slot, value).ok, false, `${slot} ${JSON.stringify(value)}`);
  });

  it("validates admin cosmetic and bundle input", () => {
    assert.throws(() => products.createProduct({ id: "c-x", type: "cosmetic", name: "X", priceMiles: 10, slot: "hat", style: {} }, "admin"), {
      field: "slot",
    });
    assert.throws(
      () => products.createProduct({ id: "c-x", type: "cosmetic", name: "X", priceMiles: 10, slot: "title", style: { text: "" } }, "admin"),
      { field: "style.text" },
    );
    assert.throws(() => products.createProduct({ id: "c-x", type: "cosmetic", name: "X", slot: "title", style: { text: "Hi" } }, "admin"), {
      field: "priceMiles",
    });
    assert.throws(() => products.createProduct({ id: "b-x", type: "bundle", name: "B", priceMiles: 10, bundleProductIds: ["glow-aurora"] }, "admin"), {
      field: "bundleProductIds",
    });
    assert.throws(
      () => products.createProduct({ id: "b-x", type: "bundle", name: "B", priceMiles: 10, bundleProductIds: ["glow-aurora", "dreamliner-one"] }, "admin"),
      { field: "bundleProductIds" },
    );
    const bundle = products.createProduct({ id: "b-ok", type: "bundle", name: "B", priceMiles: 900, bundleProductIds: ["glow-aurora", "glow-ocean"] }, "admin");
    assert.equal(products.toProductPayload(bundle).bundleValueMiles, 1100);
    const updated = products.updateProduct("free-title", { style: { text: "Alpha Tester" } }, "admin")!;
    assert.deepEqual(products.toProductPayload(updated).style, { title: { text: "Alpha Tester", color: null } });
  });
});

describe("Miles purchases", () => {
  it("pays an entitlement once and consumes it once", async () => {
    process.env.DISCORD_MILES_SKU_2000 = "111111111111111111";
    process.env.DISCORD_MILES_SKU_5500 = "222222222222222222";
    const consumed: string[] = [];
    const notified: string[] = [];
    const deps = {
      consume: async (id: string) => {
        consumed.push(id);
      },
      notify: async (userId: string) => {
        notified.push(userId);
      },
    };
    const entitlement = { id: "900000000000000001", skuId: "111111111111111111", userId: "m-buyer", consumed: false };
    assert.equal(await miles.processMilesEntitlement(entitlement, deps), "granted");
    assert.equal(await miles.processMilesEntitlement(entitlement, deps), "already_paid");
    const rows = getDb().select().from(storeCreditLedger).where(eq(storeCreditLedger.entitlementId, entitlement.id)).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "miles_purchase");
    assert.equal(rows[0]!.currency, "miles");
    assert.deepEqual(consumed, [entitlement.id]);
    assert.deepEqual(notified, ["m-buyer"]);
    assert.equal(miles.getMilesBalance("m-buyer"), 2000);
    assert.equal(credits.getCreditBalance("m-buyer"), 0);
    assert.equal(await miles.processMilesEntitlement({ ...entitlement, id: "900000000000000002", skuId: "999" }, deps), "ignored");

    const history = credits.listLedger("m-buyer");
    assert.equal(history[0]!.kind, "miles_purchase");
    assert.equal(history[0]!.currency, "miles");
  });

  it("reconciles unconsumed entitlements and moves the cursor", async () => {
    process.env.DISCORD_MILES_SKU_2000 = "111111111111111111";
    const pages = [
      { id: "900000000000000010", skuId: "111111111111111111", userId: "m-rec", consumed: true },
      { id: "900000000000000011", skuId: "111111111111111111", userId: "m-rec", consumed: false },
      { id: "900000000000000012", skuId: "111111111111111111", userId: "m-rec", consumed: false },
    ];
    let cursor: string | null = null;
    let failOnce = true;
    const deps = {
      consume: async (id: string) => {
        if (id === "900000000000000012" && failOnce) {
          failOnce = false;
          throw new Error("discord down");
        }
      },
    };
    const store = { get: () => cursor, set: (value: string) => void (cursor = value) };
    const fetchPage = async ({ after }: { after?: string }) => pages.filter((page) => !after || BigInt(page.id) > BigInt(after));
    const first = await miles.reconcileMilesEntitlements(fetchPage, deps, store);
    assert.equal(first.processed, 2);
    assert.equal(first.granted, 1); // the other was paid but not consumed yet
    assert.equal(miles.getMilesBalance("m-rec"), 4000);
    assert.equal(cursor, "900000000000000011"); // just below the one that failed to consume
    const second = await miles.reconcileMilesEntitlements(fetchPage, deps, store);
    assert.equal(second.granted, 0);
    assert.equal(cursor, "900000000000000012");
    assert.equal(miles.getMilesBalance("m-rec"), 4000);
  });

  it("superuser grants move either balance and can't go negative", () => {
    assert.deepEqual(miles.grantCurrency({ actorId: "admin", targetUserId: "m-grant", currency: "miles", amount: 500, note: null }), { balance: 500 });
    assert.throws(() => miles.grantCurrency({ actorId: "admin", targetUserId: "m-grant", currency: "miles", amount: -600, note: null }));
    assert.throws(() => miles.grantCurrency({ actorId: "admin", targetUserId: "m-grant", currency: "miles", amount: 0, note: null }));
    assert.throws(() => miles.grantCurrency({ actorId: "admin", targetUserId: "m-grant", currency: "credits", amount: 100_001, note: null }));
    assert.equal(credits.listLedger("m-grant")[0]!.kind, "grant");
  });
});
