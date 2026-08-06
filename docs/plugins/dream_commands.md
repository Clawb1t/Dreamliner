# Dreamcode commands plugin

Custom commands written in **Dreamcode**, registered as **guild slash** commands (`/name`).

Language docs: [../dreamcode/README.md](../dreamcode/README.md)

## Configuration

```yaml
plugins:
  dream_commands:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_edit: true
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `prefix` | **Deprecated / ignored.** Older configs may still include it. |

### Who can run a command?

Each command has `min_level`. The invoker’s Dreamliner level must be **≥** that value.

## Trigger type

Declared **in the `.dream` file** with `@slash` (required):

```dream
@slash
@slash description "Staff ping"
@slash noargs
reply "📢"
```

| Type | How it runs | Limits |
|------|-------------|--------|
| **slash** (`@slash`) | `/name` registered as a **guild** slash command | **Max 10** per server |

Rules:

- Prefix (`@prefix` / `d!…`) is **not supported**.
- Names cannot collide with built-in Dreamliner commands (`help`, `ban`, `command`, …).
- Slash commands are synced per guild via Discord’s guild command API (not global). They may take up to a minute to appear after create/remove/edit.
- Typed options: `@slash arg user target "Who" required` → Discord user option → `arg.target` in the script.
- See [language.md](../dreamcode/language.md) for `noargs`, `ephemeral`, `description`, and all arg types.

## Slash commands (management)

| Command | Permission | Description |
|---------|------------|-------------|
| `/command create` | `can_create` | Upload a `.dream` file (`@slash` required) |
| `/command edit download` | `can_edit` | Download source |
| `/command edit upload` | `can_edit` | Replace source |
| `/command remove` | `can_remove` | Delete a command |
| `/command list` | `can_list` | List custom commands |

## Requirements

- Bot must be able to register guild application commands.
- Migration `0014_disable_prefix_dream_commands` disables any leftover prefix rows.
