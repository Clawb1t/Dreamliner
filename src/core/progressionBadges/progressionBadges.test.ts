import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-badges-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const badges = await import("./index.js");
const store = await import("./store.js");
const { METRICS } = await import("./metrics.js");
const { findBadgeImage, getBadgeImageByKey } = await import("./assets.js");
const { getDb } = await import("../../db/client.js");
const { userMessageCounts } = await import("../../db/schema.js");

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

// No guilds cached: Dreamliner One is only ever reached by hand assignment here.
const client = { guilds: { cache: new Map() } } as unknown as Client;

function pngDataUrl(color: string): string {
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 32, 32);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

function setMessages(userId: string, count: number) {
  getDb()
    .insert(userMessageCounts)
    .values({ userId, count })
    .onConflictDoUpdate({ target: userMessageCounts.userId, set: { count } })
    .run();
  store.invalidateBadgeCache();
}

describe("tier maths", () => {
  it("counts goals reached and prefers the higher of earned and assigned", () => {
    const tiers = [{ threshold: 10 }, { threshold: 100 }, { threshold: 1000 }];
    assert.equal(badges.tiersReached(tiers, 9), 0);
    assert.equal(badges.tiersReached(tiers, 150), 2);
    const badge = { metric: "messages", tiers: tiers.map((t, i) => ({ ...t, id: i, position: i + 1, name: "", imageVersion: "" })) };
    assert.equal(badges.shownTier(badge, 150, undefined), 2);
    assert.equal(badges.shownTier(badge, 150, { tier: 3 }), 3);
    assert.equal(badges.shownTier(badge, 5_000, { tier: 1 }), 3);
    assert.equal(badges.shownTier(badge, 0, { tier: 99 }), 3); // clamped to the last tier
    assert.equal(badges.shownTier({ ...badge, metric: "manual" }, 5_000, undefined), 0);
  });

  it("names unnamed tiers from the stat", () => {
    assert.equal(badges.tierLabel("messages", { name: "", threshold: 10_000 }), "10,000+ messages");
    assert.equal(badges.tierLabel("messages", { name: "Chatterbox", threshold: 10 }), "Chatterbox");
    assert.equal(badges.tierLabel("manual", { name: "", threshold: 0 }), null);
  });
});

describe("stats", () => {
  it("every stat's lookup and holder count runs", async () => {
    for (const metric of METRICS) {
      const values = await metric.values(client, ["272397639855898624"]);
      assert.ok(values instanceof Map, metric.id);
      if (metric.countAtLeast) assert.equal((await metric.countAtLeast(client, [1, 10])).length, 2, metric.id);
    }
  });
});

describe("images", () => {
  it("rejects anything that isn't a real image", async () => {
    await assert.rejects(store.parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), store.BadgeInputError);
    await assert.rejects(store.parseImageDataUrl("data:image/png;base64,aGVsbG8="), store.BadgeInputError);
    const ok = await store.parseImageDataUrl(pngDataUrl("#5662f5"));
    assert.equal(ok.contentType, "image/png");
  });

  it("ships the Dreamliner One art and never serves unknown files", async () => {
    const image = findBadgeImage("dreamliner_one", null);
    assert.ok(image);
    const loaded = await badges.loadBadgeImage(image.key);
    assert.ok(loaded && (await loadImage(loaded.buffer)).width > 0);
    assert.equal(getBadgeImageByKey("../../.env"), null);
    assert.equal(await badges.loadBadgeImage("t/999999"), null);
  });
});

