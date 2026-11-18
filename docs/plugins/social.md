# Notifications plugin (`social`)

One feeds system for everything a server wants announced: YouTube uploads, Twitch streams, any
RSS/Atom feed, Steam game updates, GitHub releases, service status pages and a curated catalogue of
newswires (game updates, console and platform news, service status, gaming news). The dashboard
page is called **Notifications**; the internal plugin name stays `social`.

## How it works

1. On the dashboard, add a feed: a creator (YouTube or Twitch), an RSS URL, a Steam game (searched by
   name), a GitHub repo, a status page, or a newswire from the catalogue. Pick the channel and pings.
2. Each unique upstream is one **source**, polled once however many servers follow it, and fanned out
   to every server's **feed** (subscription). Twitch every 2 minutes, YouTube and status pages every 5,
   RSS and news every 15, Steam every 20, GitHub every 30, newswires per catalogue entry.
3. Following a source never posts what's already there. New items post oldest first, at most 3 per
   feed per 30 second tick; each send is recorded on a unique (feed, item) row, and only marked
   delivered after Discord accepts it, so nothing is ever posted twice or dropped by a crash.
4. Failing sources back off (up to 6 hours, honouring Retry-After) and pause themselves after 10
   failures in a row; the dashboard shows why.

Feeds, sources, items and the delivery log are database tables (`feed_sources`,
`feed_subscriptions`, `feed_items`, `feed_deliveries`), not YAML config. Migration
`0147_feeds.sql` converted the old YouTube/Twitch watchers (messages, roles, embeds, options and
checkpoints) and their delivery history.

## Sources

| Type | Picked by | Fetched from |
|---|---|---|
| YouTube | handle, channel link, channel id or a video link | Data API: the newest 5 uploads (1 unit per poll, shared) |
| Twitch | search or channel link | Helix `/streams`, batched per 100 streamers |
| RSS | any RSS 2.0 / Atom / RDF URL, or a page that links one | `safeFetch` + parser (charset-aware, relative links resolved) |
| Steam | game search or app id | `ISteamNews/GetNewsForApp` (community announcements), optional patch-notes-only filter |
| GitHub | `owner/repo` | `releases.atom` (ETag / 304) |
| Status | catalogue service, or any Statuspage domain | `history.rss`; League of Legends and VALORANT from Riot's status JSON per region |
| Newswire | catalogue entry | per-entry adapter: Rockstar (unofficial), Mojang launcher JSON, Fortnite, HoYoverse, Bungie, Epic free games, platform RSS |

Every fetch goes through `src/core/safeFetch.ts`: http(s) only, DNS resolved and checked against
private/reserved ranges (including IPv6-mapped and 100.64/10), the connection pinned to the checked
address, redirects re-checked (max 3), 2 MB streamed cap, timeout, and the honest user agent
`Dreamliner-Feeds/1.0 (+https://dreamliner.site)`. Only a headline, link, short excerpt (about 300
characters, markdown and mentions escaped) and image are ever posted.

## Message

One design per feed: text with tokens (role pings at `{roles}` or prepended), an optional card, and
up to 5 link buttons. With the card on the post is Components V2; with it off it's a plain message so
Discord's own preview (YouTube player, Twitch stream) shows underneath.

Tokens: `{title}`, `{url}`, `{summary}`, `{image}`, `{source}`, `{source_url}`, `{source_icon}`,
`{published}`, `{author}`, `{tags}`, `{roles}`. YouTube aliases: `{video_title}`, `{video_url}`,
`{video_thumbnail}`, `{video_id}`, `{published_at}`, `{upload_type}`, `{channel_name}`,
`{channel_handle}`, `{channel_url}`, `{channel_avatar}`. Twitch aliases: `{stream_title}`,
`{stream_url}`, `{stream_thumbnail}`, `{game_name}`, `{viewer_count}`, `{started_at}`,
`{streamer_name}`, `{streamer_handle}`, `{streamer_url}`, `{streamer_avatar}`.

## Filters and options

- Filters: include/exclude keywords, categories/tags, Steam patch notes only, YouTube videos /
  Shorts / livestreams.
- Options: quiet hours (post silently, no pings), cooldown (no pings within N minutes of the last
  post; Twitch: a restart reuses the earlier message), YouTube per-type messages for Shorts and
  livestreams, YouTube subscriber milestones (checked every 6 hours, seeded so old milestones never
  fire), Twitch stream end (`edit`, `summary`, `delete`) and live title/category updates.
- Pause / resume: resuming starts from what the source has now, so nothing is announced late.

## Limits

| Tier | Feeds (every type counts) |
|------|---------------------------|
| Free | 10 |
| Dreamliner One | 50 |

Deliveries are kept for 180 days; the all-time count lives on each feed.

## Configuration

```yaml
plugins:
  social:
    enabled: true
    config: {}
```

| Field | Description |
|-------|-------------|
| `enabled` | Turn the plugin off to stop every feed in the server without deleting them (new items are skipped, not queued). |
| `can_manage` | Create, edit and delete feeds on the dashboard (as well as Manage Server), and test/pause/resume them with `/notifications`. |
| `can_view` | Run `/notifications list`. |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/notifications list` | `can_view` | This server's feeds, their channel and status, and slots used |
| `/notifications test feed:` | `can_manage` | Post a test of a feed's message with its newest item (no pings, not recorded) |
| `/notifications pause feed:` | `can_manage` | Pause a feed |
| `/notifications resume feed:` | `can_manage` | Resume a feed (nothing posted while paused is sent late) |

Creating and editing feeds stays on the dashboard; the list links there.

## Bridge

See [`docs/feeds-bridge.md`](../feeds-bridge.md) for the full contract (`/bridge/feeds/catalog`,
`/bridge/guilds/:id/feeds*`).

## Requirements

- `YOUTUBE_API_KEY` for YouTube, `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` for Twitch.
  `FORTNITE_API_KEY` is optional (fortnite-api.com works without one).
- The bot needs **Send Messages** and **Embed Links** in the target channel, and **Read Message
  History** to edit or delete Twitch live messages when a stream ends.
- Mention roles need to be mentionable by the bot.
