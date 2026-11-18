# Notifications (feeds) bridge contract

The bot side of Notifications 2.0. One feeds engine covers YouTube, Twitch, RSS/Atom, Steam, GitHub
releases, status pages and the curated newswire catalogue. The website talks to it only through the
routes below (implemented in `src/bridge/feeds.ts`, routed in `src/bridge/dashboardBridge.ts`).

These routes **replace** every `/bridge/guilds/:id/social/*` route (`resolve`, `watchers`,
`watchers/:id`, `watchers/:id/test`, `showcase`, `search`). Those now 404.

| Old route | New route |
|---|---|
| `GET  /social/watchers` | `GET  /feeds` |
| `POST /social/watchers` | `POST /feeds` |
| `PATCH/DELETE /social/watchers/:id?platform=` | `PATCH/DELETE /feeds/:id` (no `platform`) |
| `POST /social/watchers/:id/test` | `POST /feeds/:id/test` |
| `POST /social/resolve` | `POST /feeds/preview` (validates and resolves any source) |
| `GET  /social/search?platform=twitch` | `GET  /feeds/search?type=twitch|youtube|steam` |
| `GET  /social/showcase` | removed (use `GET /feeds` + `GET /feeds/:id/items`) |

## Conventions

- Every request carries the bridge `Authorization: Bearer <DASHBOARD_BRIDGE_SECRET>` header.
- `userId` (the signed-in Discord user) is a query parameter on `GET`/`DELETE`, and a body field on
  `POST`/`PATCH`.
- All bodies and responses are JSON. Times are ISO 8601 strings. Colors are decimal integers.
- **Auth** (every `/bridge/guilds/:id/feeds*` route): the user must have Manage Server (or
  Administrator, or be the owner or a platform superuser) **or** be granted the Notifications
  plugin's `can_manage` permission.
- **Rate limits**: the bridge's per-user buckets apply (reads: `GET` and `POST /feeds/preview`;
  writes: create/update/delete/bulk; `POST /feeds/:id/test` uses the small "send" bucket). On top of
  that, previews are capped at 30/min and searches at 90/min per user (`429`, code `rate_limited`).
- The feed cap comes from the bot: `maxFeeds` in `GET /feeds` (10 free, 50 with Dreamliner One),
  shared by every feed type. Don't hard-code it.

### Errors

Every error response is:

```ts
type FeedsError = { error: string; code: FeedsErrorCode };

type FeedsErrorCode =
  | "bad_request"     // 400: invalid body/query, unknown channel/role, invalid message/filters/options
  | "forbidden"       // 403: not allowed to manage feeds in this server
  | "limit_reached"   // 403: the server is at maxFeeds
  | "not_found"       // 404: no such feed in this server (or unknown catalogue key)
  | "duplicate"       // 409: this source already posts in that channel
  | "source_invalid"  // 422: the source doesn't exist / isn't a feed / is private (message says why)
  | "rate_limited"    // 429
  | "upstream_failed" // 502: YouTube/Twitch/Steam lookup failed, try again
  | "send_failed";    // 502: test send couldn't post in the channel (permissions)
```

`error` is a human-readable sentence (no em dashes) that can be shown as-is.

## Shared types

