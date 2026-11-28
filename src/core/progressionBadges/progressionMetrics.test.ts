import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { loadImage } from "@napi-rs/canvas";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-badge-metrics-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const badges = await import("./index.js");
const store = await import("./store.js");
const metrics = await import("./metrics.js");
const { clearUnlockCache } = await import("./unlocks.js");
const { GLYPH_IDS, generateTierArt } = await import("./glyphs.js");
const { getDb } = await import("../../db/client.js");

const raw = (getDb() as unknown as { session: { client: Database.Database } }).session.client;

after(() => {
  try {
    raw.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const client = { guilds: { cache: new Map() } } as unknown as Client;
const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";
const NOW = Date.now();

function run(sql: string, ...params: unknown[]) {
  raw.prepare(sql).run(...params);
}

async function value(metricId: string, userId: string): Promise<number> {
  const metric = metrics.getMetric(metricId);
  assert.ok(metric, metricId);
  return (await metric.values(client, [userId])).get(userId) ?? 0;
}

describe("streak and date helpers", () => {
  it("finds the longest run of consecutive days", () => {
    assert.equal(metrics.longestDailyRun([]), 0);
    assert.equal(metrics.longestDailyRun(["2026-01-01"]), 1);
    assert.equal(metrics.longestDailyRun(["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05", "2026-01-06"]), 3);
    // Month and year boundaries, and repeated dates, still count as one run.
    assert.equal(metrics.longestDailyRun(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-01", "2026-01-02"]), 4);
  });

  it("counts whole days since a date", () => {
    assert.equal(metrics.daysSinceDate("2026-01-01", Date.parse("2026-01-11T12:00:00Z")), 10);
    assert.equal(metrics.daysSinceDate("not a date"), 0);
  });
});

describe("stat metadata", () => {
  it("every stat has copy, an icon and a sensible suggested ladder", () => {
    const ids = new Set<string>();
    for (const metric of metrics.METRICS) {
      assert.ok(!ids.has(metric.id), `duplicate ${metric.id}`);
      ids.add(metric.id);
      assert.ok(metric.label && metric.description && metric.levelUp, metric.id);
      assert.ok(GLYPH_IDS.includes(metric.icon), `${metric.id} icon`);
      assert.ok(!/[!—]/.test(metric.levelUp + metric.description), `${metric.id}: calm copy, no em dashes`);
      if (metric.id === metrics.MANUAL_METRIC_ID) continue;
      assert.ok(metric.unit && metric.unitOne, metric.id);
      assert.ok(metric.suggestedTiers.length >= 3 && metric.suggestedTiers.length <= 10, `${metric.id} ladder size`);
      for (let i = 1; i < metric.suggestedTiers.length; i++) {
        assert.ok(metric.suggestedTiers[i]!.threshold > metric.suggestedTiers[i - 1]!.threshold, `${metric.id} ladder order`);
      }
      assert.ok(metric.suggestedTiers.every((tier) => tier.name.length <= 40 && tier.threshold >= 1), metric.id);
    }
  });

  it("every stat's lookup and holder count runs on an empty database", async () => {
    for (const metric of metrics.METRICS) {
      const values = await metric.values(client, [A]);
      assert.ok(values instanceof Map, metric.id);
      if (metric.countAtLeast) assert.equal((await metric.countAtLeast(client, [1, 10])).length, 2, metric.id);
    }
  });
});

describe("stat values", () => {
  it("activity: active days, longest streak, voice hours and time with Dreamliner", async () => {
    for (const date of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-10"]) {
      run("INSERT INTO guild_stats_user_daily (guild_id, user_id, stat_date, messages) VALUES ('g1', ?, ?, 4)", A, date);
    }
    // A second server on the same day doesn't add a day; a zero-message row doesn't count.
    run("INSERT INTO guild_stats_user_daily (guild_id, user_id, stat_date, messages) VALUES ('g2', ?, '2026-03-02', 1)", A);
    run("INSERT INTO guild_stats_user_daily (guild_id, user_id, stat_date, messages) VALUES ('g2', ?, '2026-03-11', 0)", A);
    run(
      "INSERT INTO guild_stats_user_voice_daily (guild_id, user_id, stat_date, minutes, seconds) VALUES ('g1', ?, '2026-02-20', 0, 7300)",
      A,
    );
    assert.equal(await value("active_days", A), 4);
    assert.equal(await value("longest_streak", A), 3);
    assert.equal(await value("voice_hours", A), 2);
    assert.equal(await value("dreamliner_days", A), metrics.daysSinceDate("2026-02-20"));
    const counts = await metrics.getMetric("active_days")!.countAtLeast!(client, [1, 4, 5]);
    assert.deepEqual(counts, [1, 1, 0]);
  });

  it("commands, emoji and music", async () => {
    run("INSERT INTO wrapped_command_usage (user_id, year, command_name, uses) VALUES (?, 2025, 'rank', 4), (?, 2026, 'rank', 6)", A, A);
    run(
      "INSERT INTO wrapped_emoji_usage (user_id, year, emoji_key, name, message_count, reaction_count) VALUES (?, 2026, 'x', 'x', 3, 2)",
      A,
    );
    run("INSERT INTO music_play_log (user_id, guild_id, title, duration_ms, played_at) VALUES (?, 'g1', 'a', 180000, ?), (?, 'g1', 'b', 150000, ?)", A, NOW, A, NOW);
    assert.equal(await value("commands_run", A), 10);
    assert.equal(await value("emoji_used", A), 5);
    assert.equal(await value("tracks_played", A), 2);
    assert.equal(await value("music_minutes", A), 5);
  });

  it("Hangar trades count both sides of accepted trades only", async () => {
    for (const [from, to, status] of [
      [A, B, "accepted"],
      [B, A, "accepted"],
      [A, C, "declined"],
    ]) {
      run(
        "INSERT INTO plane_card_trades (from_user_id, to_user_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        from,
        to,
        status,
        NOW,
        NOW,
      );
    }
    run("INSERT INTO plane_card_pack_openings (user_id, guild_id, cost, created_at) VALUES (?, 'g1', 10, ?)", A, NOW);
    assert.equal(await value("trades_completed", A), 2);
    assert.equal(await value("trades_completed", C), 0);
    assert.equal(await value("packs_opened", A), 1);
    assert.deepEqual(await metrics.getMetric("trades_completed")!.countAtLeast!(client, [1, 2]), [2, 2]);
  });

  it("quizzes: completed, perfect scores and live trivia wins (ties share the win)", async () => {
    const attempt = (userId: string, status: string, score: number, max: number) =>
      run(
        "INSERT INTO quiz_attempts (guild_id, quiz_id, user_id, status, seed, score, max_score, started_at) VALUES ('g1', 1, ?, ?, 's', ?, ?, ?)",
        userId,
        status,
        score,
        max,
        NOW,
      );
    attempt(A, "completed", 10, 10);
    attempt(A, "completed", 7, 10);
    attempt(A, "completed", 0, 0); // personality quiz: not graded
    attempt(A, "in_progress", 10, 10);
    assert.equal(await value("quizzes_completed", A), 3);
    assert.equal(await value("perfect_quizzes", A), 1);

    const game = (status: string) => {
      run(
        "INSERT INTO quiz_live_games (guild_id, quiz_id, channel_id, host_id, status, started_at) VALUES ('g1', 1, ?, 'h', ?, ?)",
        `c${Math.random()}`,
        status,
        NOW,
      );
      return (raw.prepare("SELECT MAX(id) AS id FROM quiz_live_games").get() as { id: number }).id;
    };
    const player = (gameId: number, userId: string, score: number) =>
      run("INSERT INTO quiz_live_players (game_id, user_id, score, joined_at) VALUES (?, ?, ?, ?)", gameId, userId, score, NOW);
    const g1 = game("finished");
    player(g1, A, 900);
    player(g1, B, 400);
    const g2 = game("finished");
    player(g2, A, 500);
    player(g2, B, 500);
    const g3 = game("cancelled");
    player(g3, B, 999);
    const g4 = game("finished");
    player(g4, C, 0);
    assert.equal(await value("trivia_wins", A), 2);
    assert.equal(await value("trivia_wins", B), 1);
    assert.equal(await value("trivia_wins", C), 0, "a zero score never wins");
  });

  it("giveaways, starboard, invites, suggestions and credits", async () => {
    run("INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (1, ?, ?), (2, ?, ?)", A, NOW, A, NOW);
    run(
      "INSERT INTO giveaway_winners (giveaway_id, user_id, status, selected_at) VALUES (1, ?, 'claimed', ?), (2, ?, 'rerolled', ?), (1, ?, 'won', ?)",
      A,
      NOW,
      A,
      NOW,
      A,
      NOW,
    );
    run(
      "INSERT INTO starboard_posts (guild_id, board_name, source_message_id, source_channel_id, starboard_message_id, star_count, created_at, author_id) VALUES ('g1', 'b', 'm1', 'c', 's1', 7, ?, ?), ('g1', 'b', 'm2', 'c', 's2', 5, ?, ?)",
      NOW,
      A,
      NOW,
      A,
    );
    const join = (status: string, counted: number) =>
      run(
        "INSERT INTO invite_joins (guild_id, member_id, inviter_id, source, joined_at, status, counted, account_created_at) VALUES ('g1', ?, ?, 'invite', ?, ?, ?, ?)",
        `m${Math.random()}`,
        A,
        NOW,
        status,
        counted,
        NOW,
      );
    join("valid", 1);
    join("valid", 1);
    join("fake", 1);
    join("valid", 0);
    const suggestion = (n: number, display: string, anonymous: number) =>
      run(
        "INSERT INTO suggestions (guild_id, suggestion_number, author_id, content, anonymous, display_status, created_at, updated_at) VALUES ('g1', ?, ?, 'x', ?, ?, ?, ?)",
        n,
        A,
        anonymous,
        display,
        NOW,
        NOW,
      );
    suggestion(1, "implemented", 0);
    suggestion(2, "implemented", 1);
    suggestion(3, "considered", 0);
    run(
      "INSERT INTO store_credit_ledger (user_id, delta, kind, currency, created_at) VALUES (?, 5, 'vote', 'credits', ?), (?, 5, 'vote', 'credits', ?), (?, -8, 'purchase', 'credits', ?), (?, 50, 'grant', 'credits', ?)",
      A,
      NOW,
      A,
      NOW,
      A,
      NOW,
      A,
      NOW,
    );
    assert.equal(await value("giveaways_entered", A), 2);
    assert.equal(await value("giveaways_won", A), 1);
    assert.equal(await value("stars_received", A), 12);
    assert.equal(await value("members_invited", A), 2);
    assert.equal(await value("suggestions_implemented", A), 1, "anonymous suggestions stay anonymous");
    assert.equal(await value("credits_earned", A), 10);
  });

  it("forms, custom commands, clips and birthdays", async () => {
    const form = (status: string, kind: string, anonymous: number) =>
      run(
        "INSERT INTO applications (guild_id, opening_id, opening_name, user_id, status, answers_json, created_at, form_kind, anonymous) VALUES ('g1', 'o', 'O', ?, ?, '[]', ?, ?, ?)",
        A,
        status,
        NOW,
        kind,
        anonymous,
      );
    form("accepted", "application", 0);
    form("pending", "survey", 0);
    form("accepted", "application", 1);
    run("INSERT INTO dream_commands (guild_id, name, program, created_by, created_at, updated_at) VALUES ('g1', 'hi', '{}', ?, ?, ?)", A, NOW, NOW);
    run(
      "INSERT INTO voice_clips (id, guild_id, channel_id, owner_id, duration_ms, file_name, byte_size, created_at) VALUES ('k1', 'g1', 'c', ?, 1000, 'f', 1, ?)",
      A,
      NOW,
    );
    run(
      "INSERT INTO birthday_celebrations (guild_id, user_id, year, celebrated_at) VALUES ('g1', ?, 2025, ?), ('g2', ?, 2025, ?), ('g1', ?, 2026, ?)",
      A,
      NOW,
      A,
      NOW,
      A,
      NOW,
    );
    assert.equal(await value("forms_submitted", A), 2);
    assert.equal(await value("applications_accepted", A), 1);
    assert.equal(await value("custom_commands_built", A), 1);
    assert.equal(await value("clips_created", A), 1);
    assert.equal(await value("birthdays_celebrated", A), 2);
  });

  it("batches several users in one lookup and caches briefly", async () => {
    const metric = metrics.getMetric("trades_completed")!;
    const values = await metrics.cachedMetricValues(metric, client, [A, B, C]);
    assert.deepEqual([values.get(A), values.get(B), values.get(C)], [2, 2, 0]);
    run(
      "INSERT INTO plane_card_trades (from_user_id, to_user_id, status, created_at, expires_at) VALUES (?, ?, 'accepted', ?, ?)",
      C,
      B,
      NOW,
      NOW,
    );
    assert.equal((await metrics.cachedMetricValues(metric, client, [C])).get(C), 0, "served from the cache");
    metrics.clearMetricValueCache();
    assert.equal((await metrics.cachedMetricValues(metric, client, [C])).get(C), 1);
  });
});

describe("generated art, unlock dates and rarity", () => {
  it("draws a PNG for every glyph", async () => {
    for (const glyph of GLYPH_IDS) {
      const image = await loadImage(generateTierArt(glyph, 3, 5));
      assert.equal(image.width, 256, glyph);
    }
    assert.ok(generateTierArt("not_a_glyph", 1, 1).length > 0);
  });

  it("a badge made without images gets generated art, redrawn on edit", async () => {
    const id = await store.createStoredBadge(
      {
        key: "trader",
        name: "Trader",
        metric: "trades_completed",
        tiers: [{ threshold: 3 }, { threshold: 1 }],
      },
      "admin",
      badges.BUILT_IN_KEYS,
    );
    const created = (await store.listStoredBadges()).find((badge) => badge.key === "trader")!;
    assert.deepEqual(
      created.tiers.map((tier) => tier.threshold),
      [1, 3],
    );
    assert.ok(created.tiers.every((tier) => store.isGeneratedArt(tier.imageVersion)));
    const art = await store.getTierImage(created.tiers[0]!.id);
    assert.equal(art?.contentType, "image/png");

    await store.updateStoredBadge(id, {
      name: "Trader",
      metric: "trades_completed",
      tiers: [...created.tiers.map((tier) => ({ threshold: tier.threshold, keepImageFrom: tier.id })), { threshold: 10 }],
    });
    const edited = (await store.listStoredBadges()).find((badge) => badge.key === "trader")!;
    assert.equal(edited.tiers.length, 3);
    assert.notEqual(edited.tiers[0]!.imageVersion, created.tiers[0]!.imageVersion, "generated art follows the new tier count");
    const admin = await badges.listAdminBadges(client);
    assert.ok(admin.badges.find((badge) => badge.key === "trader")!.tiers.every((tier) => tier.generatedArt));
    const listed = admin.metrics.find((metric) => metric.id === "trades_completed")!;
    assert.ok(listed.suggestedTiers.length > 0 && listed.levelUp);
  });

  it("tiers held at first sight have no date; tiers reached later do", async () => {
    clearUnlockCache();
    metrics.clearMetricValueCache();
    // A has 2 trades (tier 1 of 1/3/10): first sight, so no date.
    let [badge] = (await badges.getProgressionBadges(client, A)).filter((entry) => entry.id === "trader");
    assert.equal(badge?.tier, 1);
    assert.equal(badge?.since, null);
    assert.equal(badge?.progress?.unitOne, "trade");

    run(
      "INSERT INTO plane_card_trades (from_user_id, to_user_id, status, created_at, expires_at) VALUES (?, ?, 'accepted', ?, ?)",
      A,
      C,
      NOW,
      NOW,
    );
    metrics.clearMetricValueCache();
    [badge] = (await badges.getProgressionBadges(client, A)).filter((entry) => entry.id === "trader");
    assert.equal(badge?.tier, 2, "3 trades reaches tier 2");
    assert.ok(badge?.since, "a tier reached after first sight carries its date");
    for (let i = 0; i < 7; i++) {
      run(
        "INSERT INTO plane_card_trades (from_user_id, to_user_id, status, created_at, expires_at) VALUES (?, ?, 'accepted', ?, ?)",
        A,
        C,
        NOW,
        NOW,
      );
    }
    metrics.clearMetricValueCache();
    clearUnlockCache(); // dates survive a cold cache: they're read back from the table
    [badge] = (await badges.getProgressionBadges(client, A)).filter((entry) => entry.id === "trader");
    assert.equal(badge?.tier, 3);
    assert.ok(badge?.since && Date.now() - Date.parse(badge.since) < 60_000, "a newly reached tier carries its unlock date");
  });

  it("rarity is the share of tracked users who reached each tier", async () => {
    assert.equal(badges.reachedPercent(null, 10), null);
    assert.equal(badges.reachedPercent(1, 0), null);
    assert.equal(badges.reachedPercent(1, 3), 33.3);
    assert.equal(badges.reachedPercent(1, 5000), 0.1);
    run("INSERT INTO user_message_counts (user_id, count) VALUES (?, 5), (?, 5), (?, 5), (?, 5)", A, B, C, "100000000000000004");
    const catalog = await badges.listPublicBadgeCatalog(client);
    const trader = catalog.find((entry) => entry.key === "trader")!;
    assert.equal(trader.metric?.levelUp, metrics.getMetric("trades_completed")!.levelUp);
    // Tier 1 (1 trade): A, B, C of 4 tracked users.
    assert.equal(trader.tiers[0]!.reachedPct, 75);
    assert.ok(catalog.some((entry) => entry.key === "dreamliner_one"));
  });
});
