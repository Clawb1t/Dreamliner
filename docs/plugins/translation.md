# Translation plugin

Translate text and messages with `/translate`, and optionally add a flag reaction on messages that are not in your server’s default language. Pressing that reaction replies with a translation embed.

No API key is required. Dreamliner uses Google’s public translate endpoint via [`google-translate-api-x`](https://www.npmjs.com/package/google-translate-api-x). That endpoint can rate-limit under heavy use.

## Server default language

Set top-level `default_language` in guild config (dashboard **Server** settings), default `en`:

```yaml
default_language: en
```

This is the target for `/translate` when no language is chosen, and the flag used by auto-translate.

## Configuration

```yaml
plugins:
  translation:
    enabled: true
    config:
      auto_translate: false
      ignored_channels: []
```

| Field | Description |
|-------|-------------|
| `auto_translate` | When `true`, react with the default-language flag on messages that look like another language. Default `false`. |
| `ignored_channels` | Channel IDs where auto-translate is skipped. |
| `can_translate` | Permission to use `/translate` |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/translate` | `can_translate` | Translate `text` or a `message_id` (raw ID in this channel, or a Discord message link). Optional `language` (autocomplete); otherwise uses the server default. |

Default permission grants (level **50+**):

```yaml
overrides:
  - level: ">=50"
    config:
      can_translate: true
```

## Auto-translate

1. Enable `auto_translate` in the dashboard or YAML.
2. Members post in any channel except those in `ignored_channels`.
3. If Dreamliner detects a different language than `default_language`, it adds that language’s flag reaction.
4. Anyone can press the reaction; Dreamliner posts a silent plain-text translation as the original author (via webhook), with a small “Translated with Dreamliner” footer. The bot needs **Manage Webhooks** in that channel for the author avatar/name; otherwise it falls back to a plain bot reply.

Very short messages (under 4 characters) are skipped for detection noise.

## Examples

```yaml
default_language: es

plugins:
  translation:
    enabled: true
    config:
      auto_translate: true
      ignored_channels:
        - "1111111111111111111"
```

Or use Discord:

1. Set **Default language** on the dashboard Server page.
2. Open the **Translation** plugin → enable **Auto translate**.
3. `/translate text:Hola language:English`
