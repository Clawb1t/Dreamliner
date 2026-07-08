# Command aliases plugin

Create shortcuts that run other slash commands with preset options. Aliases can also be triggered by sending the alias name as a plain message.

## Configuration

```yaml
plugins:
  command_aliases:
    enabled: true
    config:
      message_triggers: true
    overrides:
      - level: ">=50"
        config:
          can_list: true
          can_run: true
      - level: ">=100"
        config:
          can_create: true
          can_delete: true
```

| Field | Description |
|-------|-------------|
| `message_triggers` | When `true`, sending a message that exactly matches an alias name runs it (default: `true`) |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/alias create` | `can_create` | Create an alias for a slash command (level ≥100) |
| `/alias delete` | `can_delete` | Delete an alias by name (level ≥100) |
| `/alias list` | `can_list` | List command aliases |
| `/alias run` | `can_run` | Run an alias by name |

## Usage

Create a help shortcut:

```
/alias create name:test command:help
```

Then either run `/alias run test` or send a message containing only `test` (if `message_triggers` is enabled).

## Requirements

- Aliases are stored per server in the Dreamliner database.
- The target command must exist and the user must have permission to run it.
- Preset options are stored as a JSON object matching the target command's options.