```ts
type FeedSourceType = "youtube" | "twitch" | "rss" | "steam" | "github" | "statuspage" | "newswire";

/** What the site sends to pick a source (create and preview). */
type FeedSourceSpec =
  | { catalogKey: string; region?: string }            // any catalogue entry (creators resolve to their YouTube source)
  | { type: "youtube"; input: string }                  // handle, channel URL, channel id or a video link
  | { type: "twitch"; input: string }                   // login, @handle or channel URL
  | { type: "rss"; url: string }                        // any RSS/Atom/RDF URL; a web page with a feed link also works
  | { type: "steam"; appId: string }                    // app id, or a store.steampowered.com/app/<id> link
  | { type: "github"; repo: string }                    // "owner/repo" or a github.com repo URL
  | { type: "statuspage"; url: string };                // any Atlassian Statuspage domain or its history.rss URL

/** The message design (one per feed). */
type FeedMessage = {
  /** Text above the card. Tokens allowed; {roles} places the pings (else they're prepended). Max 2000. */
  content: string;
  embed: FeedCard;
  /** Link buttons (max 5). Label max 80, url max 512, tokens allowed (e.g. "{url}"). */
  buttons: { label: string; url: string }[];
};

/**
 * The optional card. enabled=true posts a Components V2 message (text, then a container with the
 * card, its image and the buttons). enabled=false posts the text as a plain message so Discord's
 * own link preview (YouTube player, Twitch stream) shows; buttons still show.
 * Icon sources: "channel" = the source's icon, "video" = the item's image, "url" = the *_url field.
 */
type FeedCard = {
  enabled: boolean;
  title: string;          // max 256, tokens
  title_url: string;      // max 512, tokens, http(s) only (anything else is dropped)
  description: string;    // max 4096, tokens (the whole V2 message is trimmed to Discord's 4000 chars)
  color: number;          // accent, 0..16777215
  author_name: string;    // small line above the title, tokens
  author_url: string;
  author_icon: "none" | "channel" | "url";   // kept for older messages
  author_icon_url: string;
  thumbnail: "none" | "channel" | "video" | "url";
  thumbnail_url: string;
  image: "none" | "video" | "url";
  image_url: string;
  footer_text: string;    // max 2048, tokens
  footer_icon: "none" | "channel" | "url";   // unused in V2 cards, kept for older messages
  footer_icon_url: string;
  timestamp: boolean;     // appends the item's publish time to the footer
  fields: { name: string; value: string; inline: boolean }[]; // max 25
};

type FeedFilters = {
  include_keywords: string[];   // post only when title/summary contains one of these (max 25, case-insensitive)
  exclude_keywords: string[];   // never post when title/summary contains any
  categories: string[];         // post only items tagged with one of these (empty = any)
  steam_patch_notes_only: boolean; // Steam: only announcements tagged patch notes
  youtube_videos: boolean;      // YouTube upload types
  youtube_shorts: boolean;
  youtube_live: boolean;
};

type FeedOptions = {
  short_override: { custom: boolean; message: string; role_ids: string[] }; // YouTube Shorts own message/pings
  live_override: { custom: boolean; message: string; role_ids: string[] };  // YouTube livestreams
  end_action: "none" | "edit" | "summary" | "delete"; // Twitch: what happens to the live message when it ends
  live_updates: boolean;        // Twitch: keep the title/category current while live
  cooldown_minutes: number;     // 0..720. Twitch: a restart within N min reuses the message. Others: posts within N min of the last one don't ping.
  quiet_enabled: boolean;       // quiet hours: post silently, no pings
  quiet_start: number;          // 0..23
  quiet_end: number;            // 0..23 (wraps past midnight when start > end)
  quiet_timezone: string;       // IANA zone, e.g. "Europe/London"
  milestones: boolean;          // YouTube only: subscriber milestone cards
  milestone_last: number;       // read-only, the bot's bookkeeping (-1 = not seeded)
};

type FeedSubscriptionStats = {
  delivered30d: number;
  deliveredAll: number;
  daily: number[];              // 30 entries, oldest first, the last one is the last 24h
  lastPostedAt: string | null;
  failed30d: number;            // sends that gave up in the last 30 days
};

type BridgeFeedStatus = "ok" | "pending" | "failing" | "disabled" | "paused";
//  pending:  never fetched successfully yet
//  failing:  the last check(s) failed, it keeps retrying with backoff (source.lastError says why)
//  disabled: paused automatically after 10 failed checks (source.disabledReason); PATCH { retry: true } to try again
//  paused:   turned off by the server

type BridgeFeedSource = {
  id: number;
  type: FeedSourceType;
  key: string;                  // unique upstream key, e.g. "youtube:UC...", "steam:730", "newswire:rockstar-gta6"
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  catalogKey: string | null;    // set for catalogue sources
  region: string | null;        // Riot status region
  official: boolean;            // verified flag: false for the Rockstar Newswire and Fortnite news (see the catalogue)
  details: {
    url?: string;               // rss / statuspage / catalogue RSS feed URL
    appId?: string;             // steam
    owner?: string; repo?: string; // github
    channelId?: string; handle?: string | null; // youtube
    userId?: string; login?: string;            // twitch
  };
  intervalS: number;            // seconds between checks
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  nextCheckAt: string;
  failCount: number;
  lastError: string | null;
  disabledReason: string | null;
};

type BridgeFeed = {
  id: number;
  guildId: string;
  enabled: boolean;
  status: BridgeFeedStatus;
  channelId: string;
  mentionRoleIds: string[];
  message: FeedMessage;
  filters: FeedFilters;
  options: FeedOptions;
  deliveredCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  source: BridgeFeedSource;
  stats: FeedSubscriptionStats;
};
```

