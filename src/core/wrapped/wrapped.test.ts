import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-wrapped-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
delete process.env.WRAPPED_FORCE_OPEN;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const { wrappedWindow, resolveWrappedAccess, yearBounds } = await import("./window.js");
const { parseMessageEmoji, reactionEmoji, recordEmojiUse, flushEmojiUsage, pendingEmojiCount, MAX_EMOJI_PER_MESSAGE } = await import("./emoji.js");
const { recordMusicPlay, isDuplicatePlay, dedupeWindowMs, trackKey } = await import("./musicPlays.js");
const { recordCommandUse, flushCommandUsage } = await import("./commands.js");
const { longestStreak, monthlyTotals, weekdayTotals, busiestDay, topPercent, sharePercent, yearHeatmap } = await import("./summary.js");
const { buildWrapped } = await import("./aggregate.js");
const { deleteUserWrappedData, countUserWrappedData } = await import("./store.js");
const { getDb } = await import("../../db/client.js");
const { buildWrappedReply } = await import("../../plugins/stats/commands/wrapped.js");

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
    /* harmless */
  }
});

const ALICE = "100000000000000001";
const BOB = "100000000000000002";

describe("window", () => {
  const phaseAt = (iso: string) => wrappedWindow(new Date(iso), false);

  it("phases: closed until 20 November, countdown to 1 December, open to the end of January (UTC)", () => {
    assert.equal(phaseAt("2026-11-19T23:59:59.999Z").phase, "closed");
    assert.equal(phaseAt("2026-11-20T00:00:00.000Z").phase, "countdown");
    assert.equal(phaseAt("2026-11-24T12:00:00Z").phase, "countdown");
    assert.equal(phaseAt("2026-11-30T23:59:59.999Z").phase, "countdown");
    assert.equal(phaseAt("2026-12-01T00:00:00.000Z").phase, "open");
    assert.equal(phaseAt("2027-01-31T23:59:59.999Z").phase, "open");
    assert.equal(phaseAt("2027-02-01T00:00:00.000Z").phase, "closed");
    assert.equal(phaseAt("2026-06-01T00:00:00Z").phase, "closed");
  });

  it("edition year and dates", () => {
    const w = phaseAt("2026-11-24T12:00:00Z");
    assert.equal(w.year, 2026);
    assert.equal(w.open, false);
    assert.equal(w.countdownAt, "2026-11-20T00:00:00.000Z");
    assert.equal(w.opensAt, "2026-12-01T00:00:00.000Z");
    assert.equal(w.closesAt, "2027-02-01T00:00:00.000Z");
    assert.deepEqual([phaseAt("2027-01-15T00:00:00Z").year, phaseAt("2027-02-01T00:00:00Z").year], [2026, 2027]);
    assert.equal(phaseAt("2026-12-01T00:00:00Z").open, true);
  });

  it("force open opens the current edition", () => {
    const w = wrappedWindow(new Date("2026-11-24T12:00:00Z"), true);
    assert.deepEqual([w.phase, w.open, w.year], ["open", true, 2026]);
  });

  it("access: superusers need an explicit preview; members never get one", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    assert.equal(resolveWrappedAccess(null, { superuser: false, now, forceOpen: false }).ok, false);
    assert.equal(resolveWrappedAccess(null, { superuser: false, preview: true, now, forceOpen: false }).ok, false);
    assert.equal(resolveWrappedAccess(null, { superuser: true, now, forceOpen: false }).ok, false);
    assert.deepEqual(resolveWrappedAccess(null, { superuser: true, preview: true, now, forceOpen: false }), { ok: true, year: 2026, preview: true });
    assert.deepEqual(resolveWrappedAccess(2025, { superuser: true, preview: true, now, forceOpen: false }), { ok: true, year: 2025, preview: true });
    assert.deepEqual(resolveWrappedAccess(2030, { superuser: true, preview: true, now, forceOpen: false }), { ok: false, reason: "invalid_year" });
    const dec = new Date("2026-12-05T00:00:00Z");
    assert.deepEqual(resolveWrappedAccess(null, { superuser: false, now: dec, forceOpen: false }), { ok: true, year: 2026, preview: false });
    assert.deepEqual(resolveWrappedAccess(2025, { superuser: false, now: dec, forceOpen: false }), { ok: false, reason: "invalid_year" });
  });

  it("/wrapped: countdown links to the countdown, closed has no link", () => {
    const text = (iso: string) => JSON.stringify(buildWrappedReply(phaseAt(iso)));
    assert.match(text("2026-11-24T12:00:00Z"), /opens on 1 December 2026/);
    assert.match(text("2026-11-24T12:00:00Z"), /See the countdown/);
    assert.match(text("2026-12-03T12:00:00Z"), /Open Wrapped 2026/);
    assert.match(text("2026-12-03T12:00:00Z"), /Open until 31 January 2027/);
    assert.doesNotMatch(text("2026-06-01T00:00:00Z"), /"url"/);
    assert.doesNotMatch(text("2026-11-24T12:00:00Z"), /[!—]/);
  });

  it("year bounds cover the calendar year in every unit", () => {
    const b = yearBounds(2026);
    assert.equal(b.startDate, "2026-01-01");
    assert.equal(b.endDate, "2026-12-31");
    assert.equal(b.endMs - b.startMs, 365 * 86_400_000);
    assert.equal(b.startSec, b.startMs / 1000);
  });
});

