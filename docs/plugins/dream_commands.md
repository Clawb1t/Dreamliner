# Dreamcode commands plugin

Custom message commands written in **Dreamcode**. Default trigger prefix: `d!`.

Full language + website integration docs: [../dreamcode/README.md](../dreamcode/README.md)

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
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `prefix` | Case-sensitive message prefix (default `d!`) |

### Who can run a command?

Each stored command has `min_level`. Invoker’s Dreamliner level must be **≥** that value. No separate `can_run` flag.

## Slash commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/command create` | `can_create` | Upload `.dream`/`.txt`, set name + min level |
| `/command list` | `can_list` | List name, level, preview |
| `/command remove` | `can_remove` | Delete by name |

Create validates with `compileDreamcode` (max ~32KB). Names: `a-z0-9_`, 1–32 chars.

## Invocation

```
d!boom
d!ban @User reason here
```

Flow: prefix match → load command → level check → build context → interpret → Discord host actions.

Failures: ❌ low level, ⏳ rate limit, or a short `Dreamcode error:` reply.

## Capability surface

Dreamcode can drive moderation, messaging, roles, voice, cases, tags, counters, reminders, posts, logging, and lookups — see [../dreamcode/actions.md](../dreamcode/actions.md) (~77 actions). Not exposed: guild config ACL, plugin toggles, or scripting the `/command` manager itself.

## Requirements

- SQLite table `dream_commands` (migration `0011_dream_commands`)
- Bot Discord permissions for any actions scripts use
- Hierarchy checks still apply for mod/role actions
- v1: no `/command edit` (remove + recreate)
