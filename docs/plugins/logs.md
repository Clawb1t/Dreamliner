# Logs plugin

Clean logging for server activity and moderation actions. The logs plugin has no commands - it listens to Discord events and posts messages to configured channels.

## Configuration

```yaml
# Server events: joins, leaves, message edits/deletes, voice activity, nickname/role changes
server_log_channel_id: "1234567890123456789"

# Moderation: infractions, automod, censor, cleans, voice mod, case updates
moderation_log_channel_id: "1234567890123456789"
```

The legacy `log_channel_id` field still works as a fallback for moderation logs if `moderation_log_channel_id` is not set.

Infraction case logs can optionally use a dedicated channel via `plugins.infractions.config.case_log_channel`, which overrides `moderation_log_channel_id` for case-related lines only.

## Message tracking

While the bot is running, messages in servers with `server_log_channel_id` set are saved to the database. If a message is deleted after a bot restart, Dreamliner can still log the delete using the stored author, channel, and content.

Messages are retained for **42 days**. Bot messages are not tracked.

## Log layout

Each log is a **Components v2** message styled like command responses:

- Colorless **container**
- **Section** with the member's avatar thumbnail (when available)
- Bold **title** (e.g. **📥 Join**)
- **Information** block with labeled fields: Member, Target, Moderator, Channel, etc.
- **Member**, **Target**, and **Moderator** use clickable mentions with ID in backticks: `<@user> (`id`)`
- **Channel** fields use clickable channel mentions: `<#channel> (`id`)`
- **Role** changes use role mentions with IDs in backticks
- **Separator** + extra block for message content or before/after edits

No @mentions are used and `allowedMentions` is disabled on every log message.

## Server log events

| Event | Title |
|-------|-------|
| Member join | 📥 Join |
| Member leave | 📤 Leave |
| Message edit | 📝 Edit Message |
| Message delete | 🗑️ Delete Message |
| Voice join/leave/move | 🔊 / 🔇 / 🔀 |
| Nickname change | 📝 Nickname Change |
| Role change | 🎭 Role Change |

Bot accounts are excluded from member and message logs.

## Moderation log events

| Source | Title |
|--------|-------|
| `/warn`, `/mute`, `/ban`, etc. | ⚠️ Warn #42, 🔇 Mute #43, … |
| `/infraction reason\|duration\|delete` | 📝 Case Update, 🔴 Case Delete |
| `/clean` | 🧼 Clean |
| Automod (spam, rate limit, raid) | 🤖 Automod, 🚨 Raid Detected |
| Censor (word filter) | 🚫 Censor |
| `/voice move`, `move-all`, `disconnect` | 🔀 Voice Move, 🔇 Voice Disconnect |
| Mute/tempban expiry | 🔊 Mute Expired, ✅ Temp Ban Expired |
| Failed DMs | 🚧 DM Failed |