describe("emoji parsing", () => {
  it("finds custom and unicode emoji in order", () => {
    const found = parseMessageEmoji("hi <:wave:123456789012345678> there 😀 and <a:dance:223456789012345678> 👍🏽");
    assert.deepEqual(
      found.map((e) => e.key),
      ["c:123456789012345678", "😀", "c:223456789012345678", "👍🏽"],
    );
    assert.equal(found[2]!.animated, true);
    assert.equal(found[0]!.name, "wave");
  });

  it("keeps ZWJ sequences, flags and keycaps whole", () => {
    assert.deepEqual(parseMessageEmoji("👩‍💻 🇬🇧 1️⃣ ❤️").map((e) => e.key), ["👩‍💻", "🇬🇧", "1️⃣", "❤️"]);
  });

  it("ignores plain text symbols and digits", () => {
    assert.deepEqual(parseMessageEmoji("© 2026 ™ 123 #general :smile:"), []);
  });

  it("caps work per message", () => {
    assert.equal(parseMessageEmoji("😀".repeat(50)).length, MAX_EMOJI_PER_MESSAGE);
  });

  it("maps reactions", () => {
    assert.deepEqual(reactionEmoji({ id: "323456789012345678", name: "pog", animated: false }), { key: "c:323456789012345678", id: "323456789012345678", name: "pog", animated: false });
    assert.deepEqual(reactionEmoji({ id: null, name: "🔥" }), { key: "🔥", id: null, name: "🔥", animated: false });
    assert.equal(reactionEmoji({ id: null, name: null }), null);
  });

  it("batches counts and writes them in one flush", () => {
    const at = Date.UTC(2026, 5, 1);
    recordEmojiUse(ALICE, parseMessageEmoji("😀 😀 🔥"), "message", at);
    recordEmojiUse(ALICE, [reactionEmoji({ id: null, name: "😀" })!], "reaction", at);
    assert.equal(pendingEmojiCount(), 2);
    assert.equal(flushEmojiUsage(), 2);
    assert.equal(pendingEmojiCount(), 0);
    recordEmojiUse(ALICE, parseMessageEmoji("😀"), "message", at);
    flushEmojiUsage();
    const rows = raw().prepare("SELECT emoji_key, message_count, reaction_count FROM wrapped_emoji_usage WHERE user_id = ? ORDER BY emoji_key").all(ALICE);
    assert.deepEqual(rows, [
      { emoji_key: "🔥", message_count: 1, reaction_count: 0 },
      { emoji_key: "😀", message_count: 3, reaction_count: 1 },
    ]);
  });
});

