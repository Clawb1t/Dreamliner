import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see credits.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-store-products-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const credits = await import("./credits.js");
const products = await import("./products.js");
const { STORE_PRICING } = await import("./pricing.js");
const { upsertDreamlinerOne } = await import("../../bridge/dreamlinerOne.js");
const { getDb } = await import("../../db/client.js");

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

const DAY = 86_400_000;

function earn(userId: string, votes: number) {
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < votes; i++) {
    credits.creditVote(credits.recordVote({ userId, votedAt: new Date(base + i * DAY), source: "history" }), userId);
  }
}

function buyOne(userId: string, guildId: string, days: number, requestId?: string, now?: Date) {
  return products.purchaseProduct({ userId, productId: "dreamliner-one", input: { guildId, days }, requestId, now });
}

describe("catalog seed", () => {
  it("seeds Dreamliner One from STORE_PRICING", () => {
    const one = products.getProduct("dreamliner-one");
    assert.ok(one);
    assert.equal(one.type, "one_days");
    assert.equal(one.name, "Dreamliner One");
    assert.equal(one.priceCredits, STORE_PRICING.creditsPerDay);
    assert.deepEqual(one.config, { dayStep: STORE_PRICING.dayStep, maxDays: STORE_PRICING.maxDaysPerPurchase });
    assert.equal(one.section, "Dreamliner One");
    assert.equal(one.featured, true);
    assert.equal(one.active, true);
    assert.equal(one.badge, null);
    assert.ok(products.isPurchasable(one));
  });

  it("lists it in the public catalog with the vote pricing", () => {
    const catalog = products.getStoreCatalog();
    const one = catalog.products.find((product) => product.id === "dreamliner-one");
    assert.ok(one);
    assert.equal(one.available, true);
    assert.equal(one.imageUrl, null);
    assert.equal(catalog.pricing.creditsPerVote, STORE_PRICING.creditsPerVote);
  });
});

describe("purchaseProduct", () => {
  it("charges once for the same requestId and returns the original receipt", () => {
    earn("p-idem", 8); // 80 credits
    const now = new Date("2026-05-01T00:00:00Z");
    const first = buyOne("p-idem", "g-idem", 2, "req-1", now);
    const again = buyOne("p-idem", "g-idem", 2, "req-1", new Date(now.getTime() + 1000));
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.ledgerId, first.ledgerId);
    assert.equal(again.cost, 40);
    assert.equal(again.balance, 40);
    assert.equal(again.expiresAt?.getTime(), first.expiresAt?.getTime());
    assert.equal(credits.getCreditBalance("p-idem"), 40);
    assert.equal(products.listEntitlements("p-idem").length, 1);
    assert.equal(products.findPurchaseByRequest("p-idem", "req-1")?.ledgerId, first.ledgerId);
  });

  it("refuses a requestId reused for another product", () => {
    earn("p-reuse", 8);
    buyOne("p-reuse", "g-reuse", 2, "req-x");
    products.createProduct({ id: "other-days", type: "one_days", name: "Other", priceCredits: 1 }, "admin");
    assert.throws(
      () => products.purchaseProduct({ userId: "p-reuse", productId: "other-days", input: { guildId: "g-reuse", days: 2 }, requestId: "req-x" }),
      { code: "duplicate_request" },
    );
  });

  it("refuses a balance that can't cover it, without charging", () => {
    earn("p-poor", 3); // 30 credits
    assert.throws(() => buyOne("p-poor", "g-poor", 2), { code: "insufficient_credits" });
    assert.equal(credits.getCreditBalance("p-poor"), 30);
  });

  it("refuses unknown, inactive, upcoming and ended products", () => {
    earn("p-avail", 10);
    assert.throws(() => products.purchaseProduct({ userId: "p-avail", productId: "nope", input: {} }), { code: "unknown_product" });

    products.createProduct({ id: "archived", type: "one_days", name: "Archived", priceCredits: 1 }, "admin");
    products.archiveProduct("archived", "admin");
    assert.throws(
      () => products.purchaseProduct({ userId: "p-avail", productId: "archived", input: { guildId: "g-a", days: 2 } }),
      { code: "not_available" },
    );

    const now = new Date("2026-06-01T00:00:00Z");
    products.createProduct(
      { id: "ended", type: "one_days", name: "Ended", priceCredits: 1, endsAt: new Date(now.getTime() - DAY).toISOString() },
      "admin",
    );
    products.createProduct(
      { id: "upcoming", type: "one_days", name: "Upcoming", priceCredits: 1, startsAt: new Date(now.getTime() + DAY).toISOString() },
      "admin",
    );
    for (const productId of ["ended", "upcoming"]) {
      assert.throws(
        () => products.purchaseProduct({ userId: "p-avail", productId, input: { guildId: "g-a", days: 2 }, now }),
        { code: "not_available" },
      );
    }
    assert.equal(credits.getCreditBalance("p-avail"), 100);

    // The catalog shows upcoming products as not available yet, and leaves out ended or archived ones.
    const listed = products.getStoreCatalog(now).products;
    assert.equal(listed.find((product) => product.id === "upcoming")?.available, false);
    assert.ok(!listed.some((product) => product.id === "ended" || product.id === "archived"));
  });

  it("refuses a server that already has One for good, without charging", async () => {
    earn("p-forever", 4);
    await upsertDreamlinerOne({ guildId: "g-forever2", actorId: "admin", expiresAt: null });
    assert.throws(() => buyOne("p-forever", "g-forever2", 2), { code: "one_forever" });
    assert.equal(credits.getCreditBalance("p-forever"), 40);
    assert.equal(products.listEntitlements("p-forever").length, 0);
  });

  it("stacks days onto earlier purchases and uses the catalog price and steps", () => {
    earn("p-stack", 20); // 200 credits
    const now = new Date();
    const first = buyOne("p-stack", "g-stack", 2, undefined, now);
    const second = buyOne("p-stack", "g-stack", 4, undefined, now);
    // One grants store their expiry to the second.
    const firstExpiry = Math.floor(first.expiresAt!.getTime() / 1000) * 1000;
    assert.equal(second.expiresAt!.getTime(), firstExpiry + 4 * DAY);

    products.updateProduct("dreamliner-one", { priceCredits: 5, config: { dayStep: 1 } }, "admin");
    const third = buyOne("p-stack", "g-stack", 3, undefined, now);
    assert.equal(third.cost, 15);
    products.updateProduct("dreamliner-one", { priceCredits: STORE_PRICING.creditsPerDay, config: { dayStep: STORE_PRICING.dayStep } }, "admin");
    assert.throws(() => buyOne("p-stack", "g-stack", 3), { code: "invalid_days" });

    const history = credits.listLedger("p-stack");
    assert.equal(history[0]!.productId, "dreamliner-one");
    assert.equal(products.listEntitlements("p-stack").length, 3);
  });

  it("keeps purchaseOneDays working through the catalog", () => {
    earn("p-legacy", 4);
    const result = credits.purchaseOneDays({ userId: "p-legacy", guildId: "g-legacy", days: 2 });
    assert.equal(result.cost, 40);
    assert.equal(result.balance, 0);
  });
});

