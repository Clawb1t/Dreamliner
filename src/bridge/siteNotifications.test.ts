import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-notifications-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const notifications = await import("./siteNotifications.js");
const { audienceMatches, isSafeNotificationLink, bodyLinksAreSafe } = await import("./siteNotificationsModel.js");
const { invalidateCached } = await import("./responseCache.js");
const { bucketFor, bridgeRateLimit } = await import("./rateLimit.js");
const { getDb } = await import("../db/client.js");
const { siteNotifications, siteNotificationPrefs, siteNotificationState } = await import("../db/schema.js");
const { deleteUserPersonalData } = await import("./userProfiles.js");
const { exportUserPersonalData } = await import("./userDataExport.js");

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

const ADMIN = "272397639855898624";
const ALICE = "900000000000000001"; // member of G1, manages G2
const BOB = "900000000000000002"; // member of G3 only
const G1 = "800000000000000001"; // has "economy" on
const G2 = "800000000000000002"; // has "economy" on
const G3 = "800000000000000003"; // economy off
const NOT_BOT = "800000000000000009"; // bot isn't in it

const MEMBERS: Record<string, Record<string, { manager: boolean }>> = {
  [ALICE]: { [G1]: { manager: false }, [G2]: { manager: true } },
  [BOB]: { [G3]: { manager: false } },
};

const deps: import("./siteNotifications.js").NotificationDeps = {
  async pluginNames() {
    return ["economy", "tickets"];
  },
  botGuildIds() {
    return new Set([G1, G2, G3]);
  },
  async guildsWithPlugin(plugin) {
    return plugin === "economy" ? new Set([G1, G2]) : new Set();
  },
  async memberships(userId, guildIds) {
    const out = new Map<string, { manager: boolean }>();
    for (const [guildId, m] of Object.entries(MEMBERS[userId] ?? {})) if (guildIds.has(guildId)) out.set(guildId, m);
    return out;
  },
  memberCount(guildId) {
    return guildId === G1 ? 100 : guildId === G2 ? 50 : 10;
  },
};

function create(fields: Record<string, unknown>) {
  const result = notifications.createNotification({ kind: "announcement", title: "Hello", body: "Body", status: "published", ...fields }, ADMIN);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.value;
}

async function feedIds(userId: string) {
  invalidateCached("notif-user:");
  const feed = await notifications.getUserFeed(userId, "list", deps, null);
  return (feed.items ?? []).map((item) => item.title).sort();
}

beforeEach(() => {
  getDb().delete(siteNotificationState).run();
  getDb().delete(siteNotificationPrefs).run();
  getDb().delete(siteNotifications).run();
  invalidateCached("notif-user:");
});

describe("audienceMatches", () => {
  const memberships = new Map([[G1, { manager: false }], [G2, { manager: true }]]);
  it("matches everyone and listed users", () => {
    assert.equal(audienceMatches({ type: "everyone" }, ALICE, null, memberships), true);
    assert.equal(audienceMatches({ type: "users", userIds: [ALICE] }, ALICE, null, memberships), true);
    assert.equal(audienceMatches({ type: "users", userIds: [BOB] }, ALICE, null, memberships), false);
  });
  it("tells members and managers apart", () => {
    const audience = { type: "servers" as const, guildIds: [G1], scope: "managers" as const };
    assert.equal(audienceMatches(audience, ALICE, new Set([G1]), memberships), false);
    assert.equal(audienceMatches({ ...audience, scope: "members" }, ALICE, new Set([G1]), memberships), true);
    assert.equal(audienceMatches(audience, ALICE, new Set([G2]), memberships), true);
  });
});

describe("links", () => {
  it("allows https and site paths only", () => {
    assert.equal(isSafeNotificationLink("https://dreamliner.site/one"), true);
    assert.equal(isSafeNotificationLink("/dashboard"), true);
    assert.equal(isSafeNotificationLink("javascript:alert(1)"), false);
    assert.equal(isSafeNotificationLink("http://example.com"), false);
    assert.equal(isSafeNotificationLink("//evil.example"), false);
    assert.equal(isSafeNotificationLink("/\\evil.example"), false);
    assert.equal(isSafeNotificationLink("https://user:pw@example.com"), false);
    assert.equal(bodyLinksAreSafe("See [the guide](/helpcenter) and **this**"), true);
    assert.equal(bodyLinksAreSafe("[x](javascript:alert(1))"), false);
  });
  it("rejects unsafe links when saving", () => {
    const bad = notifications.createNotification({ kind: "tip", title: "x", linkUrl: "javascript:alert(1)", audience: { type: "everyone" } }, ADMIN);
    assert.equal(bad.ok, false);
    const badBody = notifications.createNotification({ kind: "tip", title: "x", body: "[x](data:text/html,hi)", audience: { type: "everyone" } }, ADMIN);
    assert.equal(badBody.ok, false);
    const badKind = notifications.createNotification({ kind: "alert", title: "x", audience: { type: "everyone" } }, ADMIN);
    assert.equal(badKind.ok, false);
  });
});