### Tokens

Every text field of the message (content, card text, field names/values, button labels and URLs)
can use `{token}`s. Unknown tokens are left as typed.

- Generic (every feed): `{title}`, `{url}`, `{summary}`, `{image}`, `{source}`, `{source_url}`,
  `{source_icon}`, `{published}` (Discord relative time), `{author}`, `{tags}`, `{roles}`.
- YouTube aliases: `{video_title}`, `{video_url}`, `{video_thumbnail}`, `{video_id}`, `{published_at}`,
  `{upload_type}` (video, Short, livestream, upcoming stream), `{channel_name}`, `{channel_handle}`,
  `{channel_url}`, `{channel_avatar}`.
- Twitch aliases: `{stream_title}`, `{stream_url}`, `{stream_thumbnail}`, `{game_name}`,
  `{viewer_count}`, `{started_at}`, `{streamer_name}`, `{streamer_handle}`, `{streamer_url}`,
  `{streamer_avatar}`.

Item titles and summaries arrive already escaped for Discord markdown (`\*`, `\_`...); strip the
backslashes when rendering a web preview.

## Routes

### `GET /bridge/feeds/catalog`

Not per server (no `userId`). Cache it on the site.

```ts
type CatalogCategoryKey = "game_updates" | "creators" | "platform" | "status" | "news" | "tech" | "esports" | "anime";

type CatalogResponse = {
  ok: true;
  categories: { key: CatalogCategoryKey; name: string }[]; // display order
  entries: BridgeCatalogEntry[];
  /** Filter vocabularies for the genre and platform chips (labels to show). */
  filters: {
    genres: { key: string; name: string }[];    // shooter, moba, mmo, rpg, action, survival, sandbox, strategy, simulation, sports, racing, fighting, horror, coop, party, card, indie
    platforms: { key: string; name: string }[]; // pc, playstation, xbox, switch, mobile
  };
  tokens: { generic: string[]; youtube: string[]; twitch: string[] };
  /** The default message the bot uses for a new feed of each type (when the create body has no `message`). */
  defaults: Record<FeedSourceType, FeedMessage>;
  limits: { free: number; one: number };
};

type BridgeCatalogEntry = {
  key: string;            // pass as { catalogKey: key } (plus region when regions is set)
  name: string;
  group: string | null;   // who runs it: a publisher ("Valve", "Rockstar Games", "Rockstar Newswire"), a vendor
                          // ("Cloudflare"), a creator group ("Gaming creators", "Official game channels") or a
                          // news group ("Gaming news", "Tech news", "Esports news", "Anime news")
  category: CatalogCategoryKey;
  description: string;
  type: "newswire" | "steam" | "statuspage" | "youtube";
  /**
   * The verified flag. true: the publisher or creator runs the feed (their RSS, their Steam
   * announcements, their status page, their own YouTube channel). false: Dreamliner reads it from
   * a public but unofficial place that may change without notice. Only the Rockstar Newswire
   * entries (Rockstar's site API) and `fortnite-br` (the third-party fortnite-api.com mirror) are false.
   */
  official: boolean;
  intervalS: number;
  siteUrl: string;        // creators: https://www.youtube.com/@handle
  iconUrl: string;        // square icon: Steam community icon or library capsule, channel avatar, else a favicon
  artUrl: string | null;  // wide art (Steam header images)
  bannerUrl: string | null; // Discover banner: artUrl, else the newest post's image (creators: latest video
                            // thumbnail, read from the public uploads feed); refreshed every 6h; null for status pages
  color: number;          // default card accent
  regions: { value: string; label: string }[] | null; // pick one (Riot status)
  keywords: string[];     // extra search terms
  genres: string[];       // keys from filters.genres (games only, may be empty)
  platforms: string[];    // keys from filters.platforms (games and platform news, may be empty)
  featured: number | null; // position in the Featured row (1 first), null when not featured
  sourceKey: string | null; // the source key adding it creates (compare with a feed's source.key to show
                            // "Added"); null for entries that need a region
};
```