describe("parsePurchaseBody", () => {
  it("maps the legacy { guildId, days } body to Dreamliner One", () => {
    assert.deepEqual(products.parsePurchaseBody({ guildId: "123", days: 4 }), {
      ok: true,
      productId: "dreamliner-one",
      input: { guildId: "123", days: 4 },
      requestId: null,
      currency: null,
    });
  });

  it("reads the product body", () => {
    assert.deepEqual(products.parsePurchaseBody({ productId: "dreamliner-one", input: { guildId: "1", days: 2 }, requestId: "abc" }), {
      ok: true,
      productId: "dreamliner-one",
      input: { guildId: "1", days: 2 },
      requestId: "abc",
      currency: null,
    });
    assert.equal((products.parsePurchaseBody({ productId: "x", currency: "miles" }) as { currency: string }).currency, "miles");
    assert.equal(products.parsePurchaseBody({ productId: "x", currency: "gold" }).ok, false);
  });

  it("rejects bad bodies", () => {
    assert.equal(products.parsePurchaseBody({}).ok, false);
    assert.equal(products.parsePurchaseBody(null).ok, false);
    assert.equal(products.parsePurchaseBody({ productId: "" }).ok, false);
    assert.equal(products.parsePurchaseBody({ productId: "x", input: [] }).ok, false);
    assert.equal(products.parsePurchaseBody({ productId: "x", requestId: "r".repeat(65) }).ok, false);
  });
});

describe("admin", () => {
  it("validates product input with the failing field", () => {
    assert.throws(() => products.createProduct({ id: "Bad Id", type: "one_days", name: "X", priceCredits: 1 }, "admin"), { field: "id" });
    assert.throws(() => products.createProduct({ id: "ok-id", type: "badge", name: "X", priceCredits: 1 }, "admin"), { field: "type" });
    assert.throws(() => products.createProduct({ id: "ok-id", type: "one_days", name: "X", priceCredits: 0 }, "admin"), {
      field: "priceCredits",
    });
    assert.throws(() => products.createProduct({ id: "dreamliner-one", type: "one_days", name: "X", priceCredits: 1 }, "admin"), {
      field: "id",
    });
    assert.throws(
      () =>
        products.createProduct(
          { id: "ok-id", type: "one_days", name: "X", priceCredits: 1, startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" },
          "admin",
        ),
      { field: "endsAt" },
    );
  });

  it("sorts featured first, then by sort order and name, and builds payloads", () => {
    products.createProduct({ id: "zz-late", type: "one_days", name: "Alpha", priceCredits: 1, sortOrder: 5, badge: "NEW" }, "admin");
    const created = products.createProduct({ id: "aa-early", type: "one_days", name: "Beta", priceCredits: 1, sortOrder: 1, imageAssetId: "abc123" }, "admin");
    const ids = products.listProducts().map((product) => product.id);
    assert.equal(ids[0], "dreamliner-one");
    assert.ok(ids.indexOf("aa-early") < ids.indexOf("zz-late"));
    const payload = products.toAdminProductPayload(created);
    assert.equal(payload.imageUrl, "/api/store/assets/abc123");
    assert.equal(payload.imageAssetId, "abc123");
    assert.equal(payload.section, "Beta");
    assert.equal(payload.updatedBy, "admin");
    assert.ok(products.listProducts({ includeInactive: true }).some((product) => product.id === "archived"));
  });
});
