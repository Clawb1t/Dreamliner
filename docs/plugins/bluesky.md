# Bluesky plugin

Real-time Bluesky post notifications, plus liking, reposting and following from Discord.

- **Feeds.** Follow any Bluesky account and its new posts appear in a channel within seconds, as a post card with the author, text, up to four images and any quoted post.
- **Like and Repost buttons.** Every card has 💙 **Like** and **Repost** buttons, plus **Open on Bluesky**. Pressing a button again undoes it.
- **Reaction likes.** React 💙 or 🩵 to any message that links a Bluesky post, and that post is liked on your account. Remove the reaction and the like is removed.
- **Link cards (optional).** When someone pastes a bsky.app post link, Dreamliner replies with an interactive card for it.
- **Profiles.** `/bluesky profile` shows someone's profile with a **Follow** button.
- **Follower milestones (optional, per feed).** A celebration card when a followed account reaches a follower milestone.
- **Import.** Follow everyone in a Bluesky list or starter pack in one go.
- **Stats.** Posts delivered and Like/Repost presses from Discord, per account and for the whole server.

## Connecting your Bluesky account

Liking, reposting and following happen on your own Bluesky account, so each member connects theirs once:

1. Open **dreamliner.site → Account → Connections**, or run `/bluesky account` and press **Connect Bluesky**.
2. Enter your handle (for example `alice.bsky.social`). You sign in on your own Bluesky server's page. You don't need an app password, and Dreamliner never sees your password.
3. Approve the request. Dreamliner can only create and delete **likes**, **reposts** and **follows**. It can't post, read your DMs or change your profile.

Accounts on other servers (self-hosted PDS and so on) work the same way.

If you react 💙 before connecting, Dreamliner sends you a DM with the connect link (at most once a day). Disconnect any time from the Connections page or with `/bluesky account`. Disconnecting signs Dreamliner out on your Bluesky server as well.

Your Bluesky server decides how long a session lasts. If it expires, the next action asks you to connect again.

## Feeds

Feeds are managed on the dashboard's **Bluesky** page, split into sidebar sub-pages:

- **Overview** (the main page): the "Your sky" banner, built from the followed accounts' real avatars, banners and latest posts (fetched from Bluesky's public API and cached for about 10 minutes), headline stats, the busiest accounts in the last 30 days and the most recent deliveries.
- **Accounts**: every followed account with its 30-day and all-time post counts, Like/Repost presses, last post and a 30-day activity chart. Open one to edit it.
- **Import**: follow a whole list or starter pack (see below).
- **Settings**: the server-wide toggles (reaction likes, link cards).

To follow one account:

1. Press **Follow account** and start typing a name. Pick the account from the search results, or paste a handle, profile link or DID. Then pick a channel.
2. Open the feed to customize it. The preview updates as you type.
3. Use **Send test notification** to post the account's latest post with your settings.

### Importing a list or starter pack

On **Import**, paste a list link (`bsky.app/profile/<handle>/lists/<id>`), a starter pack link (`bsky.app/starter-pack/<handle>/<id>`, or a `go.bsky.app` short link) and press **Preview**. Pick who to follow (new accounts are pre-selected up to your plan's limit; accounts the server already follows are skipped), choose one channel, ping roles and shared settings, and import. Up to 150 accounts are read from one list.

### Follower milestones

Turn on **Follower milestones** on a feed to post a celebration card in its channel when the account reaches 100, 250, 500, 1K, 2.5K, 5K, 10K, 25K, 50K, 100K, 250K, 500K or 1M followers, then every million after that. Follower counts are checked every 6 hours (and a few minutes after the bot starts). Only the highest milestone crossed since the last check is announced, a milestone is never announced twice, and turning the option on records where the account is now, so milestones it passed earlier stay quiet. The card shows the account's banner and has **Follow** and **Open profile** buttons.

### Stats

Posts delivered are counted per feed (all time, plus the last 30 days by day). Like and Repost presses are the net presses on this server's cards (buttons and 💙 reactions; undoing one takes it back off), counted from when stats were added and kept for as long as the cards' buttons work (180 days).

Each feed has these settings:

| Setting | Default | Description |
|---------|---------|-------------|
| Message | `{creator_name} just posted on Bluesky!` | Text above the card. Supports the placeholders below. |
| Ping roles | none | Roles to mention. They go where `{roles}` is, or at the start. |
| Replies | off | Also post the account's replies to other people. |
| Reposts | on | Also post things the account reposts. |
| Quote posts | on | Also post the account's quote posts. |
| Media only | off | Only post when the post has images or video. |
| Accent color | Bluesky blue | The card's accent bar. |
| Show media | on | Show images, the video thumbnail or the link preview image. |
| Show buttons | on | Show the Like and Repost buttons. |
| Follower milestones | off | Celebrate follower milestones in this feed's channel. |

### Placeholders

| Placeholder | Value |
|-------------|-------|
| `{post_text}` | The post's text |
| `{post_url}` | Link to the post |
| `{post_type}` | `post`, `reply`, `quote post` or `repost` |
| `{post_time}` | When it was posted (Discord relative time) |
| `{author_name}` / `{author_handle}` / `{author_url}` | Who wrote the post (differs from the creator on reposts) |
| `{creator_name}` / `{creator_handle}` / `{creator_url}` | The followed account |
| `{creator_followers}` / `{creator_posts}` | The followed account's follower and post counts |
| `{roles}` | The feed's ping roles |

## Limits

| Tier | Feeds |
|------|-------|
| Free | 10 |
| Dreamliner One | 50 |

## Configuration

```yaml
plugins:
  bluesky:
    enabled: true
    config:
      reaction_likes: true
      link_cards: false
```

| Field | Description |
|-------|-------------|
| `enabled` | Turn the plugin off to pause every feed, reaction likes and link cards without deleting anything. |
| `reaction_likes` | Like posts with a 💙 or 🩵 reaction. |
| `link_cards` | Reply to pasted bsky.app post links with an interactive card. |
| `can_manage` | Add, edit and remove feeds (dashboard). |
| `can_view` | List feeds with `/bluesky feeds`. |
| `can_use` | Use `/bluesky profile` and `/bluesky account`. |

Like/Repost/Follow buttons don't need a server permission. They only need the member's own connected account.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/bluesky feeds` | `can_view` | List this server's feeds and how many slots are used |
| `/bluesky profile <handle>` | `can_use` | Show a Bluesky profile with a Follow button |
| `/bluesky account` | `can_use` | Connect, check or disconnect your Bluesky account |

By default, Members get `can_use` and Moderators get `can_view` and `can_manage`. Change this on the dashboard's **Roles** page. See [permissions.md](../permissions.md).

## Requirements

- The bot needs **Send Messages** and **Embed Links** in each feed's channel.
- Link cards hide Discord's own preview of the pasted link only if the bot has **Manage Messages** there.
- Reaction likes need the bot to see the channel's messages and reactions.

## Self-hosting

Feeds use Bluesky's public stream and API and need no keys. Account connections need two secrets in `.env`, which you can generate with `npm run bluesky:keys`:

- `BLUESKY_OAUTH_PRIVATE_JWK` signs the OAuth client. It isn't needed when the site URL is localhost, because local development uses AT Protocol's loopback client.
- `BLUESKY_SESSION_SECRET` encrypts stored sessions. Changing it signs everyone out.

The website must serve `/api/bluesky/client-metadata.json`, `/api/bluesky/jwks.json` and `/api/account/bluesky/callback`.
