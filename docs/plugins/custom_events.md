# Custom events plugin

Define automatic bot replies when messages match configured text or regex patterns.

## Configuration

```yaml
plugins:
  custom_events:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_list: true
      - level: ">=100"
        config:
          can_delete: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/event create` | `can_create` | Create a custom event with name, match text, and response |
| `/event list` | `can_list` | List custom events |
| `/event delete` | `can_delete` | Delete an event by name (level ≥100) |

## Requirements

- Events are stored per server in the Dreamliner database.
- Optional JSON config can restrict events to specific channels, enable regex, or set case sensitivity.
- Bot messages do not trigger events.
