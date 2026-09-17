# Music plugin

Play music from SoundCloud, Apple Music, Bandcamp, and more with queues, DJ roles, vote-skip, filters, and saved playlists — controllable from Discord commands or the website's music player.

## How it works

1. `/play <query>` joins your voice channel (a search term or a direct link both work) and either starts playing immediately or adds to the queue if something's already playing.
2. Playback, queue, filters, and settings are all controlled with slash commands (below) or from the dashboard's **web player**, which shows up automatically the first time you play something in a server.
3. Anyone can request a skip — with **DJ mode** off, everyone can control playback directly and skip requests are gated by vote-skip; with DJ mode on, only DJs (and a track's own requester, for their own track) can control playback or force-skip.
4. If nobody is listening, the bot auto-leaves after `auto_leave_empty_seconds` unless **24/7 mode** (`/247`) is on.
5. Playlists are saved per-user (not per-server) and can be loaded into the queue in any server, from Discord or the website.

## Configuration

```yaml
plugins:
  music:
    enabled: true
    config:
      dj_roles: []
      dj_mode: false
      vote_skip_threshold_percent: 50
      vote_skip_timeout_seconds: 60
      default_volume: 80
      max_queue_size: 200
      max_track_duration_minutes: 0
      allowed_filters: [none, nightcore, vaporwave, bassboost, 8d, karaoke]
      allowed_voice_channels: []
      allowed_text_channels: []
      announce_now_playing: false
      announce_channel_id: ""
      stay_connected_247: false
      auto_leave_empty_seconds: 120
```

### DJ system and vote-skip

| Field | Description |
|-------|-------------|
| `dj_roles` | Roles treated as DJs: can force-skip, manage anyone's queue items, and bypass vote-skip. Configurable here or with `/dj role add`/`remove`. |
| `dj_mode` | When on, only DJs (and a track's own requester, for their own track) can control playback. When off, anyone with the relevant permission may act directly and vote-skip governs skip requests from everyone else. |
| `vote_skip_threshold_percent` | Percentage of non-bot members in the voice channel that must vote to skip (rounded up, minimum 1 vote). |
| `vote_skip_timeout_seconds` | How long a vote-skip stays open before it expires. |

### Playback defaults and limits

| Field | Description |
|-------|-------------|
| `default_volume` | Volume (%) a fresh player starts at. |
| `max_queue_size` | Maximum tracks allowed in the queue at once. |
| `max_track_duration_minutes` | Reject tracks longer than this many minutes. `0` = no limit. |
| `allowed_filters` | Which `/filter` presets members may use on this server. |

### Channels and announcements

| Field | Description |
|-------|-------------|
| `allowed_voice_channels` | If set, music can only be played in these voice channels. Empty allows any. |
| `allowed_text_channels` | If set, music commands only work in these text channels. Empty allows any. |
| `announce_now_playing` | Post a now-playing message automatically whenever a new track starts. |
| `announce_channel_id` | Channel now-playing announcements post to. Falls back to the channel `/play` was run in. |

### 24/7

| Field | Description |
|-------|-------------|
| `stay_connected_247` | Keep the bot connected even when the queue is empty and nobody is listening, instead of auto-leaving. |
| `auto_leave_empty_seconds` | Seconds to wait after the voice channel empties before leaving. Ignored when 24/7 is on. `0` leaves immediately. |

## Commands

### Playback

| Command | Permission | Description |
|---------|------------|-------------|
| `/play <query>` | `can_play` | Play or queue a track from a search term or direct link |
| `/join` | `can_play` | Join your voice channel without playing anything |
| `/leave` | `can_control_playback` | Stop playback and leave the voice channel |
| `/stop` | `can_control_playback` | Stop playback and leave the voice channel |
| `/pause` / `/resume` | `can_control_playback` | Pause or resume the current track |
| `/skip` | `can_skip` (bypassed by DJs, force-skip, or the track's own requester) | Skip the current track, or start/join a vote |
| `/volume <percent>` | `can_control_playback` | Set the playback volume (0-150) |
| `/seek <position>` | `can_control_playback` | Seek to a position in the current track, e.g. `1:30` |
| `/nowplaying` | `can_play` | Show what's currently playing |
| `/filter <preset>` | `can_control_playback` | Apply an audio filter preset (must be in `allowed_filters`) |

### Queue

| Command | Permission | Description |
|---------|------------|-------------|
| `/queue view [page]` | `can_play` | Show the upcoming queue |
| `/queue remove <position>` | `can_manage_queue` | Remove a track from the queue |
| `/queue move <from> <to>` | `can_manage_queue` | Move a track to a different position |
| `/queue clear` | `can_manage_queue` | Clear the entire queue |
| `/shuffle` | `can_manage_queue` | Shuffle the queue |
| `/loop <mode>` | `can_manage_queue` | Set loop mode: off, track, or queue |

### Playlists

| Command | Permission | Description |
|---------|------------|-------------|
| `/playlist save <name>` | `can_manage_playlists` | Save the current queue as a playlist |
| `/playlist load <name>` | `can_manage_playlists` | Queue up a saved playlist |
| `/playlist list` | `can_manage_playlists` | List your saved playlists |
| `/playlist show <name>` | `can_manage_playlists` | Show the tracks in a playlist |
| `/playlist rename <name> <new_name>` | `can_manage_playlists` | Rename a playlist |
| `/playlist delete <name>` | `can_manage_playlists` | Delete a playlist |

Playlists are saved per-user, not per-server, and can also be created and queued from the website.

### DJ and server settings

| Command | Permission | Description |
|---------|------------|-------------|
| `/dj role add`/`remove`/`list` | `can_manage_dj` | Manage which roles count as DJ |
| `/dj mode <enabled>` | `can_manage_dj` | Toggle DJ mode |
| `/musicconfig announce [channel]` | `can_manage_settings` | Set or turn off the now-playing announce channel |
| `/musicconfig volume-default <percent>` | `can_manage_settings` | Set the default starting volume |
| `/musicconfig votethreshold <percent>` | `can_manage_settings` | Set the vote-skip percentage required |
| `/247 <enabled>` | `can_manage_settings` | Toggle 24/7 mode |

Grant these to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) — see [permissions.md](../permissions.md).

## Website music player

Signed-in users get a full web player on the dashboard: search and queue tracks, control playback (play/pause, skip, volume, filters, loop mode), reorder or clear the queue, and manage playlists — including adding the currently-playing track to a playlist. Anyone signed in and sitting in a voice channel with an active Dreamliner session also sees a "now playing" shortcut in the site navbar that jumps straight to the player.

## Requirements

- The bot needs **Connect** and **Speak** in the voice channel, and a configured Lavalink audio node — music commands reply that music isn't configured if none is set up.
- Only one voice session per server at a time — starting Music while another voice-adjacent session (e.g. Clipping) already owns the voice channel is blocked.

## Setup

1. Grant the playback permissions above to the roles who should be able to use music (e.g. your Member role for `can_play`/`can_skip`, staff for the rest).
2. Optionally set `dj_roles` and turn on `dj_mode` if you want tighter control over a busy server.
3. Run `/play` in a voice channel, or open the web player from the dashboard.
