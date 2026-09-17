# Clipping plugin

Record voice channel activity and export shareable clips of the last few minutes — built for "wait, clip that!" moments instead of always-on recording. Clips are hosted on [Dreamliner Clips](https://dreamliner.bot/clips), with a per-clip page you can share, and a gallery of every clip you've captured or appear in.

## How it works

1. `/clipping start` joins your voice channel and begins keeping a rolling per-user audio buffer, up to `clip_max_seconds` long. Nothing is saved to disk yet — it's just a live buffer.
2. At any point, `/clip [time]` mixes down and exports the requested window (30 seconds up to 5 minutes, capped at `clip_max_seconds`) into a shareable clip, with a participant list built from who was actually speaking in that window.
3. Each clip automatically gets a best-effort transcript generated in the background — a missing transcript never blocks the clip itself.
4. `/clipping stop` stops recording but keeps the bot in the voice channel for 15 minutes in case you want to start again, then it leaves on its own. If the channel empties out, the bot leaves automatically too.
5. `/clipping clips` links you to your Dreamliner Clips page — every clip you've captured, and every clip you appear in as a participant.
6. Clips are deleted automatically after `retention_days`, unless their owner marks one to keep forever from the website.

## Configuration

```yaml
plugins:
  clipping:
    enabled: true
    config:
      clip_max_seconds: 300
      retention_days: 30
```

| Field | Description |
|-------|-------------|
| `clip_max_seconds` | Longest clip `/clip` can export, and the size of the live rolling buffer kept while recording. Choices: 30, 60, 120, 240, or 300 seconds. |
| `retention_days` | Days an exported clip is kept before automatic deletion, unless its owner marks it to keep forever from the website. |
| `can_record` | Start a voice recording session with `/clipping start`/`stop`. |
| `can_clip` | Export a clip of recent voice activity with `/clip`. |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/clipping start` | `can_record` | Start recording your current voice channel |
| `/clipping stop` | `can_record` | Stop recording, but keep the bot in the voice channel |
| `/clipping clips` | — | Get a link to your Dreamliner Clips page |
| `/clip [time]` | `can_clip` | Export a clip of recent voice activity (default: 30 seconds) |

Grant `can_record` and `can_clip` to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) —
see [permissions.md](../permissions.md).

## Dreamliner Clips (website)

Every exported clip gets a page at `dreamliner.bot/case/…`-style shareable link, and signed-in users get a gallery at **dreamliner.bot/clips** showing every clip they own or appear in — with playback, the auto-generated transcript, and a "keep forever" toggle that exempts a clip from `retention_days`.

## Requirements

- The bot needs **Connect** and **Speak** in the voice channel to record.
- Only one recording session per server at a time — starting a new one while another voice-adjacent session (e.g. Music) is already active in a different channel is blocked.

## Setup

1. Grant `can_record` and `can_clip` to the roles who should be able to use it.
2. In a voice channel, run `/clipping start`.
3. Whenever something worth saving happens, run `/clip` (optionally with a `time` window).
4. Share the link from the reply, or find it later from `/clipping clips` / the Dreamliner Clips gallery.