describe("user feed", () => {
  it("evaluates each audience for the reader", async () => {
    create({ title: "everyone", audience: { type: "everyone" } });
    create({ title: "economy members", audience: { type: "feature", plugin: "economy", scope: "members" } });
    create({ title: "economy managers", audience: { type: "feature", plugin: "economy", scope: "managers" } });
    create({ title: "removed plugin", audience: { type: "feature", plugin: "tags", scope: "members" } });
    create({ title: "g3 members", audience: { type: "servers", guildIds: [G3, NOT_BOT], scope: "members" } });
    create({ title: "g1 managers", audience: { type: "servers", guildIds: [G1], scope: "managers" } });
    create({ title: "bob only", audience: { type: "users", userIds: [BOB] } });

    assert.deepEqual(await feedIds(ALICE), ["economy managers", "economy members", "everyone"]);
    assert.deepEqual(await feedIds(BOB), ["bob only", "everyone", "g3 members"]);
  });

  it("hides drafts, scheduled-out and expired ones", async () => {
    create({ title: "draft", status: "draft", audience: { type: "everyone" } });
    const live = create({ title: "live", audience: { type: "everyone" }, expiresAt: Date.now() + 60_000 });
    const expiring = create({ title: "expiring", audience: { type: "everyone" }, expiresAt: Date.now() + 60_000 });
    getDb().update(siteNotifications).set({ expiresAt: Date.now() - 1000 }).where((await import("drizzle-orm")).eq(siteNotifications.id, expiring.id)).run();
    assert.deepEqual(await feedIds(ALICE), ["live"]);
    const unpublished = notifications.updateNotification(live.id, { status: "draft" });
    assert.ok(unpublished.ok);
    assert.deepEqual(await feedIds(ALICE), []);
    const expired = notifications.listAdminNotifications().find((n) => n.id === expiring.id);
    assert.equal(expired?.state, "expired");
  });

  it("pins to the top and keeps the audience out of the feed", async () => {
    create({ title: "older pinned", pinned: true, audience: { type: "users", userIds: [ALICE] } });
    create({ title: "newer", audience: { type: "everyone" } });
    const feed = await notifications.getUserFeed(ALICE, "list", deps, null);
    assert.equal(feed.items?.[0]?.title, "older pinned");
    assert.equal(JSON.stringify(feed).includes("audience"), false);
    assert.equal(JSON.stringify(feed).includes(ALICE), false);
  });

  it("tracks read, mark all and dismiss, and counts reach", async () => {
    const a = create({ title: "a", audience: { type: "everyone" } });
    const b = create({ title: "b", audience: { type: "everyone" } });
    const hidden = create({ title: "bob", audience: { type: "users", userIds: [BOB] } });
    assert.equal((await notifications.getUserFeed(ALICE, "count", deps, null)).unread, 2);

    const one = await notifications.markRead(ALICE, { ids: [a.id, hidden.id] }, deps);
    assert.ok(one.ok);
    assert.equal(one.value.unread, 1);
    // Not in Alice's feed, so no row for it.
    assert.equal(getDb().select().from(siteNotificationState).all().some((r) => r.notificationId === hidden.id), false);

    const list = await notifications.getUserFeed(ALICE, "list", deps, null);
    assert.deepEqual(list.items?.map((i) => [i.title, i.read]).sort(), [["a", true], ["b", false]]);

    const all = await notifications.markRead(ALICE, { all: true }, deps);
    assert.ok(all.ok);
    assert.equal(all.value.unread, 0);

    const gone = await notifications.dismiss(ALICE, b.id, deps);
    assert.ok(gone.ok);
    assert.deepEqual(await feedIds(ALICE), ["a"]);
    assert.equal((await notifications.dismiss(ALICE, hidden.id, deps)).ok, false);

    const stats = notifications.listAdminNotifications().find((n) => n.id === b.id)?.stats;
    assert.deepEqual(stats, { seen: 1, read: 1, dismissed: 1 });
  });

  it("estimates the audience roughly", async () => {
    const members = await notifications.estimateAudience({ type: "feature", plugin: "economy", scope: "members" }, deps);
    assert.ok(members.ok);
    assert.deepEqual(members.value, { servers: 2, people: 150, scope: "members" });
    const managers = await notifications.estimateAudience({ type: "servers", guildIds: [G1, NOT_BOT], scope: "managers" }, deps);
    assert.ok(managers.ok);
    assert.deepEqual(managers.value, { servers: 1, people: null, scope: "managers" });
  });
});