`official` is the same flag as `BridgeFeedSource.official` and `FeedPreview.official`. Show it as a
verified badge: official = verified source, not official = unofficial source.

Catalogue (about 260 entries, every one fetched live through `safeFetch` before it was added; the
bot test keeps a saved response or a checked id for each):

- Game updates: the Rockstar Newswire tags (`rockstar-latest`, `rockstar-gta6`, `rockstar-gta-online`,
  `rockstar-gta5`, `rockstar-rdr2`, `rockstar-red-dead-online`, all unofficial), Mojang
  (`minecraft-java`, `minecraft-bedrock`, `minecraft-news`), `fortnite-br` (unofficial),
  `genshin-impact`, `honkai-star-rail`, `bungie`, `roblox-devforum`, official studio feeds
  (`hypixel-news`, `warframe-updates`, `poe-news`, `osrs-news`, `runescape-news`, `gw2-news`,
  `ffxiv-topics`, `ffxiv-news`, `factorio-blog`, `eve-news`, `tf2-blog`) and 81 Steam games as
  `steam-<slug>` (`steam-cs2`, `steam-rust`, `steam-marvel-rivals`...).
- Creators: 70 YouTube channels as `yt-<handle>` (`yt-mrbeast`, `yt-markiplier`, `yt-mkbhd`...),
  including official game channels (`yt-playstation`, `yt-fortnite`...).
- Console and platform: `playstation-blog`, `xbox-wire`, `nintendo-uk`, `nintendo-jp`,
  `epic-free-games`, `steam-news`, `steam-deck-news`, `gog-news`, `discord-blog`, `youtube-blog`,
  `windows-blog`, `apple-newsroom`, `android-blog`, `unity-blog`, `godot-news`.
- Service status: `status-discord`, `status-epic`, `status-github`, `status-reddit`,
  `status-roblox`, `status-lol` and `status-valorant` (regions), `status-hypixel`, `status-twitch`,
  `status-cloudflare`, `status-openai`, `status-claude`, `status-spotify`, `status-zoom`,
  `status-slack`, `status-atlassian`, `status-dropbox`, `status-figma`, `status-vercel`,
  `status-netlify`, `status-digitalocean`, `status-supabase`, `status-unity`, `status-aws`.
- Gaming news: `news-*` (IGN, PC Gamer, GameSpot, Eurogamer, Polygon, Kotaku, Game Informer,
  GamesRadar+, Push Square, Pure Xbox, Nintendo Life and more).
- Tech news: `tech-*` (The Verge, Ars Technica, TechCrunch, Engadget, Tom's Hardware, Digital
  Foundry, WIRED, Hacker News, OpenAI, NVIDIA, Google and more).
- Esports: `esports-hltv`, `esports-vlr`, `esports-dexerto`, `esports-insider`.
- Anime: `anime-ann`, `anime-crunchyroll`, `anime-mal`, `anime-corner`.

Steam games share the source of the same app picked by search (`steam:<appId>`). Creators are not
catalogue sources: `{ catalogKey: "yt-..." }` resolves to the normal `youtube:<channelId>` source
(exactly like `{ type: "youtube", input: "<channelId>" }`), so it needs the YouTube API key like any
YouTube feed (`platforms.youtube` in `GET /feeds`), and `source.catalogKey` is null on the result.
Use `sourceKey` to tell whether a server already follows an entry.

### `GET /bridge/guilds/:id/feeds?userId=`

