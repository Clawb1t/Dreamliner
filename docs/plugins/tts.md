# Text-to-speech plugin

Dreamliner speaks messages aloud in a voice channel using a local [Piper](https://github.com/rhasspy/piper)
process on the bot's own host. No external API, no per-request cost.

There's no `/tts <text>` command — instead, pick a **TTS text channel** for the server. Any message a member
sends there while they're in a voice channel gets spoken into that voice channel automatically, in that
member's chosen voice.

## Automatic setup

On every boot, Dreamliner checks `./data/piper` for a `piper` binary and downloads it if missing (correct
build for the host's OS/arch). It also installs one default voice (`en_US-hfc_male-medium`) so `/tts` works
immediately, then — after the bot is already online, in the background so it doesn't delay startup —
**downloads the full voice catalogue for `PIPER_LANGUAGES`** (default `en,es,ja` — English, Spanish, and
Japanese; one voice per name/locale, at Piper's recommended "medium" quality) so `/tts voice` has a real
range to pick from. This is idempotent on every restart: only voices not already on disk (and actually valid
— see below) get downloaded.

This is a genuinely large one-time download — dozens of voices per language, several GB total across the
default three. On a disk-constrained host, set `PIPER_INSTALL_VOICE_PACK=false` to skip it and keep just the
single default voice, adding others manually as needed (see below), or trim `PIPER_LANGUAGES` to fewer
languages.

A handful of the installed models (VCTK, ARCTIC, and a few smaller sets) are **multi-speaker** — one model
file contains dozens of distinct speakers. Dreamliner exposes each speaker as its own selectable voice rather
than just the model's default one, which is where most of the real variety in `/tts voice` comes from — no
extra download needed, they're already in the files above. Note this repo doesn't have a way to listen to
audio, so voices are labeled by objective facts (language, region, quality, speaker code) and can't be
curated by how they actually sound.

Downloads are atomic (written to a `.part` file, then renamed into place), and a voice is only ever listed
as pickable if its config file actually loads — so an interrupted download never shows up as a choice that
then fails when someone tries to use it. On restart, anything left over from before this was added (a
`.onnx` present but its `.onnx.json` missing or corrupt) gets automatically re-downloaded rather than stuck
skipped forever.

If any part of setup fails (no network, no matching release, `tar` missing, etc.), the bot still starts; it
logs a warning and `/tts` reports an error until it's fixed.

**Host requirements**: the bot process must be able to spawn subprocesses and write to `./data`. Shared/managed
panel hosts sometimes sandbox the container to just the configured startup command — if auto-setup can't
download, or `/tts` can't spawn `piper`, that's a hosting permission issue, not a bug in this plugin.

### Manual override

- `PIPER_BIN` — path to an existing `piper` executable, to skip auto-install of the binary.
- `PIPER_VOICES_DIR` — directory of voice model pairs (`<id>.onnx` + `<id>.onnx.json`), to use your own set.
- `PIPER_DEFAULT_VOICE` — voice id used when a member and the guild have both left `voice` unset.
- `PIPER_LANGUAGES` — comma-separated Piper language family codes to bulk-install. Default `en,es,ja`.
- `PIPER_INSTALL_VOICE_PACK=false` — skip the background bulk voice pack download entirely.

### Adding more voices manually

Grab any pair from the [Piper voices catalogue](https://huggingface.co/rhasspy/piper-voices) — including
non-English languages, or a different quality tier of a voice already installed — and drop both files into
the voices directory (`./data/piper/voices` by default). No restart needed: `/tts voice`'s autocomplete and
`/tts channel`'s speaking both read that directory live.

## Configuration

```yaml
plugins:
  tts:
    enabled: true
    config:
      text_channel_id: "123456789012345678"
      voice: en_US-hfc_male-medium
      max_characters: 300
      cooldown_seconds: 0.5
    overrides:
      - level: ">=0"
        config:
          can_speak: true
      - level: ">=50"
        config:
          can_manage_channel: true
```

| Field | Description |
|---|---|
| `text_channel_id` | The auto-speak text channel. Set with `/tts channel set`, cleared with `/tts channel clear`. |
| `voice` | Server default voice id, used for members who haven't picked one with `/tts voice`. Empty uses `PIPER_DEFAULT_VOICE`. |
| `max_characters` | Caps how much of a message gets spoken — longer messages are truncated, not rejected. |
| `cooldown_seconds` | Per-member cooldown between spoken messages, accepts fractional values (e.g. `0.5`). Resets on bot restart. |

`can_speak` and `can_manage_channel` follow the standard `can_*` permission model — grant them with
level/role/channel overrides from the dashboard. By default, `can_speak` is `true` for everyone
(`level >= 0`) and `can_manage_channel` is `true` at `level >= 50`.

## Commands

- `/tts voice <voice>` — requires `can_speak`. Sets your personal voice for the auto-speak channel; the
  `voice` option autocompletes from every installed voice, shown as Piper's own voice name (or
  `name (speaker-code)` for a speaker pulled out of a multi-speaker model) plus a 3-word style tag, e.g.
  "Amy, soft, simple, warm" or "Vctk (p225), calm, steady, low" — rather than the raw `en_US-amy-medium`
  file id. The name is always Piper's real name/speaker id, never invented, so it can't misdescribe who a
  voice actually is (e.g. assigning a name that implies the wrong gender). The style tag is a deterministic
  browsing label (same id always gets the same tag) — this repo has no way to play or analyze audio, so it
  isn't a verified description of how the voice actually sounds.
- `/tts channel set <channel>` — requires `can_manage_channel`. Sets the auto-speak text channel.
- `/tts channel clear` — requires `can_manage_channel`. Turns it off.

## Behaviour notes

- A message in the TTS channel is spoken only if its author is currently in a voice channel and has
  `can_speak`; otherwise it's silently ignored (this is an ambient channel, not a command — most messages in
  it won't come from someone in voice, and that's expected).
- Messages from the same member are queued and played in order; Dreamliner leaves the voice channel
  automatically about 10 minutes after the queue empties, in case more messages follow soon.
- If Dreamliner is already speaking in a different voice channel in the same server, the message is dropped
  (reacted with ❌) rather than interrupting that session.
- Bot messages and webhook messages in the TTS channel are never spoken.
- URLs, bare media filenames (gifs, images, video clips), and emoji (Discord custom and Unicode) are stripped
  from a message before it's spoken. A message that's *only* one of those (a pasted link, a GIF, a string of
  emoji) is skipped entirely.
- While something is playing, the voice channel's status shows the display name of whoever's message is
  being read, so it's easy to tell who's currently speaking. It clears once the queue empties. Updates are
  throttled to at most one every 10 seconds per channel — if several speakers change within that window, only
  the most recent one is actually sent, so the status can't fall behind into showing stale/past speakers.