describe("personal data", () => {
  it("is exported and erased with the rest", async () => {
    const a = create({ title: "a", audience: { type: "everyone" } });
    await notifications.markRead(ALICE, { ids: [a.id] }, deps);
    await notifications.markRead(BOB, { ids: [a.id] }, deps);
    const exported = await exportUserPersonalData(ALICE);
    assert.equal(exported.sections.site_notifications?.rows.length, 1);

    const result = await deleteUserPersonalData(ALICE);
    assert.equal(result.deleted.site_notifications, 1);
    assert.equal(notifications.countUserNotificationState(ALICE), 0);
    assert.equal(notifications.countUserNotificationState(BOB), 1);
    // Erased state means it shows as new again.
    assert.equal((await notifications.getUserFeed(ALICE, "count", deps, null)).unread, 1);
  });

  it("deleting a notification drops everyone's state for it", async () => {
    const a = create({ title: "a", audience: { type: "everyone" } });
    await notifications.markRead(ALICE, { ids: [a.id] }, deps);
    assert.equal(notifications.deleteNotification(a.id), true);
    assert.equal(notifications.countUserNotificationState(ALICE), 0);
  });
});

describe("muted kinds", () => {
  it("hides muted kinds from that user's feed and count only", async () => {
    create({ title: "news", kind: "announcement", audience: { type: "everyone" } });
    create({ title: "tip", kind: "tip", audience: { type: "everyone" } });
    create({ title: "feature", kind: "feature", audience: { type: "everyone" } });
    const set = notifications.setNotificationPrefs(ALICE, { mutedKinds: ["tip", "feature"] });
    assert.ok(set.ok);
    assert.deepEqual(set.value.mutedKinds, ["feature", "tip"]);
    assert.deepEqual(await feedIds(ALICE), ["news"]);
    assert.equal((await notifications.getUserFeed(ALICE, "count", deps, null)).unread, 1);
    // Another user's settings are their own.
    assert.deepEqual(await feedIds(BOB), ["feature", "news", "tip"]);
    assert.deepEqual(notifications.getNotificationPrefs(BOB).mutedKinds, []);
  });

  it("refuses announcements and unknown kinds", () => {
    const announcement = notifications.setNotificationPrefs(ALICE, { mutedKinds: ["announcement"] });
    assert.equal(announcement.ok, false);
    assert.equal(notifications.setNotificationPrefs(ALICE, { mutedKinds: ["nope"] }).ok, false);
    assert.equal(notifications.setNotificationPrefs(ALICE, { mutedKinds: "tip" }).ok, false);
    assert.deepEqual(notifications.getNotificationPrefs(ALICE).mutedKinds, []);
  });

  it("unmuting everything removes the row", () => {
    notifications.setNotificationPrefs(ALICE, { mutedKinds: ["tip"] });
    assert.equal(notifications.countUserNotificationPrefs(ALICE), 1);
    notifications.setNotificationPrefs(ALICE, { mutedKinds: [] });
    assert.equal(notifications.countUserNotificationPrefs(ALICE), 0);
  });

  it("is exported and erased with the rest of the user's data", async () => {
    notifications.setNotificationPrefs(ALICE, { mutedKinds: ["update"] });
    notifications.setNotificationPrefs(BOB, { mutedKinds: ["tip"] });
    const exported = await exportUserPersonalData(ALICE);
    assert.equal(exported.sections.site_notification_prefs?.rows.length, 1);
    const result = await deleteUserPersonalData(ALICE);
    assert.equal(result.deleted.site_notification_prefs, 1);
    assert.equal(notifications.countUserNotificationPrefs(ALICE), 0);
    assert.deepEqual(notifications.getNotificationPrefs(BOB).mutedKinds, ["tip"]);
  });

  it("is limited per user, as a read and a write", () => {
    assert.equal(bucketFor("GET", `/bridge/users/${ALICE}/notifications/prefs`), "read");
    assert.equal(bucketFor("PUT", `/bridge/users/${ALICE}/notifications/prefs`), "write");
    assert.equal(bridgeRateLimit("PUT", new URL(`http://x/bridge/users/${ALICE}/notifications/prefs`)), null);
  });
});

describe("rate limits", () => {
  it("treats the feed as a read and limits it per user", () => {
    assert.equal(bucketFor("POST", `/bridge/users/${ALICE}/notifications/feed`), "read");
    assert.equal(bucketFor("POST", `/bridge/users/${ALICE}/notifications/read`), "write");
    assert.equal(bridgeRateLimit("POST", new URL(`http://x/bridge/users/${ALICE}/notifications/read`)), null);
  });
});
