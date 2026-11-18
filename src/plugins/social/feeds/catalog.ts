/**
 * The Discover catalogue: curated, code-defined sources a server can follow in one click. Every
 * entry was fetched live through safeFetch (the Dreamliner-Feeds user agent) before it was added.
 *
 * `official` is true when the publisher or creator runs the feed itself (their RSS, their Steam
 * announcements, their status page, their own YouTube channel). It is false for the two sources
 * Dreamliner reads from somewhere else: the Rockstar Newswire (Rockstar's site API, no public
 * feed) and Fortnite news (the third-party fortnite-api.com mirror of the in-game MOTD).
 *
 * Steam games share the `steam:<appId>` source of the same game picked by search, and YouTube
 * creators the `youtube:<channelId>` source of the same channel pasted by hand.
 */
import type { FeedSourceType } from "./types.js";
import type { AdapterName } from "./adapters/index.js";
import { RIOT_REGIONS } from "./adapters/riot.js";
import { ROCKSTAR_TAGS } from "./adapters/rockstar.js";
import { steamStoreUrl } from "./adapters/steam.js";
import { STEAM_GAMES } from "./catalogSteam.js";
import { YOUTUBE_CREATORS } from "./catalogCreators.js";
import type { CatalogGenre, CatalogPlatform } from "./catalogTags.js";

export const CATALOG_CATEGORIES = [
  { key: "game_updates", name: "Game updates" },
  { key: "creators", name: "Creators" },
  { key: "platform", name: "Console and platform" },
  { key: "status", name: "Service status" },
  { key: "news", name: "Gaming news" },
  { key: "tech", name: "Tech news" },
  { key: "esports", name: "Esports" },
  { key: "anime", name: "Anime" },
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number]["key"];

export type CatalogRegion = { value: string; label: string };

/** Source types a catalogue entry can create. */
export type CatalogEntryType = Extract<FeedSourceType, "newswire" | "steam" | "statuspage" | "youtube">;

export type CatalogEntry = {
  /** Stable id, used in URLs and the source key. */
  key: string;
  name: string;
  /** Who runs it: the publisher, studio or creator group (e.g. "Valve", "Rockstar Newswire", "Tech creators"). */
  group: string | null;
  category: CatalogCategory;
  description: string;
  /** Source type a subscription to this entry creates. */
  type: CatalogEntryType;
  adapter: AdapterName;
  /** Adapter config (merged with the picked region, when the entry has regions). */
  config: Record<string, unknown>;
  /** True when the publisher or creator runs the feed (see the file comment for the exceptions). */
  official: boolean;
  /** Seconds between polls. */
  intervalS: number;
  siteUrl: string;
  /** Square icon for cards and the source icon token. */
  iconUrl: string;
  /** Wide art for Discover cards, when there is one. */
  artUrl: string | null;
  /** Default card accent color. */
  color: number;
  /** App emoji used in Discord output for this source. */
  emoji: string;
  /** Entries that need a region picked (Riot status). The value goes into config.region. */
  regions: CatalogRegion[] | null;
  /** Search keywords besides the name. */
  keywords: string[];
  /** Genre filter tags (games only). */
  genres: CatalogGenre[];
  /** Platform filter tags (games and platform news). */
  platforms: CatalogPlatform[];
  /** Position in Discover's Featured row (1 first), or null. */
  featured: number | null;
};

export const FEED_EMOJIS = {
  youtube: "<:icons_youtube:1544417751022567455>",
  twitch: "<:icons_twitch:1544418152354685138>",
  rss: "<:icons_globe:1544417296703815710>",
  github: "<:icons_github:1544417710463651920>",
  steam: "<:icons_games:1544417547896754247>",
  games: "<:icons_games:1544417547896754247>",
  news: "<:icons_news2:1544417357223690292>",
  platform: "<:icons_news1:1544417356518920322>",
  status: "<:icons_outage:1544417573410701322>",
  update: "<:icons_update:1544417598559752364>",
  announce: "<:icons_announce:1544417473410105378>",
  live: "<:icons_live:1544417331822993408>",
  ended: "<:icons_stop_streaming:1544418214182649886>",
  trophy: "<:icons_trophy:1544418249721126922>",
  people: "<:icons_people:1544417371215626262>",
  play: "<:icons_play:1544417388408217641>",
  pause: "<:icons_pause:1544417366744760380>",
  correct: "<:icons_Correct:1544417199798886530>",
  wrong: "<:icons_Wrong:1544417460638457937>",
  warning: "<:icons_warning:1544418156913885194>",
  link: "<:icons_link:1544417328597434500>",
  clock: "<:icons_clock:1544417185336664114>",
  notify: "<:icons_notify:1544417566708211753>",
  discord: "<:icons_Discord:1544417872976027808>",
  reddit: "<:icons_reddit:1544417739643424908>",
  gift: "<:icons_gift:1544417552627802212>",
  code: "<:icons_code:1544417539482845235>",
  star: "<:icons_star:1544417435636080741>",
} as const;

const CATEGORY_EMOJI: Record<CatalogCategory, string> = {
  game_updates: FEED_EMOJIS.games,
  creators: FEED_EMOJIS.youtube,
  platform: FEED_EMOJIS.platform,
  status: FEED_EMOJIS.status,
  news: FEED_EMOJIS.news,
  tech: FEED_EMOJIS.code,
  esports: FEED_EMOJIS.trophy,
  anime: FEED_EMOJIS.news,
};

/** A site's favicon, for entries without their own art. */
function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

type Optional = "group" | "official" | "artUrl" | "regions" | "keywords" | "iconUrl" | "emoji" | "genres" | "platforms" | "featured";
type EntryInput = Omit<CatalogEntry, Optional> & Partial<Pick<CatalogEntry, Optional>> & { domain?: string };

function entry(input: EntryInput): CatalogEntry {
  const { domain, ...rest } = input;
  return {
    group: null,
    official: true,
    artUrl: null,
    regions: null,
    keywords: [],
    genres: [],
    platforms: [],
    featured: null,
    ...rest,
    iconUrl: input.iconUrl ?? favicon(domain ?? new URL(input.siteUrl).hostname),
    emoji: input.emoji ?? CATEGORY_EMOJI[input.category],
  };
}

