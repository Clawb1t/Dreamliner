# Dreamcode

Dreamcode is Dreamliner’s **guild-scoped scripting language** for custom message commands (default prefix `d!`).

Staff upload scripts with `/command create`, choosing **prefix** (`d!name`) or **guild slash** (`/name`, max 10 per server). Names are unique across both types. Edit source anytime with `/command edit download|upload`. Scripts can moderate, message, manage roles, move voice users, read cases, update counters, schedule reminders/posts, and more — anything exposed in the action catalog, contained to the current server.

## Documentation map

| Doc | Audience | Contents |
|-----|----------|----------|
| [language.md](./language.md) | Authors + site | Full grammar, control flow, returns, limits |
| [context.md](./context.md) | Authors + site | Built-in globals & object shapes |
| [actions.md](./actions.md) | Authors + site | Human catalog of every action |
| [actions.catalog.json](./actions.catalog.json) | **Website** | Machine-readable `ACTION_DEFS` export |
| [website.md](./website.md) | **Website engineers** | Editor contract, validation, UX |
| [examples.md](./examples.md) | Authors | Copy-paste scripts |
| [errors.md](./errors.md) | Authors + site | Parse / validate / runtime errors |
| [../plugins/dream_commands.md](../plugins/dream_commands.md) | Admins | Prefix, levels, `/command` ops |

## Quick start

`boom.dream`:

```dream
@prefix
reply "💥"
```

```
/command create name:boom code:<file> level:0
```

```
d!boom
```

Slash with typed / no args:

```dream
@slash
@slash noargs
@slash description "Says meow"
reply "🐱"
```

```
/command create name:meow code:<file> level:0
```


## Architecture (bot)

- Language core: `src/dreamcode/` (parse → validate → interpret)
- Discord host: `src/plugins/dream_commands/functions/host.ts`
- Storage: SQLite `dream_commands` table
- Catalog export: `npm run dreamcode:export`

## Design rules

1. Guild-contained only  
2. No JS / eval / filesystem / arbitrary network  
3. Per-command `min_level` gate  
4. Validate on create (`compileDreamcode`)  
5. Hierarchy + bot Discord permissions still apply for mod/role actions  
6. Website authors the **same source text** the bot stores
