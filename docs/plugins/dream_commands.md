# Dreamcode commands plugin

Custom commands written in **Dreamcode**, triggered as **prefix** messages or **guild slash** commands.

Language docs: [../dreamcode/README.md](../dreamcode/README.md)

## Configuration

```yaml
plugins:
  dream_commands:
    enabled: true
    config:
      prefix: "d!"
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
| `prefix` | Case-sensitive prefix for **prefix**-type commands (default `d!`) |

### Who can run a command?

Each command has `min_level`. The invoker’s Dreamliner level must be **≥** that value.

## Trigger types

Declared **in the `.dream` file**, not in the Discord create command:

```dream
@prefix
reply "hi"
```

```dream
@slash
@slash description "Staff ping"
reply "📢"
```

| Type | How it runs | Limits |
|------|-------------|--------|
| **prefix** (`@prefix`) | `d!name args…` (configurable prefix) | Unlimited per server |
| **slash** (`@slash`) | `/name` registered as a **guild** slash command | **Max 10** slash Dreamcode commands per server |

Rules:

- Names are unique across **both** types — you cannot have prefix `boom` and slash `boom`.
- Names cannot collide with built-in Dreamliner commands for **either** trigger (`help`, `ban`, `command`, …) — so neither `d!help` nor `/help` can be created as Dreamcode.
- Slash commands are synced per guild via Discord’s guild command API (not global). They may take up to a minute to appear after create/remove/edit.
- Typed options: `@slash arg user target "Who" required` → Discord user option → `arg.target` in the script.
- See [language.md](../dreamcode/language.md) for `noargs`, `ephemeral`, `description`, and all arg types.

## Slash commands (management)

| Command | Permission | Description |
|---------|------------|-------------|
| `/command create` | `can_create` | Create with `name`, `code` file, optional `level` (trigger from `@prefix` / `@slash`) |
| `/command list` | `can_list` | List commands with stat buttons (total / slash / prefix) |
| `/command remove` | `can_remove` | Delete by name (re-syncs guild slash commands if needed) |
| `/command edit download` | `can_edit` | Download the `.dream` source file |
| `/command edit upload` | `can_edit` | Upload a new source file (may change prefix ↔ slash) |

### Create example

```
/command create name:boom code:<file> level:0
/command create name:staffping code:<file> level:50
```

### Edit

```
/command edit download name:boom
/command edit upload name:boom code:<file>
```

Changing `@prefix` ↔ `@slash` on upload updates the stored trigger type and re-syncs guild slash commands.

## Invocation

**Prefix**

```
d!boom
d!ban @User reason here
```

**Slash**

```
/meow
/warn target:@User reason:spam
```

## Requirements

- Migration `0012_dream_commands_trigger` (`trigger_type` column)
- Bot must be able to manage guild application commands
- Bot Discord permissions for any actions scripts use
- Hierarchy checks still apply for mod/role actions