function rockstar(key: string, name: string, tagId: number | null, keywords: string[], extra: Partial<EntryInput> = {}): CatalogEntry {
  return entry({
    key,
    name,
    group: "Rockstar Newswire",
    category: "game_updates",
    description: tagId === null ? "Every post on the Rockstar Newswire." : `Rockstar Newswire posts tagged ${name}.`,
    type: "newswire",
    adapter: "rockstar",
    config: { tagId },
    official: false,
    intervalS: 25 * 60,
    siteUrl: "https://www.rockstargames.com/newswire",
    domain: "rockstargames.com",
    color: 0xfcaf17,
    keywords: ["rockstar", "newswire", ...keywords],
    genres: ["action"],
    platforms: ["pc", "playstation", "xbox"],
    ...extra,
  });
}

const steamEntries: CatalogEntry[] = STEAM_GAMES.map((game) =>
  entry({
    key: `steam-${game.key}`,
    name: game.name,
    group: game.publisher,
    category: "game_updates",
    description: `${game.name} announcements and patch notes from Steam.`,
    type: "steam",
    adapter: "steam",
    config: { appId: game.appId },
    intervalS: 20 * 60,
    siteUrl: steamStoreUrl(game.appId),
    iconUrl: game.iconUrl,
    artUrl: game.artUrl,
    color: 0x1b2838,
    emoji: FEED_EMOJIS.steam,
    keywords: ["steam", "patch notes", game.publisher.toLowerCase(), ...game.keywords],
    genres: game.genres,
    platforms: game.platforms,
  }),
);

/** The public uploads feed of a channel: no API key, used for the Discover banner only. */
export function youtubeUploadsFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

const creatorEntries: CatalogEntry[] = YOUTUBE_CREATORS.map((creator) => {
  const official = creator.group === "Official game channels";
  return entry({
    key: `yt-${creator.key}`,
    name: creator.name,
    group: creator.group,
    category: "creators",
    description: official
      ? `Trailers and videos from the official ${creator.name} YouTube channel.`
      : `New uploads from ${creator.name} on YouTube: videos, Shorts and livestreams.`,
    type: "youtube",
    // The feed itself is a normal YouTube source (resolved on add). The rss adapter and the
    // public uploads feed are only used to pick the Discover banner, so no API key is needed.
    adapter: "rss",
    config: { channelId: creator.channelId, url: youtubeUploadsFeedUrl(creator.channelId) },
    intervalS: 5 * 60,
    siteUrl: `https://www.youtube.com/@${creator.handle}`,
    iconUrl: creator.avatar || favicon("youtube.com"),
    color: 0xff0033,
    emoji: FEED_EMOJIS.youtube,
    keywords: ["youtube", "youtuber", creator.handle.toLowerCase(), creator.group.toLowerCase(), ...creator.keywords],
  });
});

type RssInput = Omit<EntryInput, "type" | "adapter" | "config"> & { url: string };

function rss(input: RssInput): CatalogEntry {
  const { url, ...rest } = input;
  return entry({ ...rest, type: rest.category === "status" ? "statuspage" : "newswire", adapter: "rss", config: { url } });
}

const SITE_GROUP: Partial<Record<CatalogCategory, string>> = {
  news: "Gaming news",
  tech: "Tech news",
  esports: "Esports news",
  anime: "Anime news",
};

/** A news site's whole feed. */
function site(
  category: "news" | "tech" | "esports" | "anime",
  key: string,
  name: string,
  url: string,
  siteUrl: string,
  color: number,
  keywords: string[] = [],
  extra: Partial<RssInput> = {},
): CatalogEntry {
  return rss({
    key,
    name,
    group: SITE_GROUP[category] ?? null,
    category,
    description: `The latest from ${name}.`,
    url,
    intervalS: 15 * 60,
    siteUrl,
    color,
    keywords,
    ...extra,
  });
}

/** A status page's incident history (Atlassian Statuspage, incident.io and the like). */
function status(key: string, name: string, group: string, url: string, siteUrl: string, color: number, keywords: string[], extra: Partial<RssInput> = {}): CatalogEntry {
  return rss({
    key,
    name,
    group,
    category: "status",
    description: `${group} incidents and maintenance.`,
    url,
    intervalS: 5 * 60,
    siteUrl,
    color,
    keywords: ["outage", "down", "status", ...keywords],
    ...extra,
  });
}

