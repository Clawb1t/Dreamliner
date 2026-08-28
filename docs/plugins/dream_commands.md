# Custom commands plugin

Custom slash commands (`/name`), built on the website dashboard. Each command is always exactly one reply, text or embed.

Reference: [../dreamcode/README.md](../dreamcode/README.md)

## Configuration

```yaml
plugins:
  dream_commands:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_edit: true
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `can_edit` | Toggle a command on or off with `/command toggle`. |
| `can_remove` | Delete a command with `/command remove`. |
| `can_list` | List commands with `/command list`. |

Commands themselves are created and edited on the dashboard, not gated by a Discord-side permission (creating one still requires Manage Server on the dashboard).

## Registration

Every custom command registers as a **guild** slash command, up to **10** per server. Names cannot collide with a built-in Dreamliner command (`help`, `ban`, `command`, …). Slash commands sync per guild via Discord's guild command API and may take up to a minute to appear after create, remove, or edit.

## Slash commands (management)

| Command | Permission | Description |
|---------|------------|-------------|
| `/command list` | `can_list` | List custom commands |
| `/command toggle` | `can_edit` | Enable or disable a command |
| `/command remove` | `can_remove` | Delete a command |
| `/command info` | none | Points staff to the dashboard's Commands section |

## Requirements

- Bot must be able to register guild application commands.
