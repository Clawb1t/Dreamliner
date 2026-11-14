# Social Notifications plugin

YouTube upload and Twitch go-live notifications. Point Dreamliner at a channel or streamer, pick where posts go, and every new upload or stream is announced automatically. The dashboard page is called **Notifications**.

## How it works

1. From the dashboard, add a creator: a YouTube channel (handle, channel link, channel ID, or a link to any of their videos) or a Twitch streamer (search by name, or paste the channel link). Pick which Discord channel to post in.
2. Dreamliner checks YouTube every 5 minutes and Twitch every 2 minutes.
3. When something new shows up it posts a message: a plain text mention by default, or a fully custom Discord embed.
4. Everything is per creator: message text, role pings, embed, upload types, stream-end behaviour, cooldown, quiet hours and milestones.

Creators, their checkpoints and the delivery log are dashboard-managed data (database tables), not YAML config.

## Per-creator options

### YouTube

| Option | Default | What it does |
|--------|---------|--------------|
| Videos / Shorts / Livestreams and premieres | all on | Which upload types are announced. Each new upload is checked once (`videos.list`, plus a free `youtube.com/shorts/<id>` check for videos of three minutes or less) to tell them apart. Turned-off types are skipped silently. |
| Own message for Shorts / livestreams | off | A different message and different role pings for that type. The embed is shared. Leave the message empty to keep the main message but ping other roles. |
| Ping cooldown | off | Uploads within N minutes of the last notification still post, but without role pings. |
| Subscriber milestones | off | A Components V2 celebration card (trophy emoji, avatar, banner) at 100, 250, 500, 1K, 2.5K, 5K, 10K, 25K, 50K, 100K, 250K, 500K, 1M, then every 1M subscribers. Checked every 6 hours. Turning it on records the current milestone first, so old milestones never fire. Channels that hide their subscriber count are skipped. |

### Twitch

| Option | Default | What it does |
|--------|---------|--------------|
| Keep the title and category up to date | off | Edits the live message when the stream title or category changes (from the regular 2-minute poll, no extra calls). Edits never ping again. |
| When the stream ends | leave it | `edit` turns the live message into a summary (duration, final title and category, peak viewers, VOD link when the channel saves VODs); `summary` posts that summary as a reply instead; `delete` removes the live message. A stream counts as ended after about 4 minutes offline. |
| Restart cooldown | off | Going live again within N minutes of the last stream doesn't notify again; the earlier live message is reused (and turned back into a live message if it had been edited into a summary). |

Twitch follower milestones aren't offered: Helix only returns follower totals to the broadcaster's own (or a moderator's) user token, and the bot uses an app access token.

### Both

| Option | Default | What it does |
|--------|---------|--------------|
| Pause | | The creator's switch. Paused creators aren't checked. Resuming starts from their current latest upload / stream, so nothing posted while paused is announced late. |
| Quiet hours | off | Between two hours in a chosen time zone, notifications still post but silently (Discord's silent flag) and without role pings. The window can wrap past midnight. The dashboard's Settings sub-page can apply the same quiet hours to every creator at once. |

## Placeholders

YouTube: `{video_title}`, `{video_url}`, `{video_thumbnail}`, `{video_id}`, `{published_at}`, `{upload_type}` (video, Short, livestream, upcoming stream), `{channel_name}`, `{channel_handle}`, `{channel_url}`, `{channel_avatar}`.

Twitch: `{stream_title}`, `{stream_url}`, `{stream_thumbnail}`, `{game_name}`, `{viewer_count}`, `{started_at}`, `{streamer_name}`, `{streamer_handle}`, `{streamer_url}`, `{streamer_avatar}`.

Message text also supports `{roles}` to place the role pings.

## Dashboard

Sub-pages: **Overview** (the "Now showing" hero with the creators' real banners, latest videos and live streams, headline stats, a 30-day chart and the recent notifications list linking to the Discord message and the video or stream), **Creators** (list with per-creator 30-day / all-time counts, last notified and a sparkline; add, search, edit), **Settings** (quiet hours for everyone, platform status).

Bridge endpoints (all require Manage Server): `GET/POST /bridge/guilds/:id/social/watchers` (the list now includes `stats`, `totals`, `recent`, `platforms`), `PATCH/DELETE .../watchers/:wid` (accepts `options`), `POST .../watchers/:wid/test`, `POST .../social/resolve`, `GET .../social/showcase` (cached 10 minutes, Twitch live status 90 seconds), `GET .../social/search?platform=twitch&q=` (Twitch channel typeahead, cached 5 minutes, rate limited per user).

## API quota

YouTube Data API v3 (10,000 units/day): one `playlistItems.list` (1 unit) per tracked channel per 5-minute pass, shared by every server tracking that channel; one `videos.list` (1 unit) per new upload; one `channels.list` (1 unit per 50 channels) per 6-hour milestone pass; the dashboard hero costs about N + 2 units per server per 10 minutes while someone has it open (one playlistItems call for the newest 3 uploads of each of up to 12 YouTube channels, plus one channels.list and one videos.list per 50 ids). `search.list` (100 units) is never used: YouTube creators are resolved from handles and links on submit. Twitch live status is one batched `/streams` call per 100 streamers per pass.

## Limits

| Tier | Creators |
|------|----------|
| Free | 10 |
| Dreamliner One | 50 |

Deliveries are kept for 180 days; the all-time count lives on each creator.

## Configuration

```yaml
plugins:
  social:
    enabled: true
    config: {}
```

| Field | Description |
|-------|-------------|
| `enabled` | Turn the plugin off to stop all creators without deleting them. |
| `can_manage` | Create, edit, and delete social notifications (dashboard). |
| `can_view` | View social notifications and run `/social`. |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/social` | `can_view` | List this server's creators and how many slots are used |

## Requirements

- `YOUTUBE_API_KEY` for YouTube, `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` for Twitch.
- The bot needs **Send Messages** and **Embed Links** in the target channel; **Read Message History** to edit or delete live messages when a stream ends.
- Mention roles need to be mentionable by the bot.