describe("music play log dedupe", () => {
  it("dedupe window follows the track length", () => {
    assert.equal(dedupeWindowMs(0, true), 10 * 60_000);
    assert.equal(dedupeWindowMs(10_000), 30_000);
    assert.equal(dedupeWindowMs(200_000), 195_000);
    assert.equal(dedupeWindowMs(3 * 60 * 60_000), 30 * 60_000);
  });

  it("same person, track and server within the window is a duplicate", () => {
    const prev = { userId: ALICE, guildId: "g1", key: "u", playedAt: 1_000_000, durationMs: 200_000 };
    assert.equal(isDuplicatePlay(prev, { ...prev, playedAt: 1_000_000 + 60_000 }), true);
    assert.equal(isDuplicatePlay(prev, { ...prev, playedAt: 1_000_000 + 200_000 }), false); // looped
    assert.equal(isDuplicatePlay(prev, { ...prev, userId: BOB, playedAt: 1_000_001 }), false);
    assert.equal(isDuplicatePlay(prev, { ...prev, key: "other", playedAt: 1_000_001 }), false);
    assert.equal(isDuplicatePlay(null, prev), false);
  });

  it("track key prefers the uri", () => {
    assert.equal(trackKey({ uri: "https://x/1", title: "A", author: "B" }), "https://x/1");
    assert.equal(trackKey({ uri: null, title: " Song ", author: "Band" }), "song|band");
  });

  it("logs once per play start", () => {
    const base = Date.UTC(2026, 5, 1, 12);
    const play = { userId: ALICE, guildId: "g1", title: "Song", author: "Band", uri: "https://x/1", artworkUrl: null, sourceName: "youtube", durationMs: 180_000 };
    assert.equal(recordMusicPlay(play, base), true);
    assert.equal(recordMusicPlay(play, base + 2_000), false); // resumed / retried
    assert.equal(recordMusicPlay(play, base + 181_000), true); // played again
    assert.equal(recordMusicPlay({ ...play, guildId: "g2" }, base + 182_000), true);
    for (let i = 0; i < 3; i++) recordMusicPlay({ ...play, uri: `https://x/${i + 2}`, title: `Other ${i}` }, base + 400_000 + i * 200_000);
  });
});

describe("summary helpers", () => {
  it("longest streak", () => {
    assert.equal(longestStreak([]), null);
    assert.deepEqual(longestStreak(["2026-03-02", "2026-03-01", "2026-03-03", "2026-03-05", "2026-03-03"]), { days: 3, start: "2026-03-01", end: "2026-03-03" });
    assert.deepEqual(longestStreak(["2026-12-31", "2027-01-01"]), { days: 2, start: "2026-12-31", end: "2027-01-01" });
  });

  it("months, weekdays and the busiest day", () => {
    const rows = [
      { date: "2026-01-05", value: 3 }, // Monday
      { date: "2026-01-11", value: 2 }, // Sunday
      { date: "2026-12-01", value: 5 },
    ];
    const months = monthlyTotals(rows);
    assert.equal(months[0], 5);
    assert.equal(months[11], 5);
    assert.deepEqual(weekdayTotals(rows), [3, 5, 0, 0, 0, 0, 2]);
    assert.deepEqual(busiestDay(rows), { date: "2026-12-01", value: 5 });
    assert.equal(busiestDay([]), null);
  });

  it("year heatmap has one level per day", () => {
    const map = yearHeatmap(2026, [
      { date: "2026-01-01", value: 1 },
      { date: "2026-01-02", value: 100 },
      { date: "2026-12-31", value: 50 },
    ]);
    assert.equal(map.length, 365);
    assert.equal(map[0], "1");
    assert.equal(map[1], "4");
    assert.equal(map[2], "0");
    assert.equal(map[364], "2");
    assert.equal(yearHeatmap(2028, []).length, 366);
  });

  it("top percent and shares", () => {
    const totals = [100, 50, 20, 10, 5, 1, 1, 1, 1, 1];
    assert.equal(topPercent(totals, 100), 10);
    assert.equal(topPercent(totals, 20), 30);
    assert.equal(topPercent(totals, 0), null);
    assert.equal(topPercent([5, 4], 5), null);
    assert.equal(sharePercent(1, 3), 33);
    assert.equal(sharePercent(1, 0), 0);
  });
});

