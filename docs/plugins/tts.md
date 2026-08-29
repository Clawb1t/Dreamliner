# Text-to-speech plugin

`/tts` makes Dreamliner join the invoking member's voice channel and speak text aloud, using a local
[Piper](https://github.com/rhasspy/piper) process on the bot's own host. No external API, no per-request
cost, and adding a voice is just dropping two files on disk.

## Automatic setup

On every boot, Dreamliner checks `./data/piper` for a `piper` binary and a default voice model
(`en_US-lessac-medium`) and downloads whatever's missing — see `ensurePiperReady()` in
[`src/plugins/tts/functions/piperSetup.ts`](../../src/plugins/tts/functions/piperSetup.ts). This means a
fresh deploy (including a Pterodactyl-style panel host) has a working `/tts` after its first restart, with
no manual step. It's idempotent — once the binary and default voice exist, boot does nothing further.

If setup fails (no matching release for the host's OS/arch, no network access, `tar` missing, etc.), the bot
still starts; it just logs `[dreamliner] Piper TTS setup incomplete: ...` and `/tts` replies with an error
until it's fixed.

**Host requirements**: the bot process must be able to spawn subprocesses and write to `./data`. Shared/managed
panel hosts sometimes sandbox the container to just the configured startup command — if auto-setup can't
download or `/tts` can't spawn `piper` there, that's a hosting permission issue, not a bug in this plugin.

### Manual override

Set these env vars to skip auto-install and point at your own setup instead:

- `PIPER_BIN` — path to an existing `piper` executable.
- `PIPER_VOICES_DIR` — directory of voice model pairs (`<id>.onnx` + `<id>.onnx.json`).
- `PIPER_DEFAULT_VOICE` — voice id used when a guild hasn't set `plugins.tts.config.voice`.

## Adding voices

Download more voice pairs from the [Piper voices catalogue](https://huggingface.co/rhasspy/piper-voices) —
each is a `<id>.onnx` + `<id>.onnx.json` pair — and drop them into the voices directory (`./data/piper/voices`
by default). No restart needed: `/tts`'s `voice` option autocompletes from whatever's in that directory.

## Configuration

```yaml
plugins:
  tts:
    enabled: true
    config:
      voice: en_US-lessac-medium
      max_characters: 300
      cooldown_seconds: 0.5
    overrides:
      - level: ">=0"
        config:
          can_speak: true
```

| Field | Description |
|---|---|
| `voice` | Default voice id. Empty uses `PIPER_DEFAULT_VOICE`. Members can override per-request with the command's `voice` option. |
| `max_characters` | Caps request length server-side, independent of Discord's own 500-character option limit. |
| `cooldown_seconds` | Per-member cooldown between uses, accepts fractional values (e.g. `0.5`). Resets on bot restart. |

`can_speak` follows the standard `can_*` permission model — grant it with level/role/channel overrides from
the dashboard. It defaults to `true` for everyone (`level >= 0`).

## Commands

- `/tts text:<text> [voice]` — requires `can_speak`. Fails if the member isn't in a voice channel, the text
  exceeds `max_characters`, the cooldown hasn't elapsed, Piper isn't set up, or Dreamliner is already speaking
  in a different voice channel in the same server.

## Behaviour notes

- Requests from the same voice channel are queued and played in order; Dreamliner leaves automatically about
  10 minutes after the queue empties, in case `/tts` is used again soon.
- Requests aimed at a different channel while Dreamliner is mid-queue elsewhere are rejected rather than
  interrupting the current session — try again once it's done.
