# Companion channels plugin

Create temporary voice channels when members join a hub voice channel. Each member gets their own channel named from a template.

## Configuration

```yaml
plugins:
  companion_channels:
    enabled: true
    config:
      name_template: "{user}'s channel"
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_delete: true
```

| Field | Description |
|-------|-------------|
| `name_template` | Name for new channels; supports `{user}` placeholder |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/companion create` | `can_create` | Register a voice channel as a companion hub |
| `/companion delete` | `can_delete` | Remove a companion hub |

## Requirements

- The bot needs **Manage Channels** and **Move Members**.
- Empty companion channels are deleted automatically when the last member leaves.
- If a member already has a companion channel, they are moved back to it when rejoining the hub.