```ts
type FeedsListResponse = {
  ok: true;
  guild: { id: string; name: string; icon: string | null };
  feeds: BridgeFeed[];          // ordered by creation
  count: number;
  maxFeeds: number;             // the cap for this server right now
  oneActive: boolean;
  totals: { feeds: number; delivered30d: number; deliveredAll: number; daily: number[] };
  /** Feed ids with status "failing" or "disabled" (Overview "needs attention"). */
  attention: number[];
  /** The 10 newest posts across the server. */
  recent: {
    id: number;
    feedId: number;
    sourceTitle: string;
    sourceType: FeedSourceType;
    sourceIconUrl: string | null;
    channelId: string;
    title: string;
    url: string;
    imageUrl: string | null;
    messageUrl: string | null;
    createdAt: string;
  }[];
  /** Whether the bot has API keys for the creator platforms (hide the option when false). */
  platforms: { youtube: boolean; twitch: boolean; twitchMilestones: false };
};
```

### `POST /bridge/guilds/:id/feeds`

```ts
type CreateFeedBody = {
  userId: string;
  source: FeedSourceSpec;
  channelId: string;            // must be a channel in this server
  mentionRoleIds?: string[];    // max 10, roles in this server
  message?: {                   // merged over the type's default message (see catalog.defaults)
    content?: string;
    embed?: Partial<FeedCard>;
    buttons?: { label: string; url: string }[];
  };
  filters?: Partial<FeedFilters>;
  options?: Partial<Omit<FeedOptions, "milestone_last">>;
  enabled?: boolean;            // default true
  postLatest?: boolean;         // also post the source's newest item right now (not Twitch)
};

type CreateFeedResponse = {
  ok: true;
  feed: BridgeFeed;
  /** Set when the first fetch failed: the feed exists and keeps retrying (status "pending"/"failing"). */
  seedError: string | null;
  postedLatest: boolean;
};
```

Errors: `bad_request`, `limit_reached`, `duplicate` (same source already posts in that channel),
`source_invalid`, `upstream_failed`, `not_found` (unknown catalogue key). Following a source never
posts what's already there: its current items become the starting point. `postLatest` opts into
posting the newest one immediately.

### `GET /bridge/guilds/:id/feeds/:feedId?userId=`

`{ ok: true; feed: BridgeFeed }`. `not_found` for a feed of another server.

### `PATCH /bridge/guilds/:id/feeds/:feedId`

```ts
type UpdateFeedBody = {
  userId: string;
  channelId?: string;
  mentionRoleIds?: string[];
  message?: { content?: string; embed?: Partial<FeedCard>; buttons?: { label: string; url: string }[] }; // merged over the current design
  filters?: Partial<FeedFilters>;   // merged
  options?: Partial<Omit<FeedOptions, "milestone_last">>; // merged
  enabled?: boolean;   // false = pause; true = resume (nothing published while paused is sent late)
  retry?: boolean;     // clear a disabled/failing source and check it again now
};
// -> { ok: true; feed: BridgeFeed }
```

Switching `options.milestones` on seeds the milestone from the channel's current subscriber count, so
past milestones never fire. Quiet hours need a valid IANA time zone.

### `DELETE /bridge/guilds/:id/feeds/:feedId?userId=`

`{ ok: true; feed: BridgeFeed }` (the deleted feed). Its delivery history goes with it.

### `POST /bridge/guilds/:id/feeds/:feedId/test`

Body `{ userId }`. Posts the feed's message for the source's newest real item (or a sample when it
has none) in the feed's channel, silently (no pings), without recording it as a delivery.

`{ ok: true; sent: true; messageId: string; channelId: string; messageUrl: string }`, or
`send_failed` when the bot can't post there.

### `GET /bridge/guilds/:id/feeds/:feedId/items?userId=&limit=20`

Recent items of the feed's source (newest first, `limit` 1..50) with what this feed did with each.
Use it for the detail page's recent list and the live preview (render the message with a real item).