export const FEED_CATALOG: CatalogEntry[] = [
  // Game updates -----------------------------------------------------------------------------
  rockstar("rockstar-latest", "Rockstar Newswire", ROCKSTAR_TAGS.latest, ["latest"]),
  rockstar("rockstar-gta6", "Grand Theft Auto VI", ROCKSTAR_TAGS.gta6, ["gta 6", "gta vi", "gta6"], { featured: 1, platforms: ["playstation", "xbox"] }),
  rockstar("rockstar-gta-online", "GTA Online", ROCKSTAR_TAGS.gtaOnline, ["gta online", "gtao"]),
  rockstar("rockstar-gta5", "Grand Theft Auto V", ROCKSTAR_TAGS.gta5, ["gta 5", "gta v"]),
  rockstar("rockstar-rdr2", "Red Dead Redemption 2", ROCKSTAR_TAGS.rdr2, ["rdr2", "red dead"]),
  rockstar("rockstar-red-dead-online", "Red Dead Online", ROCKSTAR_TAGS.redDeadOnline, ["rdo", "red dead"]),
  entry({
    key: "minecraft-java",
    name: "Minecraft: Java Edition patch notes",
    group: "Minecraft",
    category: "game_updates",
    description: "Every Java Edition release, snapshot and pre-release, from Mojang's launcher.",
    type: "newswire",
    adapter: "mojang",
    config: { feed: "java" },
    intervalS: 30 * 60,
    siteUrl: "https://www.minecraft.net/",
    domain: "minecraft.net",
    color: 0x62b47a,
    keywords: ["minecraft", "java", "snapshot", "mojang"],
    genres: ["sandbox", "survival"],
    platforms: ["pc"],
    featured: 2,
  }),
  entry({
    key: "minecraft-bedrock",
    name: "Minecraft: Bedrock Edition patch notes",
    group: "Minecraft",
    category: "game_updates",
    description: "Bedrock Edition releases and previews, from Mojang's launcher.",
    type: "newswire",
    adapter: "mojang",
    config: { feed: "bedrock" },
    intervalS: 30 * 60,
    siteUrl: "https://www.minecraft.net/",
    domain: "minecraft.net",
    color: 0x62b47a,
    keywords: ["minecraft", "bedrock", "preview", "mojang"],
    genres: ["sandbox", "survival"],
    platforms: ["pc", "playstation", "xbox", "switch", "mobile"],
  }),
  entry({
    key: "minecraft-news",
    name: "Minecraft news",
    group: "Minecraft",
    category: "game_updates",
    description: "Minecraft news posts, from Mojang's launcher.",
    type: "newswire",
    adapter: "mojang",
    config: { feed: "news" },
    intervalS: 30 * 60,
    siteUrl: "https://www.minecraft.net/",
    domain: "minecraft.net",
    color: 0x62b47a,
    keywords: ["minecraft", "mojang", "dungeons", "legends"],
    genres: ["sandbox", "survival"],
    platforms: ["pc", "playstation", "xbox", "switch", "mobile"],
  }),
  entry({
    key: "fortnite-br",
    name: "Fortnite news",
    group: "Epic Games",
    category: "game_updates",
    description: "Battle Royale news from the in-game message of the day, read through the fortnite-api.com mirror.",
    type: "newswire",
    adapter: "fortnite",
    config: {},
    official: false,
    intervalS: 30 * 60,
    siteUrl: "https://www.fortnite.com/news",
    domain: "fortnite.com",
    color: 0x9d4dbb,
    keywords: ["fortnite", "epic", "battle royale"],
    genres: ["shooter"],
    platforms: ["pc", "playstation", "xbox", "switch", "mobile"],
    featured: 4,
  }),
  entry({
    key: "genshin-impact",
    name: "Genshin Impact news",
    group: "HoYoverse",
    category: "game_updates",
    description: "Official Genshin Impact news, events and updates.",
    type: "newswire",
    adapter: "hoyoverse",
    config: { game: "genshin" },
    intervalS: 30 * 60,
    siteUrl: "https://genshin.hoyoverse.com/en/news",
    domain: "genshin.hoyoverse.com",
    color: 0x4d6fbf,
    keywords: ["genshin", "hoyoverse", "mihoyo", "gacha"],
    genres: ["rpg", "action"],
    platforms: ["pc", "playstation", "mobile"],
  }),
  entry({
    key: "honkai-star-rail",
    name: "Honkai: Star Rail news",
    group: "HoYoverse",
    category: "game_updates",
    description: "Official Honkai: Star Rail news, events and updates.",
    type: "newswire",
    adapter: "hoyoverse",
    config: { game: "hsr" },
    intervalS: 30 * 60,
    siteUrl: "https://hsr.hoyoverse.com/en-us/news",
    domain: "hsr.hoyoverse.com",
    color: 0x6b5bd2,
    keywords: ["honkai", "star rail", "hsr", "hoyoverse", "gacha"],
    genres: ["rpg"],
    platforms: ["pc", "playstation", "mobile"],
  }),
  rss({
    key: "bungie",
    name: "Bungie news (Destiny 2, Marathon)",
    group: "Bungie",
    category: "game_updates",
    description: "Bungie.net news: Destiny 2 and Marathon updates, TWABs and dev posts.",
    url: "https://www.bungie.net/en/rss/News",
    intervalS: 20 * 60,
    siteUrl: "https://www.bungie.net/7/en/News",
    domain: "bungie.net",
    color: 0x2b81d6,
    keywords: ["destiny", "destiny 2", "marathon", "bungie", "twab"],
    genres: ["shooter", "mmo"],
    platforms: ["pc", "playstation", "xbox"],
  }),
  rss({
    key: "roblox-devforum",
    name: "Roblox developer announcements",
    group: "Roblox",
    category: "game_updates",
    description: "Official announcements from the Roblox Developer Forum.",
    url: "https://devforum.roblox.com/c/updates/announcements/36.rss",
    intervalS: 20 * 60,
    siteUrl: "https://devforum.roblox.com/c/updates/announcements/36",
    domain: "roblox.com",
    color: 0x335fff,
    keywords: ["roblox", "devforum", "studio"],
    genres: ["sandbox"],
    platforms: ["pc", "playstation", "xbox", "mobile"],
  }),
  rss({
    key: "hypixel-news",
    name: "Hypixel news",
    group: "Hypixel",
    category: "game_updates",
    description: "News and announcements from the Hypixel Minecraft server: SkyBlock, BedWars and events.",
    url: "https://hypixel.net/forums/news-and-announcements.4/index.rss",
    intervalS: 20 * 60,
    siteUrl: "https://hypixel.net/forums/news-and-announcements.4/",
    domain: "hypixel.net",
    color: 0xf5a623,
    keywords: ["hypixel", "minecraft", "skyblock", "bedwars"],
    genres: ["sandbox"],
    platforms: ["pc"],
  }),
  rss({
    key: "warframe-updates",
    name: "Warframe PC update notes",
    group: "Digital Extremes",
    category: "game_updates",
    description: "Every Warframe update, hotfix and patch note from the official forums.",
    url: "https://forums.warframe.com/forum/3-pc-update-notes.xml/",
    intervalS: 20 * 60,
    siteUrl: "https://forums.warframe.com/forum/3-pc-update-notes/",
    domain: "warframe.com",
    color: 0x9fb4c7,
    keywords: ["warframe", "hotfix", "update notes", "digital extremes"],
    genres: ["shooter", "action", "coop"],
    platforms: ["pc"],
  }),
  rss({
    key: "poe-news",
    name: "Path of Exile news",
    group: "Grinding Gear Games",
    category: "game_updates",
    description: "Path of Exile and Path of Exile 2 announcements, league launches and patch notes.",
    url: "https://www.pathofexile.com/news/rss",
    intervalS: 20 * 60,
    siteUrl: "https://www.pathofexile.com/forum/view-forum/news",
    domain: "pathofexile.com",
    color: 0xaf6025,
    keywords: ["path of exile", "poe", "poe2", "league", "ggg"],
    genres: ["rpg", "action"],
    platforms: ["pc", "playstation", "xbox"],
  }),
  rss({
    key: "osrs-news",
    name: "Old School RuneScape news",
    group: "Jagex",
    category: "game_updates",
    description: "Game updates, events and news for Old School RuneScape.",
    url: "https://secure.runescape.com/m=news/latest_news.rss?oldschool=true",
    intervalS: 20 * 60,
    siteUrl: "https://secure.runescape.com/m=news/archive?oldschool=1",
    domain: "oldschool.runescape.com",
    color: 0xc8a04a,
    keywords: ["osrs", "old school", "runescape", "jagex"],
    genres: ["mmo"],
    platforms: ["pc", "mobile"],
  }),
  rss({
    key: "runescape-news",
    name: "RuneScape news",
    group: "Jagex",
    category: "game_updates",
    description: "Game updates, events and news for RuneScape.",
    url: "https://secure.runescape.com/m=news/latest_news.rss",
    intervalS: 20 * 60,
    siteUrl: "https://secure.runescape.com/m=news/archive",
    domain: "runescape.com",
    color: 0xc8a04a,
    keywords: ["rs3", "runescape", "jagex"],
    genres: ["mmo"],
    platforms: ["pc", "mobile"],
  }),
  rss({
    key: "gw2-news",
    name: "Guild Wars 2 news",
    group: "ArenaNet",
    category: "game_updates",
    description: "Guild Wars 2 releases, events and news from the official site.",
    url: "https://www.guildwars2.com/en/feed/",
    intervalS: 20 * 60,
    siteUrl: "https://www.guildwars2.com/en/news/",
    domain: "guildwars2.com",
    color: 0xc0262d,
    keywords: ["guild wars", "gw2", "arenanet"],
    genres: ["mmo", "rpg"],
    platforms: ["pc"],
  }),
  rss({
    key: "ffxiv-topics",
    name: "FINAL FANTASY XIV topics",
    group: "Square Enix",
    category: "game_updates",
    description: "Lodestone topics: patches, events, live letters and campaigns.",
    url: "https://na.finalfantasyxiv.com/lodestone/news/topics.xml",
    intervalS: 20 * 60,
    siteUrl: "https://na.finalfantasyxiv.com/lodestone/topics/",
    domain: "finalfantasyxiv.com",
    color: 0x5a7fbf,
    keywords: ["ffxiv", "ff14", "final fantasy", "lodestone", "square enix"],
    genres: ["mmo", "rpg"],
    platforms: ["pc", "playstation", "xbox"],
  }),
  rss({
    key: "ffxiv-news",
    name: "FINAL FANTASY XIV notices",
    group: "Square Enix",
    category: "game_updates",
    description: "Lodestone news: maintenance, notices and status updates.",
    url: "https://na.finalfantasyxiv.com/lodestone/news/news.xml",
    intervalS: 20 * 60,
    siteUrl: "https://na.finalfantasyxiv.com/lodestone/news/",
    domain: "finalfantasyxiv.com",
    color: 0x5a7fbf,
    keywords: ["ffxiv", "ff14", "final fantasy", "lodestone", "maintenance"],
    genres: ["mmo", "rpg"],
    platforms: ["pc", "playstation", "xbox"],
  }),
  rss({
    key: "factorio-blog",
    name: "Factorio Friday Facts",
    group: "Wube Software",
    category: "game_updates",
    description: "The Factorio dev blog: Friday Facts and release news.",
    url: "https://www.factorio.com/blog/rss",
    intervalS: 30 * 60,
    siteUrl: "https://www.factorio.com/blog/",
    domain: "factorio.com",
    color: 0xe39827,
    keywords: ["factorio", "fff", "friday facts", "wube"],
    genres: ["strategy", "simulation"],
    platforms: ["pc", "switch"],
  }),
  rss({
    key: "eve-news",
    name: "EVE Online news",
    group: "CCP Games",
    category: "game_updates",
    description: "EVE Online expansions, patch notes and news.",
    url: "https://www.eveonline.com/rss",
    intervalS: 30 * 60,
    siteUrl: "https://www.eveonline.com/news",
    domain: "eveonline.com",
    color: 0x1f6b8e,
    keywords: ["eve", "eve online", "ccp"],
    genres: ["mmo", "strategy"],
    platforms: ["pc"],
  }),
  rss({
    key: "tf2-blog",
    name: "TF2 Official Blog",
    group: "Valve",
    category: "game_updates",
    description: "The Team Fortress 2 blog: updates, comics and community news.",
    url: "https://www.teamfortress.com/rss.xml",
    intervalS: 30 * 60,
    siteUrl: "https://www.teamfortress.com/",
    domain: "teamfortress.com",
    color: 0xb8383b,
    keywords: ["tf2", "team fortress", "valve"],
    genres: ["shooter"],
    platforms: ["pc"],
  }),
  ...steamEntries.map((e) => (e.key === "steam-cs2" ? { ...e, featured: 3 } : e.key === "steam-marvel-rivals" ? { ...e, featured: 7 } : e)),

  // Creators ---------------------------------------------------------------------------------
  ...creatorEntries.map((e) => (e.key === "yt-mrbeast" ? { ...e, featured: 5 } : e)),

  // Console and platform ---------------------------------------------------------------------
  rss({
    key: "playstation-blog",
    name: "PlayStation Blog",
    group: "PlayStation",
    category: "platform",
    description: "Official PlayStation news, State of Play and PS Plus announcements.",
    url: "https://blog.playstation.com/feed/",
    intervalS: 15 * 60,
    siteUrl: "https://blog.playstation.com/",
    domain: "playstation.com",
    color: 0x0070d1,
    keywords: ["playstation", "ps5", "sony", "ps plus"],
    platforms: ["playstation"],
    featured: 6,
  }),
  rss({
    key: "xbox-wire",
    name: "Xbox Wire",
    group: "Xbox",
    category: "platform",
    description: "Official Xbox news, Game Pass and showcase announcements.",
    url: "https://news.xbox.com/en-us/feed/",
    intervalS: 15 * 60,
    siteUrl: "https://news.xbox.com/en-us/",
    domain: "xbox.com",
    color: 0x107c10,
    keywords: ["xbox", "game pass", "microsoft"],
    platforms: ["xbox", "pc"],
  }),
  rss({
    key: "nintendo-uk",
    name: "Nintendo news (UK and Europe)",
    group: "Nintendo",
    category: "platform",
    description: "Official Nintendo news for the UK and Europe.",
    url: "https://www.nintendo.com/en-gb/news.xml",
    intervalS: 20 * 60,
    siteUrl: "https://www.nintendo.com/en-gb/News/News-Nintendo-UK-656025.html",
    domain: "nintendo.com",
    color: 0xe60012,
    keywords: ["nintendo", "switch", "switch 2", "europe"],
    platforms: ["switch"],
  }),
  rss({
    key: "nintendo-jp",
    name: "Nintendo Japan",
    group: "Nintendo",
    category: "platform",
    description: "Nintendo Japan's site updates (in Japanese).",
    url: "https://www.nintendo.co.jp/news/whatsnew.xml",
    intervalS: 30 * 60,
    siteUrl: "https://www.nintendo.co.jp/",
    domain: "nintendo.co.jp",
    color: 0xe60012,
    keywords: ["nintendo", "japan", "switch"],
    platforms: ["switch"],
  }),
  entry({
    key: "epic-free-games",
    name: "Epic Games Store free games",
    group: "Epic Games",
    category: "platform",
    description: "The free games of the week, the moment they go live.",
    type: "newswire",
    adapter: "epicFree",
    config: {},
    intervalS: 60 * 60,
    siteUrl: "https://store.epicgames.com/en-US/free-games",
    domain: "store.epicgames.com",
    color: 0x2a2a2a,
    emoji: FEED_EMOJIS.gift,
    keywords: ["epic", "free games", "egs"],
    platforms: ["pc"],
  }),
  rss({
    key: "steam-news",
    name: "Steam news",
    group: "Valve",
    category: "platform",
    description: "Steam's own announcements: sales, events, client and store news.",
    url: "https://store.steampowered.com/feeds/news.xml",
    intervalS: 20 * 60,
    siteUrl: "https://store.steampowered.com/news/collection/steam",
    domain: "store.steampowered.com",
    color: 0x1b2838,
    emoji: FEED_EMOJIS.steam,
    keywords: ["steam", "valve", "steam sale", "steam client"],
    platforms: ["pc"],
  }),
  rss({
    key: "steam-deck-news",
    name: "Steam Deck news",
    group: "Valve",
    category: "platform",
    description: "Steam Deck and SteamOS announcements and updates.",
    url: "https://store.steampowered.com/feeds/news/app/1675200/",
    intervalS: 30 * 60,
    siteUrl: "https://store.steampowered.com/steamdeck",
    domain: "steamdeck.com",
    color: 0x1a9fff,
    emoji: FEED_EMOJIS.steam,
    keywords: ["steam deck", "steamos", "valve", "handheld"],
    platforms: ["pc"],
  }),
  rss({
    key: "gog-news",
    name: "GOG news",
    group: "GOG",
    category: "platform",
    description: "GOG.com news: releases, sales and giveaways.",
    url: "https://www.gog.com/news/feed",
    intervalS: 30 * 60,
    siteUrl: "https://www.gog.com/news",
    domain: "gog.com",
    color: 0x86328a,
    keywords: ["gog", "cd projekt", "drm free"],
    platforms: ["pc"],
  }),
  rss({
    key: "discord-blog",
    name: "Discord Blog",
    group: "Discord",
    category: "platform",
    description: "Product news and features from the Discord blog.",
    url: "https://discord.com/blog/rss.xml",
    intervalS: 30 * 60,
    siteUrl: "https://discord.com/blog",
    domain: "discord.com",
    color: 0x5865f2,
    emoji: FEED_EMOJIS.discord,
    keywords: ["discord", "nitro", "features"],
  }),
  rss({
    key: "youtube-blog",
    name: "YouTube Official Blog",
    group: "YouTube",
    category: "platform",
    description: "Product and creator news from YouTube.",
    url: "https://blog.youtube/rss/",
    intervalS: 30 * 60,
    siteUrl: "https://blog.youtube/",
    domain: "youtube.com",
    color: 0xff0033,
    emoji: FEED_EMOJIS.youtube,
    keywords: ["youtube", "creators"],
  }),
  rss({
    key: "windows-blog",
    name: "Windows Blog",
    group: "Microsoft",
    category: "platform",
    description: "Windows updates, Insider builds and features.",
    url: "https://blogs.windows.com/feed/",
    intervalS: 30 * 60,
    siteUrl: "https://blogs.windows.com/",
    domain: "windows.com",
    color: 0x0078d4,
    keywords: ["windows", "microsoft", "windows 11", "insider"],
    platforms: ["pc"],
  }),
  rss({
    key: "apple-newsroom",
    name: "Apple Newsroom",
    group: "Apple",
    category: "platform",
    description: "Official Apple announcements and product news.",
    url: "https://www.apple.com/newsroom/rss-feed.rss",
    intervalS: 30 * 60,
    siteUrl: "https://www.apple.com/newsroom/",
    domain: "apple.com",
    color: 0x1d1d1f,
    keywords: ["apple", "iphone", "mac", "ios"],
    platforms: ["mobile"],
  }),
  rss({
    key: "android-blog",
    name: "Android news from Google",
    group: "Google",
    category: "platform",
    description: "Android features and releases from Google's blog.",
    url: "https://blog.google/products/android/rss/",
    intervalS: 30 * 60,
    siteUrl: "https://blog.google/products/android/",
    domain: "android.com",
    color: 0x34a853,
    keywords: ["android", "google", "pixel"],
    platforms: ["mobile"],
  }),
  rss({
    key: "unity-blog",
    name: "Unity Blog",
    group: "Unity",
    category: "platform",
    description: "Engine releases, tutorials and news from Unity.",
    url: "https://unity.com/blog/rss",
    intervalS: 30 * 60,
    siteUrl: "https://unity.com/blog",
    domain: "unity.com",
    color: 0x222c37,
    keywords: ["unity", "game engine", "gamedev"],
  }),
  rss({
    key: "godot-news",
    name: "Godot Engine news",
    group: "Godot",
    category: "platform",
    description: "Releases, dev snapshots and news from the Godot Engine.",
    url: "https://godotengine.org/rss.xml",
    intervalS: 30 * 60,
    siteUrl: "https://godotengine.org/blog/",
    domain: "godotengine.org",
    color: 0x478cbf,
    keywords: ["godot", "game engine", "gamedev", "open source"],
  }),

  // Service status ---------------------------------------------------------------------------
  // Wamoone has no incident feed, only a health check and live stats, so it uses the
  // health-check adapter (posts when it goes down and when it's back).
  entry({
    key: "status-wamoone",
    name: "Wamoone status",
    group: "Wamoone",
    category: "status",
    description: "Alerts when Wamoone, the free Discord levelling bot, goes down and when it's back, with its live server count.",
    type: "statuspage",
    adapter: "healthCheck",
    config: { healthUrl: "https://api.wamoone.com/health", statsUrl: "https://api.wamoone.com/", serviceName: "Wamoone" },
    intervalS: 2 * 60,
    siteUrl: "https://wamoone.com/",
    domain: "wamoone.com",
    artUrl: "https://wamoone.com/wamoone.webp",
    color: 0x7c5cff,
    keywords: ["wamoone", "levelling", "leveling", "xp", "bot", "outage", "down", "status"],
  }),
  status("status-discord", "Discord status", "Discord", "https://discordstatus.com/history.rss", "https://discordstatus.com/", 0x5865f2, ["discord"], {
    domain: "discord.com",
    emoji: FEED_EMOJIS.discord,
    featured: 8,
  }),
  status("status-epic", "Epic Games status", "Epic Games", "https://status.epicgames.com/history.rss", "https://status.epicgames.com/", 0x2a2a2a, ["epic", "fortnite"], {
    domain: "epicgames.com",
    description: "Fortnite, Epic Games Store and Epic Online Services incidents.",
  }),
  status("status-github", "GitHub status", "GitHub", "https://www.githubstatus.com/history.atom", "https://www.githubstatus.com/", 0x24292f, ["github"], {
    domain: "github.com",
    emoji: FEED_EMOJIS.github,
  }),
  status("status-reddit", "Reddit status", "Reddit", "https://www.redditstatus.com/history.rss", "https://www.redditstatus.com/", 0xff4500, ["reddit"], {
    domain: "reddit.com",
    emoji: FEED_EMOJIS.reddit,
  }),
  status("status-roblox", "Roblox status", "Roblox", "https://status.roblox.com/pages/59db90dbcdeb2f04dadcf16d/rss", "https://status.roblox.com/", 0x335fff, ["roblox"], {
    domain: "roblox.com",
    description: "Roblox incidents and scheduled maintenance.",
  }),
  entry({
    key: "status-lol",
    name: "League of Legends status",
    group: "Riot Games",
    category: "status",
    description: "League of Legends incidents and maintenance for one region.",
    type: "statuspage",
    adapter: "riotStatus",
    config: { game: "lol" },
    intervalS: 5 * 60,
    siteUrl: "https://status.riotgames.com/lol",
    domain: "leagueoflegends.com",
    color: 0xc89b3c,
    regions: RIOT_REGIONS.lol,
    keywords: ["league", "lol", "riot", "outage"],
    genres: ["moba"],
    platforms: ["pc"],
  }),
  entry({
    key: "status-valorant",
    name: "VALORANT status",
    group: "Riot Games",
    category: "status",
    description: "VALORANT incidents and maintenance for one region.",
    type: "statuspage",
    adapter: "riotStatus",
    config: { game: "valorant" },
    intervalS: 5 * 60,
    siteUrl: "https://status.riotgames.com/valorant",
    domain: "playvalorant.com",
    color: 0xff4655,
    regions: RIOT_REGIONS.valorant,
    keywords: ["valorant", "riot", "outage"],
    genres: ["shooter"],
    platforms: ["pc", "playstation", "xbox"],
  }),
  status("status-hypixel", "Hypixel status", "Hypixel", "https://status.hypixel.net/history.rss", "https://status.hypixel.net/", 0xf5a623, ["hypixel", "minecraft"], { domain: "hypixel.net" }),
  status("status-twitch", "Twitch status", "Twitch", "https://status.twitch.com/history.rss", "https://status.twitch.com/", 0x9146ff, ["twitch", "streaming"], { domain: "twitch.tv" }),
  status("status-cloudflare", "Cloudflare status", "Cloudflare", "https://www.cloudflarestatus.com/history.rss", "https://www.cloudflarestatus.com/", 0xf38020, ["cloudflare", "cdn", "dns"], {
    domain: "cloudflare.com",
  }),
  status("status-openai", "OpenAI status", "OpenAI", "https://status.openai.com/history.rss", "https://status.openai.com/", 0x10a37f, ["openai", "chatgpt", "ai"], { domain: "openai.com" }),
  status("status-claude", "Claude status", "Anthropic", "https://status.claude.com/history.rss", "https://status.claude.com/", 0xd97757, ["claude", "anthropic", "ai"], {
    domain: "claude.ai",
    description: "Claude and Anthropic API incidents and maintenance.",
  }),
  status("status-spotify", "Spotify status", "Spotify", "https://spotify.statuspage.io/history.rss", "https://spotify.statuspage.io/", 0x1db954, ["spotify", "music"], {
    domain: "spotify.com",
    description: "Spotify incidents posted to its status page (it is quiet most of the time).",
  }),
  status("status-zoom", "Zoom status", "Zoom", "https://www.zoomstatus.com/history.rss", "https://www.zoomstatus.com/", 0x0b5cff, ["zoom", "meetings"], { domain: "zoom.us" }),
  status("status-slack", "Slack status", "Slack", "https://slack-status.com/feed/rss", "https://slack-status.com/", 0x4a154b, ["slack", "chat"], { domain: "slack.com" }),
  status("status-atlassian", "Atlassian status", "Atlassian", "https://status.atlassian.com/history.rss", "https://status.atlassian.com/", 0x0052cc, ["atlassian", "jira", "confluence"], {
    domain: "atlassian.com",
  }),
  status("status-dropbox", "Dropbox status", "Dropbox", "https://status.dropbox.com/history.rss", "https://status.dropbox.com/", 0x0061ff, ["dropbox", "storage"], { domain: "dropbox.com" }),
  status("status-figma", "Figma status", "Figma", "https://status.figma.com/history.rss", "https://status.figma.com/", 0xa259ff, ["figma", "design"], { domain: "figma.com" }),
  status("status-vercel", "Vercel status", "Vercel", "https://www.vercel-status.com/history.rss", "https://www.vercel-status.com/", 0x111111, ["vercel", "hosting"], { domain: "vercel.com" }),
  status("status-netlify", "Netlify status", "Netlify", "https://www.netlifystatus.com/history.rss", "https://www.netlifystatus.com/", 0x00ad9f, ["netlify", "hosting"], { domain: "netlify.com" }),
  status("status-digitalocean", "DigitalOcean status", "DigitalOcean", "https://status.digitalocean.com/history.rss", "https://status.digitalocean.com/", 0x0080ff, ["digitalocean", "hosting", "cloud"], {
    domain: "digitalocean.com",
  }),
  status("status-supabase", "Supabase status", "Supabase", "https://status.supabase.com/history.rss", "https://status.supabase.com/", 0x3ecf8e, ["supabase", "database"], { domain: "supabase.com" }),
  status("status-unity", "Unity status", "Unity", "https://status.unity.com/history.rss", "https://status.unity.com/", 0x222c37, ["unity", "gamedev"], { domain: "unity.com" }),
  status("status-aws", "AWS status", "Amazon Web Services", "https://status.aws.amazon.com/rss/all.rss", "https://health.aws.amazon.com/health/status", 0xff9900, ["aws", "amazon", "cloud"], {
    domain: "aws.amazon.com",
  }),

  // Gaming news ------------------------------------------------------------------------------
  site("news", "news-ign", "IGN", "https://feeds.feedburner.com/ign/games-all", "https://www.ign.com/", 0xbf1313),
  site("news", "news-pcgamer", "PC Gamer", "https://www.pcgamer.com/rss/", "https://www.pcgamer.com/", 0xc4161c, ["pc"]),
  site("news", "news-verge-games", "The Verge (Games)", "https://www.theverge.com/rss/games/index.xml", "https://www.theverge.com/games", 0x5200ff),
  site("news", "news-gamespot", "GameSpot", "https://www.gamespot.com/feeds/news/", "https://www.gamespot.com/", 0xfbd000),
  site("news", "news-eurogamer", "Eurogamer", "https://www.eurogamer.net/feed", "https://www.eurogamer.net/", 0x0f5ba7),
  site("news", "news-rps", "Rock Paper Shotgun", "https://www.rockpapershotgun.com/feed", "https://www.rockpapershotgun.com/", 0xe2231a, ["pc", "rps"]),
  site("news", "news-polygon", "Polygon", "https://www.polygon.com/feed/", "https://www.polygon.com/", 0xff0090),
  site("news", "news-kotaku", "Kotaku", "https://kotaku.com/feed", "https://kotaku.com/", 0x0b9a49),
  site("news", "news-vgc", "Video Games Chronicle", "https://www.videogameschronicle.com/feed/", "https://www.videogameschronicle.com/", 0xe4002b, ["vgc"]),
  site("news", "news-gamesindustry", "GamesIndustry.biz", "https://www.gamesindustry.biz/feed", "https://www.gamesindustry.biz/", 0x1d4f91, ["industry", "business"]),
  site("news", "news-nintendolife", "Nintendo Life", "https://www.nintendolife.com/feeds/latest", "https://www.nintendolife.com/", 0xe60012, ["nintendo", "switch"], {
    platforms: ["switch"],
  }),
  site("news", "news-gematsu", "Gematsu", "https://www.gematsu.com/feed", "https://www.gematsu.com/", 0x222222, ["japan", "jrpg"]),
  site("news", "news-destructoid", "Destructoid", "https://www.destructoid.com/feed/", "https://www.destructoid.com/", 0xd71b1b),
  site("news", "news-gameinformer", "Game Informer", "https://gameinformer.com/rss.xml", "https://gameinformer.com/", 0xe11d27),
  site("news", "news-gamesradar", "GamesRadar+", "https://www.gamesradar.com/feeds.xml", "https://www.gamesradar.com/", 0xd01f2f),
  site("news", "news-pushsquare", "Push Square", "https://www.pushsquare.com/feeds/latest", "https://www.pushsquare.com/", 0x0070d1, ["playstation", "ps5"], {
    platforms: ["playstation"],
  }),
  site("news", "news-purexbox", "Pure Xbox", "https://www.purexbox.com/feeds/latest", "https://www.purexbox.com/", 0x107c10, ["xbox", "game pass"], {
    platforms: ["xbox"],
  }),
  site("news", "news-siliconera", "Siliconera", "https://www.siliconera.com/feed/", "https://www.siliconera.com/", 0x1f6fb2, ["japan", "anime games"]),
  site("news", "news-shacknews", "Shacknews", "https://www.shacknews.com/feed/rss", "https://www.shacknews.com/", 0x2d72d9),
  site("news", "news-insidergaming", "Insider Gaming", "https://insider-gaming.com/feed/", "https://insider-gaming.com/", 0xff3b30, ["leaks", "rumors"]),
  site("news", "news-pcgamesn", "PCGamesN", "https://www.pcgamesn.com/mainrss.xml", "https://www.pcgamesn.com/", 0xf05a28, ["pc"], { platforms: ["pc"] }),
  site("news", "news-pocketgamer", "Pocket Gamer", "https://www.pocketgamer.com/news/index.rss", "https://www.pocketgamer.com/", 0x00a0e3, ["mobile", "ios", "android"], {
    platforms: ["mobile"],
  }),
  site("news", "news-gamingonlinux", "GamingOnLinux", "https://www.gamingonlinux.com/article_rss.php", "https://www.gamingonlinux.com/", 0x3a3a3a, ["linux", "steam deck", "proton"], {
    platforms: ["pc"],
  }),
  site("news", "news-gamedeveloper", "Game Developer", "https://www.gamedeveloper.com/rss.xml", "https://www.gamedeveloper.com/", 0x0e76bc, ["gamedev", "industry"]),

  // Tech news --------------------------------------------------------------------------------
  site("tech", "tech-verge", "The Verge", "https://www.theverge.com/rss/index.xml", "https://www.theverge.com/", 0x5200ff),
  site("tech", "tech-ars", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/index", "https://arstechnica.com/", 0xff4e00, ["ars"]),
  site("tech", "tech-techcrunch", "TechCrunch", "https://techcrunch.com/feed/", "https://techcrunch.com/", 0x0a9e01, ["startups"]),
  site("tech", "tech-engadget", "Engadget", "https://www.engadget.com/rss.xml", "https://www.engadget.com/", 0x6b2fd8),
  site("tech", "tech-tomshardware", "Tom's Hardware", "https://www.tomshardware.com/feeds.xml", "https://www.tomshardware.com/", 0x1f1f1f, ["hardware", "pc", "gpu"]),
  site("tech", "tech-digitalfoundry", "Digital Foundry", "https://www.digitalfoundry.net/feeds/latest", "https://www.digitalfoundry.net/", 0x1b75bb, ["df", "performance", "hardware"]),
  site("tech", "tech-wired", "WIRED", "https://www.wired.com/feed/rss", "https://www.wired.com/", 0x000000),
  site("tech", "tech-9to5mac", "9to5Mac", "https://9to5mac.com/feed/", "https://9to5mac.com/", 0x1d9bf0, ["apple", "iphone", "mac"]),
  site("tech", "tech-9to5google", "9to5Google", "https://9to5google.com/feed/", "https://9to5google.com/", 0x34a853, ["google", "android", "pixel"]),
  site("tech", "tech-macrumors", "MacRumors", "https://feeds.macrumors.com/MacRumors-All", "https://www.macrumors.com/", 0x2d7ae5, ["apple", "iphone", "mac"]),
  site("tech", "tech-xda", "XDA", "https://www.xda-developers.com/feed/", "https://www.xda-developers.com/", 0xf59714, ["android", "windows"]),
  site("tech", "tech-windowscentral", "Windows Central", "https://www.windowscentral.com/feeds.xml", "https://www.windowscentral.com/", 0x0078d4, ["windows", "xbox", "microsoft"]),
  site("tech", "tech-techradar", "TechRadar", "https://www.techradar.com/feeds.xml", "https://www.techradar.com/", 0x0b4fa1),
  site("tech", "tech-hackernews", "Hacker News", "https://news.ycombinator.com/rss", "https://news.ycombinator.com/", 0xff6600, ["hn", "ycombinator", "programming"], {
    description: "The Hacker News front page.",
  }),
  rss({
    key: "tech-openai",
    name: "OpenAI News",
    group: "OpenAI",
    category: "tech",
    description: "Official announcements, research and product news from OpenAI.",
    url: "https://openai.com/news/rss.xml",
    intervalS: 30 * 60,
    siteUrl: "https://openai.com/news/",
    domain: "openai.com",
    color: 0x10a37f,
    keywords: ["openai", "chatgpt", "ai"],
  }),
  rss({
    key: "tech-nvidia",
    name: "NVIDIA Blog",
    group: "NVIDIA",
    category: "tech",
    description: "Official news from NVIDIA: GeForce, AI and hardware.",
    url: "https://feeds.feedburner.com/nvidiablog",
    intervalS: 30 * 60,
    siteUrl: "https://blogs.nvidia.com/",
    domain: "nvidia.com",
    color: 0x76b900,
    keywords: ["nvidia", "geforce", "gpu", "ai"],
  }),
  rss({
    key: "tech-google",
    name: "News from Google",
    group: "Google",
    category: "tech",
    description: "Official product news from Google's blog.",
    url: "https://blog.google/rss/",
    intervalS: 30 * 60,
    siteUrl: "https://blog.google/",
    domain: "google.com",
    color: 0x4285f4,
    keywords: ["google", "gemini", "search"],
  }),

  // Esports ----------------------------------------------------------------------------------
  site("esports", "esports-hltv", "HLTV", "https://www.hltv.org/rss/news", "https://www.hltv.org/", 0x2d3844, ["cs2", "counter strike", "majors"], {
    description: "Counter-Strike esports news from HLTV.org.",
    genres: ["shooter"],
  }),
  site("esports", "esports-vlr", "VLR.gg", "https://www.vlr.gg/rss", "https://www.vlr.gg/", 0xff4655, ["valorant", "vct"], {
    description: "VALORANT esports news from VLR.gg.",
    genres: ["shooter"],
  }),
  site("esports", "esports-dexerto", "Dexerto", "https://www.dexerto.com/feed/", "https://www.dexerto.com/", 0x3c2de0, ["streamers", "esports"]),
  site("esports", "esports-insider", "Esports Insider", "https://esportsinsider.com/feed", "https://esportsinsider.com/", 0x00c2a8, ["esports business", "tournaments"]),

  // Anime ------------------------------------------------------------------------------------
  site("anime", "anime-ann", "Anime News Network", "https://www.animenewsnetwork.com/all/rss.xml?ann-edition=w", "https://www.animenewsnetwork.com/", 0x2a5aa8, ["anime", "manga", "ann"]),
  site("anime", "anime-crunchyroll", "Crunchyroll News", "https://cr-news-api-service.prd.crunchyrollsvc.com/v1/en-US/rss", "https://www.crunchyroll.com/news", 0xf47521, ["anime", "crunchyroll", "simulcast"], {
    domain: "crunchyroll.com",
  }),
  site("anime", "anime-mal", "MyAnimeList news", "https://myanimelist.net/rss/news.xml", "https://myanimelist.net/news", 0x2e51a2, ["anime", "manga", "mal"]),
  site("anime", "anime-corner", "Anime Corner", "https://animecorner.me/feed/", "https://animecorner.me/", 0xe8336b, ["anime", "rankings"]),
];

const BY_KEY = new Map(FEED_CATALOG.map((e) => [e.key, e]));

export function getCatalogEntry(key: string): CatalogEntry | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The feed_sources key a catalogue entry (and region) maps to. Steam games and YouTube creators
 * share the key of the same game or channel picked by hand.
 */
export function catalogSourceKey(entry: CatalogEntry, region?: string | null): string {
  if (entry.type === "steam") return `steam:${String(entry.config.appId)}`;
  if (entry.type === "youtube") return `youtube:${String(entry.config.channelId)}`;
  return region ? `${entry.type}:${entry.key}:${region}` : `${entry.type}:${entry.key}`;
}

/** Display name with the region label, e.g. "VALORANT status (Europe)". */
export function catalogDisplayName(entry: CatalogEntry, region?: string | null): string {
  const label = region ? entry.regions?.find((r) => r.value === region)?.label : null;
  return label ? `${entry.name} (${label})` : entry.name;
}
