# Bot customisation plugin

Let trusted members customise Dreamliner's **per-server** avatar and nickname so it can match the server's branding.

Uses Discord's modify-current-member API (`guild.members.editMe`) — avatar changes apply only in that guild.

## Configuration

```yaml
plugins:
  bot_customisation:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_avatar: true
          can_nickname: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/bot avatar set` | `can_avatar` | Upload an image as Dreamliner's guild avatar |
| `/bot avatar clear` | `can_avatar` | Remove the custom guild avatar |
| `/bot nickname set` | `can_nickname` | Set Dreamliner's nickname in this server |
| `/bot nickname clear` | `can_nickname` | Clear Dreamliner's nickname |

## Requirements

- **Avatar:** PNG, JPEG, GIF, or WebP, max 8MB. Applies only in the current server.
- **Nickname:** Max 32 characters. Dreamliner needs Discord's **Change Nickname** permission.
- Changes are immediate for Discord clients that refresh the member profile; some caches may lag briefly.