```ts
type FeedItemsResponse = {
  ok: true;
  items: {
    id: number;
    key: string;
    title: string;
    url: string;
    imageUrl: string | null;
    summary: string;
    author: string | null;
    tags: string[];
    publishedAt: string | null;
    firstSeenAt: string;
    status: "posted" | "filtered" | "failed" | "sending" | "before_feed" | "waiting";
    //  before_feed: already there when the feed was added (or while it was paused)
    //  waiting:     new, posts on the next tick (max 3 per feed per tick, oldest first)
    reason: string | null;      // why it was filtered, or the send error
    messageUrl: string | null;
    postedAt: string | null;
  }[];
};
```

### `POST /bridge/guilds/:id/feeds/preview`

Body `{ userId, source: FeedSourceSpec }`. Validates and resolves the source and returns its latest
five items. Nothing is created. Use it for the RSS URL box (live preview), the catalogue Add step and
to resolve a YouTube/Twitch input.

```ts
type FeedPreviewResponse = {
  ok: true;
  preview: {
    type: FeedSourceType;
    key: string;
    title: string;
    iconUrl: string | null;
    siteUrl: string | null;
    official: boolean;
    /** Another server already follows it (shared source, instant). */
    existing: boolean;
    items: { key: string; title: string; url: string; imageUrl: string | null; summary: string; author: string | null; tags: string[]; publishedAt: string | null }[];
  };
};
```

Errors: `bad_request` (e.g. no region for a Riot entry, malformed repo), `source_invalid` (with a
clear message: not a feed, a web page without a feed link, private repo, unknown app id, blocked
address), `rate_limited`, `upstream_failed`.

### `GET /bridge/guilds/:id/feeds/search?userId=&type=steam|youtube|twitch&q=`

Typeahead. Queries shorter than 2 characters return `[]`.

```ts
type FeedSearchResponse = {
  ok: true;
  results: {
    type: "steam" | "youtube" | "twitch";
    /** Use as the source spec: steam -> { type: "steam", appId: id }; youtube/twitch -> { type, input: id }. */
    id: string;
    name: string;
    handle: string | null;
    imageUrl: string | null;
    url: string;
    live: boolean;          // Twitch only
    detail: string | null;  // "App 730", the game being streamed, or the subscriber count
  }[];
};
```

YouTube has no free search API: `q` is resolved as a handle, channel link, channel id or video
link and returns at most one result.

### `POST /bridge/guilds/:id/feeds/bulk`

Apply one change to many feeds (Settings page bulk apply).

```ts
type BulkFeedsBody = {
  userId: string;
  ids: number[];                // 1..50 feed ids of this server
  set: {
    channelId?: string;
    mentionRoleIds?: string[];
    enabled?: boolean;
    options?: Partial<Pick<FeedOptions, "quiet_enabled" | "quiet_start" | "quiet_end" | "quiet_timezone" | "cooldown_minutes">>;
  };
};
// -> { ok: true; feeds: BridgeFeed[] /* updated (stats not included: zeros) */; missing: number[] /* ids not in this server */ }
```

## Behaviour notes for the site

- Twitch is checked every 2 minutes, YouTube every 5, status pages every 5, RSS and news every 15,
  Steam every 20, GitHub every 30, newswires per catalogue entry (`intervalS`). A source is fetched
  once however many servers follow it.
- New items post oldest first, at most 3 per feed per tick (30 seconds). Items published more than
  7 days before the bot first saw them never post.
- A failing source backs off exponentially (up to 6 hours, or the server's Retry-After) and is
  disabled after 10 failures in a row (`status: "disabled"`, `source.disabledReason`).
- The plugin's enabled switch is still respected at runtime: while Notifications is off in a server,
  its new items are skipped (shown as `filtered` with reason "Notifications plugin was off").
- `/notifications list|test|pause|resume` in Discord uses the same data; creating and editing stays on
  the dashboard. Deep link: `?section=plugin:social&feed=<id>`.


### Health-check status sources

Some services have no incident feed, only a health check. Catalogue entries with the `healthCheck` adapter (e.g. `status-wamoone`) poll the health URL every 2 minutes and their items are up/down transitions: "<Service> is having problems" after two failed checks in a row, then "<Service> is back up" (with live servers/users/latency when a stats URL is set). Item keys are `down:<epoch ms>` / `up:<epoch ms>`. State is in memory, so the first check after a bot restart is the baseline and nothing is posted for it.
