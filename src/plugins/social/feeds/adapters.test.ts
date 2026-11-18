import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_CATEGORIES, FEED_CATALOG, catalogSourceKey, getCatalogEntry } from "./catalog.js";
import { isCatalogGenre, isCatalogPlatform } from "./catalogTags.js";
import { youtubeWideThumbnail } from "./banners.js";
import { adapterFor } from "./adapters/index.js";
import { parseFeed } from "./parser.js";
import { parseSteamNews, parseSteamSearch, steamNewsUrl } from "./adapters/steam.js";
import { parseRiotStatus, riotStatusUrl } from "./adapters/riot.js";
import { ROCKSTAR_QUERY_HASH, isPersistedQueryMiss, parseRockstar, rockstarRequestUrl } from "./adapters/rockstar.js";
import { parseEpicFree, parseFortnite, parseHoyo, parseMojang } from "./adapters/games.js";
import { HEALTH_FAILS_FOR_DOWN, stepHealth, type HealthState } from "./adapters/health.js";
import type { FeedItemInput } from "./types.js";

/** Real responses saved on 2026-11-18 (trimmed to their first few items). */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const raw = (name: string) => readFileSync(join(FIXTURES, name));
const json = <T>(name: string) => JSON.parse(raw(name).toString("utf8")) as T;

/** Which saved response stands in for each catalogue entry's upstream. */
const RSS_FIXTURES: Record<string, string> = {
  bungie: "bungie.rss",
  "roblox-devforum": "roblox-devforum.rss",
  "playstation-blog": "playstation.rss",
  "xbox-wire": "xbox.rss",
  "nintendo-uk": "nintendo-eu.xml",
  "nintendo-jp": "nintendo-jp.xml",
  "status-discord": "status-discord.rss",
  "status-epic": "status-epic.rss",
  "status-github": "status-github.atom",
  "status-reddit": "status-reddit.rss",
  "status-roblox": "status-roblox.rss",
  "news-ign": "ign.rss",
  "news-pcgamer": "pcgamer.rss",
  "news-verge-games": "verge-games.atom",
  "news-gamespot": "gamespot.rss",
  "news-eurogamer": "eurogamer.rss",
  "news-rps": "rps.rss",
  "news-polygon": "polygon.rss",
  "news-kotaku": "kotaku.rss",
  "news-vgc": "vgc.rss",
  "news-gamesindustry": "gamesindustry.rss",
  "news-nintendolife": "nintendolife.rss",
  "news-gematsu": "gematsu.rss",
};

const NOW = new Date("2026-11-18T19:00:00Z");

/** The saved response for an RSS catalogue entry: the launch set above, or __fixtures__/catalog/<key>.xml. */
function rssFixture(key: string): string | null {
  if (RSS_FIXTURES[key]) return RSS_FIXTURES[key]!;
  const file = `catalog/${key}.xml`;
  return existsSync(join(FIXTURES, file)) ? file : null;
}

function itemsFor(key: string): FeedItemInput[] {
  const entry = getCatalogEntry(key)!;
  if (entry.type === "youtube") {
    // Creators share one saved uploads feed (the banner path); the feed itself is a YouTube source.
    return parseFeed(raw("catalog/youtube-uploads.xml"), String(entry.config.url)).items;
  }
  switch (entry.adapter) {
    case "rss":
      return parseFeed(raw(rssFixture(key)!), String(entry.config.url)).items;
    case "steam":
      // Every featured Steam game shares the adapter; CS2's saved response stands in for all of them.
      return parseSteamNews(json("steam-cs2.json"), String(entry.config.appId));
    case "rockstar":
      return parseRockstar(json("rockstar-gta6.json"));
    case "mojang":
      return parseMojang(json(`mojang-${String(entry.config.feed)}.json`), entry.config.feed as "java");
    case "fortnite":
      return parseFortnite(json("fortnite-br.json"));
    case "hoyoverse":
      return parseHoyo(json(entry.config.game === "genshin" ? "hoyo-genshin.json" : "hoyo-hsr.json"), entry.config.game as "genshin");
    case "epicFree":
      return parseEpicFree(json("epic-free.json"), NOW);
    case "riotStatus":
      return entry.config.game === "lol"
        ? parseRiotStatus(json("riot-lol-euw1.json"), "lol", "euw1")
        : parseRiotStatus(json("riot-val-eu.json"), "valorant", "eu");
    case "healthCheck":
      return healthOutage(String(entry.config.serviceName ?? entry.name), entry.siteUrl).events;
    default:
      throw new Error(`no fixture for adapter ${entry.adapter}`);
  }
}

