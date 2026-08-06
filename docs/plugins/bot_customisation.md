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
| `/bot avatar set` | `can_avatar` | Queue a custom guild avatar for staff approval |
| `/bot avatar cancel` | `can_avatar` | Cancel this server's pending avatar request |
| `/bot avatar clear` | `can_avatar` | Remove the custom guild avatar (immediate) |
| `/bot nickname set` | `can_nickname` | Set Dreamliner's nickname in this server |
| `/bot nickname clear` | `can_nickname` | Clear Dreamliner's nickname |

## Avatar approval

`/bot avatar set` does **not** apply immediately:

1. The image is normalized to a 512×512 PNG.
2. The user gets a public “pending review” reply in the command channel.
3. Staff see the image in the review channel with **Approve** / **Deny**.
4. On decide, Dreamliner edits the original pending message with the result.
5. Approve applies the avatar only in the requesting server.

Reviewers need **Manage Server** in the review channel's server.

## Requirements

- **Avatar:** PNG, JPEG, GIF, or WebP (max ~10MB). Dreamliner center-crops to a square and re-encodes to a 512×512 PNG before review. Applies only in the current server once approved.
- **Nickname:** Max 32 characters. Dreamliner needs Discord's **Change Nickname** permission.
- Changes are immediate for Discord clients that refresh the member profile; some caches may lag briefly.