describe("buildWrapped", () => {
  const client = {
    users: { fetch: async () => ({ username: "alice", globalName: "Alice", displayAvatarURL: () => "https://cdn/avatar.png" }) },
    guilds: { cache: new Map([["g1", { name: "Home", iconURL: () => null }]]) },
  } as unknown as import("discord.js").Client;

  it("only reads the subject's own rows, bounded to the year, and skips empty sections", async () => {
    const db = raw();
    const insert = db.prepare("INSERT INTO guild_stats_user_daily (guild_id, user_id, stat_date, messages) VALUES (?, ?, ?, ?)");
    insert.run("g1", ALICE, "2026-03-01", 10);
    insert.run("g1", ALICE, "2026-03-02", 30);
    insert.run("g2", ALICE, "2026-03-02", 10); // a server the bot left: counted, not named
    insert.run("g1", ALICE, "2025-12-31", 999); // last year
    insert.run("g1", BOB, "2026-03-01", 5000); // someone else
    recordCommandUse(ALICE, "rank", Date.UTC(2026, 2, 1));
    recordCommandUse(ALICE, "rank", Date.UTC(2026, 2, 1));
    recordCommandUse(BOB, "ban", Date.UTC(2026, 2, 1));
    flushCommandUsage();

    const w = await buildWrapped(client, ALICE, 2026, { yearTotals: () => [5000, 50], now: new Date("2026-12-02T00:00:00Z") });
    assert.equal(w.user.name, "Alice");
    assert.equal(w.messages?.total, 50);
    assert.equal(w.messages?.topPercent, null); // pool too small
    assert.deepEqual(w.servers?.top.map((s) => [s.id, s.messages, s.share]), [["g1", 40, 80]]);
    assert.equal(w.servers?.count, 2);
    assert.deepEqual(w.rhythm?.busiestDay, { date: "2026-03-02", messages: 40 });
    assert.deepEqual(w.streaks?.longest, { days: 2, start: "2026-03-01", end: "2026-03-02" });
    assert.equal(w.emoji?.top[0]?.key, "😀");
    assert.equal(w.music?.plays, 6);
    assert.equal(w.music?.topTracks[0]?.plays, 3);
    assert.equal(w.music?.topArtist?.name, "Band");
    assert.deepEqual(w.commands?.top, [{ name: "rank", uses: 2 }]);
    assert.equal(w.voice, null);
    assert.equal(w.hangar, null);
    assert.equal(w.community, null);
    assert.equal(w.extras.words.length, 3);
    assert.equal(w.extras.rhythm?.averagePerActiveDay, 25);
    assert.equal(w.extras.standings?.home?.rank, 2); // Bob sent more in g1
    assert.ok(w.extras.events.some((e) => e.kind === "busiest_day"));

    const empty = await buildWrapped(client, BOB, 2025, { yearTotals: () => [] });
    assert.equal(empty.messages, null);
    assert.equal(empty.music, null);
    assert.equal(empty.commands, null);
  });

  it("music slides need enough plays", async () => {
    const w = await buildWrapped(client, BOB, 2026, { yearTotals: () => [] });
    assert.equal(w.music, null);
  });

  it("erase removes emoji, music and command rows", () => {
    assert.ok(countUserWrappedData(ALICE).music > 0);
    recordEmojiUse(ALICE, parseMessageEmoji("🎉"), "message");
    const deleted = deleteUserWrappedData(ALICE);
    assert.ok(deleted.emoji > 0 && deleted.music > 0 && deleted.commands > 0);
    flushEmojiUsage(); // the pending 🎉 must not come back
    assert.deepEqual(countUserWrappedData(ALICE), { emoji: 0, music: 0, commands: 0 });
    assert.equal(countUserWrappedData(BOB).commands, 1);
  });
});

