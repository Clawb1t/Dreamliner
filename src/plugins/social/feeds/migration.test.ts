/**
 * 0147_feeds.sql: old YouTube/Twitch watchers become sources + subscriptions with their message,
 * roles, card and options kept, their checkpoints seeded so nothing re-posts, and their
 * deliveries copied for stats. Runs every migration before 0147 on a temp DB, inserts old rows,
 * then applies 0147 and checks the result through the new store.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-feeds-migration-"));
const dbPath = join(scratchDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../../drizzle/migrations");
const FEEDS_MIGRATION = "0147_feeds.sql";

const now = Math.floor(Date.now() / 1000);
const GUILD = "123456789012345678";
const OTHER_GUILD = "223456789012345678";

{
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (file >= FEEDS_MIGRATION) break;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(file, Date.now());
  }

  const yt = db.prepare(
    `INSERT INTO social_youtube_watchers (guild_id, discord_channel_id, source_channel_id, source_channel_handle, source_channel_name, source_channel_avatar_url, source_channel_url, uploads_playlist_id, message_content, mention_role_ids, embed_config, last_video_id, last_video_published_at, last_checked_at, options, delivered_count, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Two servers following the same channel: one source, two subscriptions.
  yt.run(GUILD, "333333333333333333", "UCchan", "@chan", "Chan", "https://yt3.example/a.jpg", "https://www.youtube.com/@chan", "UUchan",
    "{roles} **{channel_name}** posted {video_url}", JSON.stringify(["444444444444444444"]),
    JSON.stringify({ enabled: true, title: "{video_title}", description: "", color: 16711680, author_name: "{channel_name}", author_url: "", author_icon: "channel", author_icon_url: "", thumbnail: "none", thumbnail_url: "", image: "video", image_url: "", footer_text: "", footer_icon: "none", footer_icon_url: "", timestamp: true, fields: [], buttons: [{ label: "Watch", url: "{video_url}" }] }),
    "vid-checkpoint", now - 3600, now - 60,
    JSON.stringify({ notify_shorts: false, cooldown_minutes: 15, quiet_enabled: true, quiet_start: 22, quiet_end: 7, quiet_timezone: "Europe/London", short_override: { custom: true, message: "Short!", role_ids: [] }, milestones: true, milestone_last: 1000 }),
    7, 1, "1", now - 86400, now - 100);
  yt.run(OTHER_GUILD, "555555555555555555", "UCchan", "@chan", "Chan", null, "https://www.youtube.com/@chan", "UUchan",
    "", "[]", JSON.stringify({ enabled: false, buttons: [{ label: "Hidden", url: "{video_url}" }] }),
    "vid-checkpoint", now - 3600, now - 60, "{}", 1, 0, "2", now - 86400, now - 200);

  db.prepare(
    `INSERT INTO social_twitch_watchers (guild_id, discord_channel_id, source_user_id, source_user_login, source_user_display_name, source_user_avatar_url, source_user_url, message_content, mention_role_ids, embed_config, last_stream_id, last_live_at, last_checked_at, last_seen_live_at, options, delivered_count, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(GUILD, "666666666666666666", "777", "streamer", "Streamer", null, "https://www.twitch.tv/streamer",
    "**{streamer_name}** is live! {stream_url}", "[]", "this is not json", "stream-9", now - 1800, now - 30, now - 30,
    JSON.stringify({ end_action: "edit", live_updates: true }), 3, 1, "1", now - 86400, now - 50);

  const ytIds = db.prepare("SELECT id FROM social_youtube_watchers ORDER BY id").all() as { id: number }[];
  const twId = (db.prepare("SELECT id FROM social_twitch_watchers").get() as { id: number }).id;
  const delivery = db.prepare(
    `INSERT INTO social_deliveries (platform, watcher_id, guild_id, channel_id, message_id, kind, item_id, title, url, thumbnail_url, game_name, peak_viewers, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  delivery.run("youtube", ytIds[0]!.id, GUILD, "333333333333333333", "888888888888888881", "video", "vid-older", "Older video", "https://www.youtube.com/watch?v=vid-older", null, null, 0, null, null, now - 7200);
  delivery.run("youtube", ytIds[0]!.id, GUILD, "333333333333333333", "888888888888888882", "video", "vid-checkpoint", "Checkpoint video", "https://www.youtube.com/watch?v=vid-checkpoint", "https://i.ytimg.com/x.jpg", null, 0, null, null, now - 3500);
  // An open Twitch session (still live): its message must be found again when the stream ends.
  delivery.run("twitch", twId, GUILD, "666666666666666666", "888888888888888883", "stream", "stream-9", "Live stream", "https://www.twitch.tv/streamer", null, "Just Chatting", 42, now - 1800, null, now - 1790);

  db.exec(readFileSync(join(MIGRATIONS, FEEDS_MIGRATION), "utf8"));
  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(FEEDS_MIGRATION, Date.now());
  db.close();
}

const store = await import("./store.js");
const { getDb } = await import("../../../db/client.js");
const { refreshSource } = await import("./poller.js");
const { deliverPending } = await import("./deliver.js");
const { handleTwitchSource } = await import("./twitch.js");
const { buildFeedPayload } = await import("./render.js");
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

describe("0147_feeds migration", () => {
  it("drops the old tables", () => {
    const names = (raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'social_%'").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, []);
  });

  it("makes one source per creator, shared by every server following it", async () => {
    const yt = await store.getSourceByKey("youtube:UCchan");
    assert.ok(yt);
    assert.equal(yt.type, "youtube");
    assert.equal(yt.title, "Chan");
    assert.equal(yt.config.uploadsPlaylistId, "UUchan");
    assert.equal(yt.config.handle, "@chan");
    assert.equal(yt.intervalS, 300);
    assert.equal(yt.state.baselineBefore, (now - 3600) * 1000);
    const tw = await store.getSourceByKey("twitch:777");
    assert.ok(tw);
    assert.equal(tw.config.login, "streamer");
    assert.equal(tw.state.streamId, "stream-9");
    assert.equal(tw.state.lastSeenLiveAt, (now - 30) * 1000);
    const subs = [...(await store.listSubscriptions(GUILD)), ...(await store.listSubscriptions(OTHER_GUILD))];
    assert.equal(subs.length, 3);
    assert.equal(subs.filter((s) => s.sourceId === yt.id).length, 2);
  });

  it("keeps message text, roles, the card, buttons, filters and options", async () => {
    const [ytSub, twSub] = await store.listSubscriptions(GUILD);
    assert.ok(ytSub && twSub);
    assert.equal(ytSub.channelId, "333333333333333333");
    assert.equal(ytSub.message.content, "{roles} **{channel_name}** posted {video_url}");
    assert.deepEqual(ytSub.mentionRoleIds, ["444444444444444444"]);
    assert.equal(ytSub.message.embed.enabled, true);
    assert.equal(ytSub.message.embed.title, "{video_title}");
    assert.equal(ytSub.message.embed.color, 16711680);
    assert.deepEqual(ytSub.message.buttons, [{ label: "Watch", url: "{video_url}" }]);
    assert.deepEqual([ytSub.filters.youtube_videos, ytSub.filters.youtube_shorts, ytSub.filters.youtube_live], [true, false, true]);
    assert.equal(ytSub.options.cooldown_minutes, 15);
    assert.equal(ytSub.options.quiet_enabled, true);
    assert.equal(ytSub.options.quiet_timezone, "Europe/London");
    assert.equal(ytSub.options.short_override.message, "Short!");
    assert.equal(ytSub.options.milestones, true);
    assert.equal(ytSub.options.milestone_last, 1000);
    assert.equal(ytSub.deliveredCount, 7);
    assert.match(ytSub.legacyRef ?? "", /^youtube:\d+$/);

    // A watcher whose card was off loses its card-only buttons (they were never shown), and stays paused.
    const [other] = await store.listSubscriptions(OTHER_GUILD);
    assert.equal(other!.enabled, false);
    assert.equal(other!.message.embed.enabled, false);
    assert.deepEqual(other!.message.buttons, []);

    // A corrupt embed config falls back to defaults instead of failing the migration.
    assert.equal(twSub.message.content, "**{streamer_name}** is live! {stream_url}");
    assert.equal(twSub.message.embed.enabled, false);
    assert.equal(twSub.options.end_action, "edit");
    assert.equal(twSub.options.live_updates, true);
  });

  it("copies deliveries for stats and keeps the Twitch session open", async () => {
    const rows = raw().prepare("SELECT status, message_id, payload, guild_id FROM feed_deliveries ORDER BY id").all() as { status: string; message_id: string; payload: string; guild_id: string }[];
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === "sent" && r.guild_id === GUILD));
    const [, twSub] = await store.listSubscriptions(GUILD);
    const open = store.openTwitchSession(twSub!.id);
    assert.ok(open);
    assert.equal(open.messageId, "888888888888888883");
    assert.equal(open.payload.peakViewers, 42);
    assert.equal(open.payload.gameName, "Just Chatting");
    const stats = await store.guildFeedStats(GUILD, await store.listSubscriptions(GUILD));
    assert.equal([...stats.values()].reduce((n, s) => n + s.delivered30d, 0), 3);
  });

  it("seeds checkpoints: the first YouTube poll posts only uploads newer than the old checkpoint", async () => {
    const source = (await store.getSourceByKey("youtube:UCchan"))!;
    const upload = (key: string, minutesAgo: number) => ({
      key,
      title: key,
      url: `https://www.youtube.com/watch?v=${key}`,
      imageUrl: null,
      summary: "",
      author: null,
      tags: [],
      publishedAt: new Date(Date.now() - minutesAgo * 60_000),
      payload: { kind: "video" },
    });
    const adapter = {
      fetch: async () => ({
        items: [upload("vid-new", 5), upload("vid-checkpoint", 60), upload("vid-older", 120), upload("vid-oldest", 600), upload("vid-ancient", 6000)],
      }),
    };
    const result = await refreshSource(source, new Date(), adapter);
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.inserted.map((i) => i.itemKey), ["vid-new"]);

    const sent: string[] = [];
    const sender = async (_s: unknown, payload: unknown) => {
      sent.push(/watch\?v=([\w-]+)/.exec(JSON.stringify(payload))?.[1] ?? "?");
      return { messageId: "999999999999999999", channelId: "333333333333333333" };
    };
    const [ytSub] = await store.listSubscriptions(GUILD);
    await deliverPending(ytSub!, (await store.getSource(source.id))!, sender);
    assert.deepEqual(sent, ["vid-new"]);
    // The paused server's subscription posts nothing.
    const [other] = await store.listSubscriptions(OTHER_GUILD);
    assert.equal(store.pendingItemsFor(other!, 10).length, 1, "pending, but the poller skips paused feeds");
    assert.deepEqual(store.subscriptionsWithPendingItems().includes(other!.id), false);
  });

  it("seeds Twitch: the stream that was already announced doesn't post again", async () => {
    const source = (await store.getSourceByKey("twitch:777"))!;
    const [, twSub] = await store.listSubscriptions(GUILD);
    const sent: string[] = [];
    const sender = async () => {
      sent.push("x");
      return { messageId: "999999999999999998", channelId: "666666666666666666" };
    };
    const stream = { streamId: "stream-9", title: "Live stream", url: "https://www.twitch.tv/streamer", thumbnailUrl: "", gameName: "Just Chatting", viewerCount: 50, startedAt: new Date((now - 1800) * 1000) };
    await handleTwitchSource({} as never, source, stream, [twSub!], sender as never);
    assert.equal(sent.length, 0);
    // Peak viewers keep being tracked on the migrated session.
    assert.equal(store.openTwitchSession(twSub!.id)!.payload.peakViewers, 50);
  });

  it("renders converted messages with the old tokens", async () => {
    const [ytSub] = await store.listSubscriptions(GUILD);
    const source = (await store.getSourceByKey("youtube:UCchan"))!;
    const item = store.latestItems(source.id, 1)[0]!;
    const payload = buildFeedPayload(ytSub!.message, source, item, { roleIds: ytSub!.mentionRoleIds });
    const text = JSON.stringify(payload);
    assert.match(text, /<@&444444444444444444> \*\*Chan\*\* posted https:\/\/www\.youtube\.com\/watch\?v=vid-new/);
    assert.match(text, /"label":"Watch"/);
  });
});
