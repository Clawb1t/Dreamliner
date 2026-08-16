# Bot customisation plugin

Let trusted members customise Dreamliner's **per-server** avatar, banner, nickname, bio, and display name style so it can match the server's branding.

Managed from the **web dashboard** (Brand / bot customisation page). Uses Discord's modify-current-member API (`guild.members.editMe`) — changes apply only in that guild.

## Configuration

```yaml
plugins:
  bot_customisation:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_avatar: true
          can_banner: true
          can_nickname: true
          can_bio: true
          can_display_name: true
```

Dashboard access still requires **Manage Server** (or server owner / platform superuser). Plugin permission flags document which brand fields that level may manage.

## Dashboard features

| Action | Approval | Notes |
|--------|----------|-------|
| Set avatar | Staff review | Normalized to 512×512 PNG, then queued |
| Clear avatar | Immediate | Restores Dreamliner's default avatar in that server |
| Set banner | Staff review | Normalized to 680×240 PNG, then queued |
| Clear banner | Immediate | |
| Set / clear nickname | Immediate | Max 32 characters; bot needs **Change Nickname** |
| Set / clear bio | Immediate | Max 190 characters |
| Set / clear display name style | Immediate | Font, effect, and one or two colors; uses Discord's experimental member API |

Track pending avatar/banner requests live on the dashboard — status updates as staff approve, deny, or as the apply step succeeds/fails. Cancel a pending request from the same page.

## Avatar & banner approval

Image submissions do **not** apply immediately:

1. The image is normalized (square avatar or wide banner PNG).
2. A pending request is stored and shown on the dashboard with live status.
3. Staff see the image in the review channel with **Approve** / **Deny**.
4. Approve applies the image only in the requesting server; deny / fail updates the request status for the dashboard poller.

Reviewers need **Manage Server** in the review channel's server.

## Requirements

- **Images:** PNG, JPEG, GIF, or WebP (max ~10MB). Dreamliner re-encodes before review.
- **Nickname:** Max 32 characters. Dreamliner needs Discord's **Change Nickname** permission.
- **Bio:** Max 190 characters.
- **Display name style:** Eight fonts and six effects, with one or two colors depending on the effect. Monkey Bars, Mainframe, Headbang, Journal, Prism, and Gummy are left out because Discord does not render them. This API is undocumented and may change before discord.js supports it.
- Some Discord clients cache member profiles briefly after changes.