function assertWellFormed(key: string, items: FeedItemInput[]) {
  assert.ok(items.length > 0, `${key}: no items`);
  const keys = new Set<string>();
  for (const item of items) {
    assert.ok(item.key, `${key}: empty dedupe key`);
    assert.ok(!keys.has(item.key), `${key}: duplicate key ${item.key}`);
    keys.add(item.key);
    assert.ok(item.title.trim(), `${key}: empty title`);
    assert.match(item.url, /^https?:\/\//, `${key}: bad url ${item.url}`);
    if (item.imageUrl) assert.match(item.imageUrl, /^https?:\/\//, `${key}: bad image ${item.imageUrl}`);
    assert.ok(item.summary.length <= 320, `${key}: summary too long`);
  }
}

/** Feeds run by someone other than the publisher: the only entries without the verified badge. */
const UNOFFICIAL = new Set(["rockstar-latest", "rockstar-gta6", "rockstar-gta-online", "rockstar-gta5", "rockstar-rdr2", "rockstar-red-dead-online", "fortnite-br"]);

describe("catalogue", () => {
  const categories = new Set<string>(CATALOG_CATEGORIES.map((c) => c.key));

  it("has a valid shape for every entry: unique key, known category, adapter, app emoji, https links", () => {
    const keys = new Set<string>();
    for (const entry of FEED_CATALOG) {
      assert.match(entry.key, /^[a-z0-9][a-z0-9-]{1,63}$/, entry.key);
      assert.ok(!keys.has(entry.key), `duplicate key ${entry.key}`);
      keys.add(entry.key);
      assert.ok(entry.name.trim() && entry.description.trim(), `${entry.key}: name and description`);
      assert.ok(categories.has(entry.category), `${entry.key}: category ${entry.category}`);
      assert.ok(["newswire", "steam", "statuspage", "youtube"].includes(entry.type), `${entry.key}: type`);
      assert.ok(adapterFor({ type: entry.type, config: { ...entry.config, adapter: entry.adapter } }), entry.key);
      assert.match(entry.emoji, /^<:icons_[A-Za-z0-9_]+:\d+>$/, `${entry.key}: app emojis only`);
      assert.doesNotMatch(`${entry.name} ${entry.description} ${entry.group ?? ""}`, /—/, `${entry.key}: no em dashes`);
      assert.match(entry.siteUrl, /^https:\/\//, `${entry.key}: siteUrl`);
      assert.match(entry.iconUrl, /^https:\/\//, `${entry.key}: iconUrl`);
      if (entry.artUrl) assert.match(entry.artUrl, /^https:\/\//, `${entry.key}: artUrl`);
      assert.ok(entry.group?.trim(), `${entry.key}: every entry has a group`);
      assert.ok(entry.intervalS >= 60, `${entry.key}: interval`);
      assert.ok(Number.isInteger(entry.color) && entry.color >= 0 && entry.color <= 0xffffff, `${entry.key}: color`);
      assert.ok(entry.genres.every(isCatalogGenre), `${entry.key}: genres ${entry.genres.join(",")}`);
      assert.ok(entry.platforms.every(isCatalogPlatform), `${entry.key}: platforms ${entry.platforms.join(",")}`);
      assert.equal(typeof entry.official, "boolean", `${entry.key}: official flag`);
    }
  });

  it("is big enough to browse, every category has entries and launch keys stay stable", () => {
    assert.ok(FEED_CATALOG.length >= 150, `only ${FEED_CATALOG.length} entries`);
    for (const key of ["rockstar-gta6", "minecraft-java", "steam-cs2", "fortnite-br", "playstation-blog", "status-discord", "news-ign", "yt-mrbeast"]) {
      assert.ok(getCatalogEntry(key), `missing ${key}`);
    }
    for (const category of categories) assert.ok(FEED_CATALOG.some((e) => e.category === category), `empty category ${category}`);
  });

  it("marks only the Rockstar Newswire and Fortnite news unofficial", () => {
    for (const entry of FEED_CATALOG) assert.equal(entry.official, !UNOFFICIAL.has(entry.key), entry.key);
  });

  it("has a curated, ordered Featured row", () => {
    const featured = FEED_CATALOG.filter((e) => e.featured !== null).map((e) => e.featured!);
    assert.ok(featured.length >= 5);
    assert.equal(new Set(featured).size, featured.length, "featured positions are unique");
  });

  it("has a verified upstream for every entry: a saved response, a checked Steam app id or a checked channel id", () => {
    const appIds = new Set<string>();
    const channels = new Set<string>();
    for (const entry of FEED_CATALOG) {
      if (entry.type === "steam") {
        const appId = String(entry.config.appId);
        assert.match(appId, /^\d{1,10}$/, `${entry.key}: app id`);
        assert.ok(!appIds.has(appId), `${entry.key}: duplicate app ${appId}`);
        appIds.add(appId);
      } else if (entry.type === "youtube") {
        const channelId = String(entry.config.channelId);
        assert.match(channelId, /^UC[\w-]{22}$/, `${entry.key}: channel id`);
        assert.ok(!channels.has(channelId), `${entry.key}: duplicate channel ${channelId}`);
        channels.add(channelId);
        assert.equal(entry.config.url, `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, `${entry.key}: banner feed`);
        assert.equal(entry.adapter, "rss", `${entry.key}: the banner reads the public uploads feed`);
      } else if (entry.adapter === "rss") {
        assert.ok(rssFixture(entry.key), `${entry.key}: no saved response in __fixtures__`);
        assert.match(String(entry.config.url), /^https:\/\//, `${entry.key}: feed url`);
      }
    }
  });

  it("maps Steam games and creators onto the shared source and regions into the key", () => {
    assert.equal(catalogSourceKey(getCatalogEntry("steam-cs2")!), "steam:730");
    assert.equal(catalogSourceKey(getCatalogEntry("status-valorant")!, "eu"), "statuspage:status-valorant:eu");
    assert.equal(catalogSourceKey(getCatalogEntry("rockstar-gta6")!), "newswire:rockstar-gta6");
    assert.equal(catalogSourceKey(getCatalogEntry("yt-mrbeast")!), "youtube:UCX6OQ3DkcsbYNE6H8uQQuVA");
  });

  it("turns a creator's RSS thumbnail into a wide banner", () => {
    const items = parseFeed(raw("catalog/youtube-uploads.xml"), "https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA").items;
    assert.ok(items[0]!.imageUrl, "media:thumbnail is read");
    const wide = youtubeWideThumbnail(items[0]!.imageUrl!);
    assert.match(wide!.hd, /^https:\/\/i\.ytimg\.com\/vi\/[\w-]+\/hq720\.jpg$/);
    assert.match(wide!.fallback, /mqdefault\.jpg$/);
    assert.equal(youtubeWideThumbnail("https://example.com/vi/abcdefghijk/hqdefault.jpg"), null);
  });

  for (const entry of FEED_CATALOG) {
    it(`parses a saved real response for ${entry.key}`, () => {
      assertWellFormed(entry.key, itemsFor(entry.key));
    });
  }
});

describe("adapter specifics", () => {
  it("Steam: always asks for community announcements, flags patch notes", () => {
    assert.match(steamNewsUrl("730"), /feeds=steam_community_announcements/);
    const items = parseSteamNews(json("steam-cs2.json"), "730");
    assert.equal(items[0]!.key, "1849827110421976");
    assert.ok(items.every((i) => typeof i.payload?.patchNotes === "boolean"));
    assert.ok(items.every((i) => i.publishedAt instanceof Date));
    const search = parseSteamSearch(json("steam-search.json"));
    assert.equal(search[0]!.appId, "730");
    assert.equal(search[0]!.name, "Counter-Strike 2");
  });

  it("Rockstar: our own persisted query, ids as keys, absolute links and 16x9 art, first-seen dates", () => {
    assert.match(ROCKSTAR_QUERY_HASH, /^[0-9a-f]{64}$/);
    const url = new URL(rockstarRequestUrl(666, false));
    assert.equal(url.hostname, "graph.rockstargames.com");
    assert.equal(JSON.parse(url.searchParams.get("extensions")!).persistedQuery.sha256Hash, ROCKSTAR_QUERY_HASH);
    assert.equal(JSON.parse(url.searchParams.get("variables")!).tagId, 666);
    assert.equal(url.searchParams.get("query"), null);
    assert.ok(new URL(rockstarRequestUrl(null, true)).searchParams.get("query")?.startsWith("query DreamlinerNewswire"));
    assert.equal(isPersistedQueryMiss({ data: null, errors: [{ message: "PersistedQueryNotFound" }] }), true);
    const items = parseRockstar(json("rockstar-gta6.json"));
    assert.equal(items[0]!.key, "89834o94713o21");
    assert.equal(items[0]!.url, "https://www.rockstargames.com/newswire/article/89834o94713o21/pre-load-grand-theft-auto-vi-now");
    assert.match(items[0]!.imageUrl!, /^https:\/\/media-rockstargames-com\.akamaized\.net\//);
    assert.equal(items[0]!.publishedAt, null);
  });

  it("Riot: one item per incident update, deduped on id + updated time", () => {
    assert.equal(riotStatusUrl("valorant", "eu"), "https://valorant.secure.dyn.riotcdn.net/channels/public/x/status/eu.json");
    const items = parseRiotStatus(json("riot-lol-euw1.json"), "lol", "euw1");
    assert.match(items[0]!.key, /^incident:13865:/);
    assert.equal(items[0]!.title, "TFT is now on Mac!");
  });

  it("Mojang: relative images resolve against launchercontent.mojang.com", () => {
    const java = parseMojang(json("mojang-java.json"), "java");
    assert.equal(java[0]!.imageUrl, "https://launchercontent.mojang.com/v2/images/26.4snapshot10540x540.jpg");
    const news = parseMojang(json("mojang-news.json"), "news");
    assert.match(news[0]!.url, /^https:\/\/www\.minecraft\.net\/article\//);
  });

  it("HoYoverse: banner from sExt, server time (UTC+8) dates, official article links", () => {
    const genshin = parseHoyo(json("hoyo-genshin.json"), "genshin");
    assert.equal(genshin[0]!.url, "https://genshin.hoyoverse.com/en/news/detail/167340");
    assert.equal(genshin[0]!.publishedAt?.toISOString(), "2026-11-16T03:00:00.000Z");
    assert.match(genshin[0]!.imageUrl!, /fastcdn\.hoyoverse\.com/);
    const hsr = parseHoyo(json("hoyo-hsr.json"), "hsr");
    assert.equal(hsr[0]!.url, "https://hsr.hoyoverse.com/en-us/news/167132");
    assert.match(hsr[0]!.imageUrl!, /fastcdn\.hoyoverse\.com/);
  });

  it("Epic: only games free right now, keyed on id + start date", () => {
    const items = parseEpicFree(json("epic-free.json"), NOW);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Knightica");
    assert.match(items[0]!.key, /:2026-11-12T16:00:00\.000Z$/);
    assert.match(items[0]!.url, /^https:\/\/store\.epicgames\.com\/en-US\/p\//);
    assert.equal(parseEpicFree(json("epic-free.json"), new Date("2026-11-20T00:00:00Z")).length, 0, "expired once the offer ends");
  });

  it("Fortnite: MOTD ids are the keys", () => {
    const items = parseFortnite(json("fortnite-br.json"));
    assert.equal(items[0]!.key, "6a6330679a1760b6cbc347a06c6ac757");
  });
});


/** Up, then down for two checks, then up again: the down and the recovery post, nothing else. */
function healthOutage(serviceName: string, siteUrl: string): HealthState {
  const meta = { serviceName, siteUrl, iconUrl: null };
  const t0 = Date.UTC(2026, 10, 18, 20, 0);
  let state = stepHealth(undefined, { healthy: true, stats: null, at: t0 }, meta);
  state = stepHealth(state, { healthy: false, stats: null, at: t0 + 120_000 }, meta);
  state = stepHealth(state, { healthy: false, stats: null, at: t0 + 240_000 }, meta);
  return stepHealth(state, { healthy: true, stats: { servers: 384, users: 76843, latencyMs: 113 }, at: t0 + 600_000 }, meta);
}

describe("health-check status feeds", () => {
  const meta = { serviceName: "Wamoone", siteUrl: "https://wamoone.com/", iconUrl: null };
  const t0 = Date.UTC(2026, 10, 18, 20, 0);

  it("posts when a known-up service goes down and again when it's back, with stats", () => {
    const state = healthOutage("Wamoone", "https://wamoone.com/");
    assert.equal(state.events.length, 2);
    assert.equal(state.events[0]!.title, "Wamoone is having problems");
    assert.match(state.events[0]!.summary, /20:02 UTC/);
    assert.equal(state.events[1]!.title, "Wamoone is back up");
    assert.match(state.events[1]!.summary, /after 8 minutes/);
    assert.match(state.events[1]!.summary, /384 servers, 76,843 users, 113 ms latency/);
    assert.notEqual(state.events[0]!.key, state.events[1]!.key);
  });

  it("ignores a single failed check", () => {
    let state = stepHealth(undefined, { healthy: true, stats: null, at: t0 }, meta);
    state = stepHealth(state, { healthy: false, stats: null, at: t0 + 1 }, meta);
    state = stepHealth(state, { healthy: true, stats: null, at: t0 + 2 }, meta);
    assert.equal(HEALTH_FAILS_FOR_DOWN, 2);
    assert.equal(state.events.length, 0);
  });

  it("treats the first checks after a restart as the baseline, even when failing", () => {
    let state = stepHealth(undefined, { healthy: false, stats: null, at: t0 }, meta);
    state = stepHealth(state, { healthy: false, stats: null, at: t0 + 1 }, meta);
    assert.equal(state.events.length, 0);
    assert.equal(state.healthy, false);
    state = stepHealth(state, { healthy: true, stats: null, at: t0 + 2 }, meta);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.title, "Wamoone is back up");
  });

  it("lists Wamoone as an official health-check status entry", () => {
    const entry = getCatalogEntry("status-wamoone")!;
    assert.equal(entry.official, true);
    assert.equal(entry.adapter, "healthCheck");
    assert.equal(entry.category, "status");
  });
});
