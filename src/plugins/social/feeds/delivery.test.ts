import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB (see permissionRoles.test.ts): must be set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-feeds-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const store = await import("./store.js");
const { deliverPending, deliverItem } = await import("./deliver.js");
const { refreshSource } = await import("./poller.js");
const { buildFeedPayload } = await import("./render.js");
const { defaultFeedMessage, parseFeedFilters, parseFeedOptions } = await import("../../../config/schemas/social.js");
type Sender = import("./deliver.js").Sender;
type FeedItemInput = import("./types.js").FeedItemInput;

const raw = () => (getDb() as unknown as { session: { client: Database.Database } }).session.client;

after(() => {
  try {
    raw().close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const GUILD = "123456789012345678";
const CHANNEL = "223456789012345678";
let sourceCounter = 0;

function item(key: string, minutesAgo: number, extra: Partial<FeedItemInput> = {}): FeedItemInput {
  return {
    key,
    title: `Post ${key}`,
    url: `https://example.com/${key}`,
    imageUrl: null,
    summary: `Summary of ${key}`,
    author: null,
    tags: [],
    publishedAt: new Date(Date.now() - minutesAgo * 60_000),
    ...extra,
  };
}

async function setup(baselineKeys: string[] = ["old-1", "old-2"]) {
  sourceCounter += 1;
  const source = await store.upsertSource({
    type: "rss",
    key: `rss:https://example.com/feed-${sourceCounter}`,
    config: { url: `https://example.com/feed-${sourceCounter}` },
    title: "Example",
    iconUrl: null,
    siteUrl: "https://example.com/",
    intervalS: 900,
  });
  await store.insertItems(source.id, baselineKeys.map((k, i) => item(k, 600 + i)), true);
  await store.updateSource(source.id, { lastOkAt: new Date() });
  const subscription = await store.createSubscription({
    guildId: GUILD,
    sourceId: source.id,
    channelId: CHANNEL,
    message: defaultFeedMessage("rss"),
    mentionRoleIds: [],
    filters: parseFeedFilters({}),
    options: parseFeedOptions({}),
    createdBy: "1",
  });
  return { source: (await store.getSource(source.id))!, subscription };
}

function recordingSender(): { send: Sender; sent: string[] } {
  const sent: string[] = [];
  let n = 0;
  return {
    sent,
    send: async (_sub, payload) => {
      const text = JSON.stringify(payload);
      const key = /example\.com\/([a-z0-9-]+)/.exec(text)?.[1] ?? "?";
      sent.push(key);
      n += 1;
      return { messageId: `9000000000000000${n}`, channelId: CHANNEL };
    },
  };
}

function deliveryRows(subscriptionId: number) {
  return raw().prepare("SELECT d.status, d.attempts, i.item_key AS key FROM feed_deliveries d JOIN feed_items i ON i.id = d.item_id WHERE d.subscription_id = ? ORDER BY d.id").all(subscriptionId) as {
    status: string;
    attempts: number;
    key: string;
  }[];
}

describe("delivery", () => {
  it("never posts what was there when the feed was added (baseline + cursor)", async () => {
    const { source, subscription } = await setup();
    const { send, sent } = recordingSender();
    const counts = await deliverPending(subscription, source, send);
    assert.deepEqual(counts, { sent: 0, filtered: 0, failed: 0 });
    assert.equal(sent.length, 0);
  });

  it("posts new items oldest first, at most 3 per tick, then the rest next tick", async () => {
    const { source, subscription } = await setup();
    await store.insertItems(source.id, [item("n5", 1), item("n1", 50), item("n3", 30), item("n2", 40), item("n4", 20)], false);
    const { send, sent } = recordingSender();
    assert.equal((await deliverPending(subscription, source, send)).sent, 3);
    assert.deepEqual(sent, ["n1", "n2", "n3"]);
    assert.equal((await deliverPending(subscription, source, send)).sent, 2);
    assert.deepEqual(sent, ["n1", "n2", "n3", "n4", "n5"]);
    assert.equal((await store.getSubscription(GUILD, subscription.id))!.deliveredCount, 5);
  });

  it("is idempotent: running again, or two ticks at once, never double-posts", async () => {
    const { source, subscription } = await setup();
    await store.insertItems(source.id, [item("a", 10), item("b", 5)], false);
    const slow: Sender = async (sub, payload) => {
      await new Promise((r) => setTimeout(r, 20));
      return recorder.send(sub, payload);
    };
    const recorder = recordingSender();
    const [first, second] = await Promise.all([deliverPending(subscription, source, slow), deliverPending(subscription, source, slow)]);
    assert.equal(first.sent + second.sent, 2);
    assert.deepEqual([...recorder.sent].sort(), ["a", "b"]);
    assert.equal((await deliverPending(subscription, source, recorder.send)).sent, 0);
    // The same item key stored again (a feed repeating an entry) doesn't create a second item.
    assert.equal((await store.insertItems(source.id, [item("a", 10)], false)).length, 0);
    assert.equal(recorder.sent.length, 2);
  });

  it("a crash between store and send never drops: the item is still pending next tick", async () => {
    const { source, subscription } = await setup();
    await store.insertItems(source.id, [item("crash-1", 3)], false);
    // Stored, then the process died before any send: nothing reserved yet.
    const { send, sent } = recordingSender();
    await deliverPending(subscription, source, send);
    assert.deepEqual(sent, ["crash-1"]);
  });

  it("a crash mid-send never double-posts while the reservation is fresh, and retries once it's stale", async () => {
    const { source, subscription } = await setup();
    const [stored] = await store.insertItems(source.id, [item("mid-1", 3)], false);
    const reservedAt = new Date();
    assert.ok(store.reserveDelivery(subscription, stored!.id, reservedAt));
    const { send, sent } = recordingSender();
    await deliverPending(subscription, source, send, 3, new Date(reservedAt.getTime() + 60_000));
    assert.equal(sent.length, 0, "a fresh pending reservation belongs to the send in flight");
    await deliverPending(subscription, source, send, 3, new Date(reservedAt.getTime() + store.STALE_PENDING_MS + 2_000));
    assert.deepEqual(sent, ["mid-1"]);
    assert.equal(deliveryRows(subscription.id)[0]!.status, "sent");
  });

  it("marks delivered only after a successful send, and retries failures up to the limit", async () => {
    const { source, subscription } = await setup();
    await store.insertItems(source.id, [item("f-1", 3)], false);
    let calls = 0;
    const failing: Sender = async () => {
      calls += 1;
      return { error: "Missing Access" };
    };
    for (let i = 0; i < store.MAX_DELIVERY_ATTEMPTS + 2; i++) await deliverPending(subscription, source, failing);
    assert.equal(calls, store.MAX_DELIVERY_ATTEMPTS);
    const [row] = deliveryRows(subscription.id);
    assert.equal(row!.status, "failed");
    assert.equal(row!.attempts, store.MAX_DELIVERY_ATTEMPTS);
    assert.equal((await store.getSubscription(GUILD, subscription.id))!.deliveredCount, 0);
  });

  it("applies filters, records why, and never reconsiders a filtered item", async () => {
    const { source } = await setup();
    const subscription = (await store.updateSubscription(GUILD, (await setupSubscriptionOn(source.id)).id, {
      filters: parseFeedFilters({ include_keywords: ["patch"], exclude_keywords: ["rumor"] }),
    }))!;
    await store.insertItems(source.id, [item("p1", 9, { title: "Patch 1.2 notes" }), item("p2", 8, { title: "Patch rumor" }), item("p3", 7, { title: "Unrelated" })], false);
    const { send, sent } = recordingSender();
    const counts = await deliverPending(subscription, source, send);
    assert.deepEqual(sent, ["p1"]);
    assert.equal(counts.filtered, 2);
    assert.deepEqual(
      deliveryRows(subscription.id).map((r) => [r.key, r.status]),
      [
        ["p1", "sent"],
        ["p2", "filtered"],
        ["p3", "filtered"],
      ],
    );
    assert.equal((await deliverPending(subscription, source, send)).filtered, 0);
  });

  it("deliverItem posts the newest item on request (post latest now) exactly once", async () => {
    const { source, subscription } = await setup(["seeded"]);
    const newest = store.latestItems(source.id, 1)[0]!;
    const { send, sent } = recordingSender();
    assert.equal(await deliverItem(subscription, source, newest, send), "sent");
    assert.equal(await deliverItem(subscription, source, newest, send), "skipped");
    assert.deepEqual(sent, ["seeded"]);
  });

  it("first fetch is baseline; a migrated watermark lets uploads after the checkpoint post", async () => {
    sourceCounter += 1;
    const source = await store.upsertSource({
      type: "rss",
      key: `rss:https://example.com/wm-${sourceCounter}`,
      config: {},
      title: "WM",
      iconUrl: null,
      siteUrl: null,
      intervalS: 900,
      state: { baselineBefore: Date.now() - 30 * 60_000 },
    });
    const subscription = await setupSubscriptionOn(source.id);
    const adapter = { fetch: async () => ({ items: [item("before-1", 120), item("before-2", 60), item("after-1", 10)] }) };
    const result = await refreshSource(source, new Date(), adapter);
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.inserted.map((i) => i.itemKey), ["after-1"]);
    const { send, sent } = recordingSender();
    await deliverPending(subscription, (await store.getSource(source.id))!, send);
    assert.deepEqual(sent, ["after-1"]);
    assert.equal((await store.getSource(source.id))!.state.baselineBefore, undefined, "watermark used once");

    // Without a watermark, a brand new source's first fetch posts nothing.
    sourceCounter += 1;
    const fresh = await store.upsertSource({ type: "rss", key: `rss:https://example.com/new-${sourceCounter}`, config: {}, title: "N", iconUrl: null, siteUrl: null, intervalS: 900 });
    const freshSub = await setupSubscriptionOn(fresh.id);
    await refreshSource(fresh, new Date(), adapter);
    const second = recordingSender();
    await deliverPending(freshSub, (await store.getSource(fresh.id))!, second.send);
    assert.equal(second.sent.length, 0);
  });

  it("backs off and auto-disables a failing source", async () => {
    sourceCounter += 1;
    let source = await store.upsertSource({ type: "rss", key: `rss:https://example.com/bad-${sourceCounter}`, config: {}, title: "Bad", iconUrl: null, siteUrl: null, intervalS: 600 });
    const { FeedError } = await import("./types.js");
    const adapter = {
      fetch: async () => {
        throw new FeedError("The server answered 500.");
      },
    };
    let last: Date | null = null;
    for (let i = 0; i < 10; i++) {
      await refreshSource(source, new Date(), adapter);
      source = (await store.getSource(source.id))!;
      if (last) assert.ok(source.nextCheckAt.getTime() >= last.getTime());
      last = source.nextCheckAt;
    }
    assert.equal(source.failCount, 10);
    assert.match(source.disabledReason ?? "", /Paused after 10 failed checks/);
    assert.equal(source.lastError, "The server answered 500.");
    await store.reactivateSource(source.id);
    assert.equal((await store.getSource(source.id))!.disabledReason, null);
  });

  it("scopes every subscription read and write to its guild", async () => {
    const { subscription } = await setup();
    assert.equal(await store.getSubscription("999999999999999999", subscription.id), null);
    assert.equal(await store.updateSubscription("999999999999999999", subscription.id, { enabled: false }), null);
    assert.equal(await store.deleteSubscription("999999999999999999", subscription.id), null);
    assert.ok(await store.getSubscription(GUILD, subscription.id));
  });
});

async function setupSubscriptionOn(sourceId: number) {
  return store.createSubscription({
    guildId: GUILD,
    sourceId,
    channelId: CHANNEL,
    message: defaultFeedMessage("rss"),
    mentionRoleIds: [],
    filters: parseFeedFilters({}),
    options: parseFeedOptions({}),
    createdBy: "1",
  });
}

describe("cap", () => {
  it("is 10 free and 50 with Dreamliner One, shared across every feed type", async () => {
    assert.equal(store.resolveMaxWatchers(false), 10);
    assert.equal(store.resolveMaxWatchers(true), 50);
    assert.equal(store.feedLimitError(9, false), null);
    assert.match(store.feedLimitError(10, false) ?? "", /10 feeds on the free plan.+up to 50/);
    assert.equal(store.feedLimitError(49, true), null);
    assert.match(store.feedLimitError(50, true) ?? "", /already has 50 feeds/);
    // countSubscriptions counts every type for the guild.
    const before = await store.countSubscriptions(GUILD);
    const yt = await store.upsertSource({ type: "youtube", key: "youtube:UCcap", config: {}, title: "Y", iconUrl: null, siteUrl: null, intervalS: 300 });
    const tw = await store.upsertSource({ type: "twitch", key: "twitch:cap", config: {}, title: "T", iconUrl: null, siteUrl: null, intervalS: 120 });
    await setupSubscriptionOn(yt.id);
    await setupSubscriptionOn(tw.id);
    assert.equal(await store.countSubscriptions(GUILD), before + 2);
  });
});

describe("rendering", () => {
  const source = { type: "rss" as const, title: "Example", iconUrl: "https://example.com/icon.png", siteUrl: "https://example.com/", config: {} };
  const row = {
    itemKey: "k",
    title: "Hello",
    url: "https://example.com/k",
    imageUrl: "https://example.com/k.jpg",
    summary: "Short",
    author: null,
    tags: [],
    publishedAt: new Date(),
    firstSeenAt: new Date(),
    payload: {},
  };

  it("builds a Components V2 card with app emojis, the image and link buttons", () => {
    const payload = buildFeedPayload(defaultFeedMessage("rss"), source, row, { roleIds: ["323456789012345678"] });
    assert.ok(((payload.flags ?? 0) & (1 << 15)) !== 0, "IsComponentsV2");
    const text = JSON.stringify(payload);
    assert.match(text, /<@&323456789012345678>/);
    assert.match(text, /### \[Hello\]\(https:\/\/example\.com\/k\)/);
    assert.match(text, /https:\/\/example\.com\/k\.jpg/);
    assert.match(text, /"label":"Read more"/);
    assert.match(text, /<:icons_globe:\d+>/);
    assert.deepEqual(payload.allowedMentions?.roles, ["323456789012345678"]);
  });

  it("silent posts keep the role text but ping nobody", () => {
    const payload = buildFeedPayload(defaultFeedMessage("rss"), source, row, { roleIds: ["323456789012345678"], silent: true });
    assert.deepEqual(payload.allowedMentions?.roles, []);
    assert.ok(((payload.flags ?? 0) & (1 << 12)) !== 0, "SuppressNotifications");
  });

  it("YouTube and Twitch aliases still work, and text mode stays a plain message", () => {
    const yt = buildFeedPayload(defaultFeedMessage("youtube"), { type: "youtube", title: "Chan", iconUrl: null, siteUrl: "https://www.youtube.com/@chan", config: { handle: "@chan" } }, { ...row, url: "https://www.youtube.com/watch?v=abc" }, { roleIds: [] });
    assert.equal(yt.content, "**Chan** has posted https://www.youtube.com/watch?v=abc");
    assert.equal(yt.flags, undefined);
  });

  it("drops buttons and images with unsafe URLs instead of failing the send", () => {
    const message = { ...defaultFeedMessage("rss"), buttons: [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Ok", url: "{url}" }] };
    const text = JSON.stringify(buildFeedPayload(message, source, { ...row, imageUrl: "data:image/png;base64,AAAA" }, { roleIds: [] }));
    assert.doesNotMatch(text, /javascript:|data:image/);
    assert.match(text, /"label":"Ok"/);
  });
});