describe("deeper helpers", async () => {
  const { busiestWeek, longestGap, weekendShare, quietestMonth, pickArchetype, yearInWords } = await import("./summary.js");
  const { listeningPersonality } = await import("./extras.js");
  const base = { messages: 0, activeDays: 0, voiceHours: 0, nightShare: 0, servers: 1, cards: 0, musicPlays: 0, emoji: 0, community: 0, longestStreak: 0, topShare: 0 };

  it("busiest week starts on a Monday", () => {
    const week = busiestWeek([
      { date: "2026-03-02", value: 5 }, // Monday
      { date: "2026-03-08", value: 5 }, // Sunday, same week
      { date: "2026-03-09", value: 8 }, // next Monday
    ]);
    assert.deepEqual(week, { start: "2026-03-02", value: 10 });
    assert.equal(busiestWeek([]), null);
  });

  it("longest gap and comeback", () => {
    assert.deepEqual(longestGap(["2026-01-01", "2026-01-02", "2026-01-10", "2026-01-12"]), { days: 7, comeback: "2026-01-10" });
    assert.equal(longestGap(["2026-01-01", "2026-01-02"]), null);
  });

  it("weekend share and quietest month", () => {
    assert.equal(weekendShare([{ date: "2026-03-07", value: 1 }, { date: "2026-03-09", value: 3 }]), 25); // Sat vs Mon
    assert.deepEqual(quietestMonth([0, 5, 2, 9, 0]), { month: 2, value: 2 });
    assert.equal(quietestMonth([0, 4, 0]), null);
  });

  it("archetypes follow the strongest signal, quiet years stay calm", () => {
    assert.equal(pickArchetype(base).key, "quiet");
    assert.equal(pickArchetype({ ...base, voiceHours: 40, messages: 100 }).key, "voice");
    assert.equal(pickArchetype({ ...base, messages: 2000, nightShare: 0.5, activeDays: 30 }).key, "night");
    assert.equal(pickArchetype({ ...base, cards: 120 }).key, "collector");
    assert.equal(pickArchetype({ ...base, activeDays: 200, longestStreak: 60, messages: 3000 }).key, "regular");
    assert.equal(pickArchetype({ ...base, servers: 9, messages: 400 }).key, "socialite");
    for (const a of [pickArchetype(base), pickArchetype({ ...base, cards: 120 })]) assert.doesNotMatch(a.line + a.label, /[!—]/);
  });

  it("three words, always three, never repeated", () => {
    const words = yearInWords({ ...base, messages: 6000, longestStreak: 40, voiceHours: 30, activeDays: 100 });
    assert.equal(words.length, 3);
    assert.equal(new Set(words).size, 3);
    assert.equal(yearInWords(base).length, 3);
  });

  it("listening personality", () => {
    assert.equal(listeningPersonality({ plays: 100, distinct: 20, topArtistPlays: 10, peakHour: 15 }).key, "repeat");
    assert.equal(listeningPersonality({ plays: 100, distinct: 90, topArtistPlays: 5, peakHour: 15 }).key, "explorer");
    assert.equal(listeningPersonality({ plays: 100, distinct: 60, topArtistPlays: 40, peakHour: 15 }).key, "loyal");
    assert.equal(listeningPersonality({ plays: 100, distinct: 60, topArtistPlays: 5, peakHour: 1 }).key, "night");
  });
});
