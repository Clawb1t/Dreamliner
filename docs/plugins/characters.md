# Characters plugin

AI roleplay characters for your server. Each character has a name, an avatar, a personality, a
setting, a greeting and example dialogue. Members talk to it in Discord, and it answers in character
through a webhook that shows its own name and avatar. While it thinks, it posts a "typing…" message,
then edits that same message into its reply.

Characters are created and edited on the dashboard only, by members with **Manage Server**. Each one
belongs to the server that made it.

## Talking to a character

| Way | When it works |
|---|---|
| **@mention its role** | Always. Each character gets a mentionable role named after it. Nobody is ever given that role; it only exists to be mentioned. |
| **Reply to its message** | When `triggers.reply` is on (the default). |
| **Write in its dedicated channel** | When `triggers.dedicated_channels` is on (the default). The character answers every message there, and in that channel's threads. |
| **Say its name** | When `triggers.name` is on (off by default). It matches whole words, ignores code blocks, and also matches the distinctive words of a longer name, so "barnacle" works for "Captain Barnacle". |

At most two characters answer one message. Characters never answer bots, webhooks or each other, so
two characters can't get stuck talking to each other.

The character reads the last 20 messages of the channel (or thread) for context. `/characters reset`
makes it forget everything before now in the current channel.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/characters list` | Everyone | Lists the server's characters, their taglines, and how to talk to each one. |
| `/characters reset <character>` | Manage Messages or Manage Server | The character forgets the conversation in this channel. |

## Settings (`plugins.characters.config`)

| Key | Default | Meaning |
|---|---|---|
| `allowed_channels` | `[]` | Channels or categories where characters can talk. Empty means everywhere the bot can read. Each character can override this with its own list, and its dedicated channels always work. |
| `blocked_channels` | `[]` | Channels or categories where characters never talk, even when they're mentioned. |
| `triggers.reply` | `true` | Replying to a character's message talks to it. |
| `triggers.name` | `false` | Saying a character's name talks to it. |
| `triggers.dedicated_channels` | `true` | Characters answer every message in their dedicated channels. |
| `cooldown_seconds` | `5` | How long a member waits between replies from the same character. |
| `member_daily_limit` | `0` | The most replies one member can get in a day. `0` means no limit beyond the server's. |
| `max_reply_chars` | `1200` | The longest reply, up to 1900. |
| `typing_text` | `*{name} is typing…*` | The placeholder shown while a character thinks. |

Talking to characters is the `characters.can_talk` permission. Every member has it by default
through the built-in **Member** role. Remove it from that role, and grant it to other roles, to limit
who can talk to characters.

Characters never talk in age-restricted (NSFW) channels.

## Limits

| | Free | Dreamliner One |
|---|---|---|
| Characters | 2 | 25 |
| Replies per day (whole server, UTC day) | 100 | 3000 |

Dashboard test chats count toward the daily replies. When the server runs out, a character posts a
short note saying it's resting until midnight UTC. The note deletes itself after 20 seconds and
appears at most once every 30 minutes in each channel.

## Rules

These rules are part of every character's instructions, and they override the character's own
description:

- No sexual or NSFW content, ever, including in age-restricted channels.
- No impersonating real people: celebrities, politicians, streamers, or the server's own members.
- No pretending to be Discord, Dreamliner, a moderator, an admin or staff.
- No hate, harassment or slurs.
- No encouraging self-harm, suicide or violence.
- Nothing involving minors in any romantic or sexual way.
- No help with illegal activity.
- If someone sincerely asks, the character says it's an AI.
- No asking for, revealing or repeating personal data.

**Review when saving.** Every time a character is created, or its text changes, it's checked:

1. A quick local check runs first. It blocks names containing "discord" or "clyde" (Discord doesn't
   allow them in webhook names) and names using words like "dreamliner", "moderator", "admin",
   "staff", "everyone" or "here". It also checks every field for slurs.
2. An AI review then reads the whole definition against the rules.

A character that fails the review is saved but turned off, with a "needs changes" reason shown on the
dashboard. It stays off until it's edited and passes.

**Every reply is cleaned before it's posted.** Pings (`@everyone`, `@here`, user and role mentions) are
removed, and replies are sent with all mentions disabled. Swear words are censored, prompt leaks are
removed, and the reply is cut to `max_reply_chars`. If a reply contains a slur, it isn't posted at all.

## Permissions the bot needs

- **Manage Webhooks** lets characters post with their own name and avatar. Without it, they reply as
  Dreamliner with their name in bold, and the dashboard's health check shows a warning.
- **Manage Roles** lets the bot create each character's @role. Without it, the character is still
  saved, but it can only be reached by replies, its name, or its dedicated channel. Use **Recreate
  role** on the dashboard once the permission is granted. The bot can only rename or recolour a
  character's role while Dreamliner's own role is above it.
- **View Channel** and **Read Message History** in the channels where characters talk.

If a character's role is deleted in Discord, the dashboard shows "Role missing" with a button to
recreate it. Deleting a character also deletes its role.

## Avatars

Upload an image (PNG, JPEG or WebP, 4 MB at most) or paste an `https://` image link. Uploaded avatars
are re-encoded as PNG and served from `dreamliner.site/api/characters/<guild>/avatar/<id>`.

## Setup (bot host)

Characters use DeepSeek (OpenAI-compatible). Set these in `.env`:

```
DEEPSEEK_API_KEY=...
# optional
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_CHARACTER_MODEL=deepseek-flash
```

Without a key, the dashboard shows characters as unavailable. Characters can still be saved, but
only the local check runs. They're reviewed by the AI before their first reply once a key is added.