describe("dashboard badges", () => {
  let messagesId = 0;

  it("creates an evolving badge and awards tiers from the stat", async () => {
    messagesId = await store.createStoredBadge(
      {
        key: "messages",
        name: "Messenger",
        description: "Lifetime messages",
        metric: "messages",
        // Out of order on purpose: tiers are sorted by goal.
        tiers: [
          { threshold: 1000, image: pngDataUrl("#ff0000") },
          { threshold: 100, name: "Chatty", image: pngDataUrl("#00ff00") },
        ],
      },
      "admin",
      badges.BUILT_IN_KEYS,
    );
    setMessages("111111111111111111", 50);
    setMessages("222222222222222222", 150);
    setMessages("333333333333333333", 5000);
    const result = await badges.getProgressionBadgesForUsers(client, ["111111111111111111", "222222222222222222", "333333333333333333"]);
    assert.ok(!result.has("111111111111111111"));
    assert.deepEqual(
      result.get("222222222222222222")?.map((b) => [b.id, b.tier, b.tierName]),
      [["messages", 1, "Chatty"]],
    );
    const top = result.get("333333333333333333")![0]!;
    assert.equal(top.tier, 2);
    assert.equal(top.tierName, "1,000+ messages");
    assert.deepEqual(top.progress, { value: 5000, unit: "messages", current: 1000, next: null });
    assert.deepEqual(result.get("222222222222222222")![0]!.progress, {
      value: 150,
      unit: "messages",
      current: 100,
      next: { tier: 2, threshold: 1000, name: "1,000+ messages" },
    });
    const art = await badges.loadBadgeImage(top.imageKey);
    assert.equal(art?.contentType, "image/png");
  });

  it("validates input", async () => {
    await assert.rejects(
      store.createStoredBadge({ key: "dreamliner_one", name: "x", metric: "messages", tiers: [] }, "admin", badges.BUILT_IN_KEYS),
      /built-in/,
    );
    await assert.rejects(
      store.createStoredBadge({ key: "messages", name: "x", metric: "messages", tiers: [] }, "admin", badges.BUILT_IN_KEYS),
      /already exists/,
    );
    await assert.rejects(
      store.createStoredBadge({ key: "nope", name: "x", metric: "messages", tiers: [{ threshold: 0, image: pngDataUrl("#000") }] }, "admin", []),
      /at least 1/,
    );
    await assert.rejects(
      store.createStoredBadge({ key: "nope", name: "x", metric: "made_up", tiers: [] }, "admin", []),
      /Pick a stat/,
    );
  });

  it("assigning a tier by hand lifts a user above what they earned", async () => {
    store.grantBadge("222222222222222222", "messages", 2, "admin");
    const shown = await badges.getProgressionBadges(client, "222222222222222222");
    assert.equal(shown[0]?.tier, 2);
    assert.ok(shown[0]?.since, "assigned tiers carry when they were assigned");
  });

  it("assigns built-in and assigned-only badges too", async () => {
    await store.createStoredBadge(
      { key: "staff", name: "Staff", metric: "manual", tiers: [{ image: pngDataUrl("#123456") }] },
      "admin",
      badges.BUILT_IN_KEYS,
    );
    store.grantBadge("111111111111111111", "staff", null, "admin");
    store.grantBadge("111111111111111111", "dreamliner_one", null, "admin");
    const shown = await badges.getProgressionBadges(client, "111111111111111111");
    assert.deepEqual(
      shown.map((b) => b.id),
      ["dreamliner_one", "staff"],
    );
  });

  it("describes every tier of a badge for the site's badge modal", async () => {
    const messages = await badges.getPublicBadgeInfo(client, "messages");
    assert.ok(messages);
    assert.equal(messages.metric?.id, "messages");
    assert.deepEqual(
      messages.tiers.map((tier) => [tier.position, tier.requirement, tier.label]),
      [
        [1, "Reach 100 messages", "Chatty"],
        [2, "Reach 1,000 messages", "1,000+ messages"],
      ],
    );
    const staff = await badges.getPublicBadgeInfo(client, "staff");
    assert.ok(staff?.assignedOnly);
    assert.equal(staff?.tiers[0]?.requirement, "Assigned by the Dreamliner team");
    assert.ok((await badges.getPublicBadgeInfo(client, "dreamliner_one"))?.builtIn);
    assert.equal(await badges.getPublicBadgeInfo(client, "does_not_exist"), null);
  });

  it("badges a user hides are left out everywhere but their own settings", async () => {
    store.setHiddenBadges("111111111111111111", ["staff", "../bad key"]);
    assert.deepEqual(
      (await badges.getProgressionBadges(client, "111111111111111111")).map((b) => b.id),
      ["dreamliner_one"],
    );
    assert.deepEqual(
      (await badges.getProgressionBadges(client, "111111111111111111", { includeHidden: true })).map((b) => [b.id, b.hidden]),
      [
        ["dreamliner_one", false],
        ["staff", true],
      ],
    );
    store.setHiddenBadges("111111111111111111", []);
    assert.equal((await badges.getProgressionBadges(client, "111111111111111111")).length, 2);
  });

  it("editing keeps existing art, and the dashboard counts holders per tier", async () => {
    const before = (await store.listStoredBadges()).find((b) => b.key === "messages")!;
    await store.updateStoredBadge(messagesId, {
      name: "Messenger",
      metric: "messages",
      tiers: before.tiers.map((tier) => ({ threshold: tier.threshold, name: tier.name, keepImageFrom: tier.id })),
    });
    const after = (await store.listStoredBadges()).find((b) => b.key === "messages")!;
    assert.deepEqual(
      after.tiers.map((t) => t.imageVersion),
      before.tiers.map((t) => t.imageVersion),
    );
    const admin = await badges.listAdminBadges(client);
    const listed = admin.badges.find((b) => b.key === "messages")!;
    assert.deepEqual(
      listed.tiers.map((t) => t.holders),
      [1, 1],
    );
    assert.equal(listed.assigned, 1);
    assert.ok(admin.badges.find((b) => b.key === "dreamliner_one")?.builtIn);
  });

  it("disabled badges stop showing, and deleting removes assignments", async () => {
    store.setStoredBadgeEnabled(messagesId, false);
    assert.equal((await badges.getProgressionBadges(client, "333333333333333333")).length, 0);
    assert.ok(store.deleteStoredBadge(messagesId));
    const view = await badges.getAdminUserBadges(client, "222222222222222222");
    assert.equal(view.assigned.length, 0);
  });
});
