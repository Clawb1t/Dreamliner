# Dreamcode website editor contract


## Source of truth

| Asset | Path | Use |
|-------|------|-----|
| Action catalog (code) | `src/dreamcode/actions.ts` → `ACTION_DEFS` | Runtime validation + host dispatch |
| Action catalog (JSON) | [`actions.catalog.json`](./actions.catalog.json) | UI forms, autocomplete, docs generation |
| Compiler | `compileDreamcode(source)` in `src/dreamcode/index.ts` | Validate before save (bot + ideally site) |
| Language docs | [`language.md`](./language.md) | Authoring help panels |
| Context docs | [`context.md`](./context.md) | Variable picker / autocomplete |
| Plugin ops | [`../plugins/dream_commands.md`](../plugins/dream_commands.md) | Prefix, levels, `/command` |

Regenerate the JSON catalog after changing actions:

```bash
npm run dreamcode:export
```

## Catalog JSON shape

```json
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "limits": { "maxSteps": 500, "maxDurationMs": 15000, "maxWaitMs": 10000 },
  "categories": ["messaging", "moderation", "..."],
  "actions": [
    {
      "key": "ban",
      "category": "moderation",
      "description": "...",
      "positional": [{ "name": "user", "required": true, "description": "...", "type": "user" }],
      "named": [{ "name": "reason", "description": "...", "type": "string" }],
      "returns": "case object",
      "mutates": true
    }
  ]
}
```

### Field types for form widgets

| `type` | Suggested widget |
|--------|------------------|
| `string` | Text input / textarea |
| `number` | Number input |
| `boolean` | Toggle |
| `user` | User picker (mention / snowflake) |
| `role` | Role picker |
| `channel` | Channel picker |
| `message` | Message id input |
| `emoji` | Emoji picker |
| `duration` | Duration input (`10m`, `1d`) with helper |
| `any` | Generic expression / text |

## Trigger + slash properties

The site parser must accept top-of-file `@slash` directives only (`@prefix` is an error):

```dream
@slash
@slash noargs
@slash ephemeral
@slash description "Says meow"
@slash arg user target "Who" required
```

Expose `program.trigger` and `program.slash` in the IDE. Trigger type is **not** chosen in Discord `/command create` — it comes from `@slash`.

## Validation rules the site should mirror

Before allowing save/publish:

1. Source parses (balanced `if`/`else`/`end`, strings closed; directives only at top).
2. File declares `@slash` (required for create/upload). `@prefix` is rejected.
3. Every action key exists in the catalog.
4. Required params present (positional or named).
5. No unknown named args.
6. File size under 32 KB (bot limit).
7. Command name: `^[a-z0-9_]{1,32}$`.
8. `@slash description` / arg descriptions length 1–100; unknown properties rejected.

Optional (runtime-only, cannot fully validate on site): Discord hierarchy, bot permissions, entity existence.

## Runtime model (for preview docs)

```
/name + slash options  →  ChatInputCommandInteraction
                       →  min_level check
                       →  build globals (context)
                       →  interpretDreamcode(source, { globals, host })
                       →  host.run(action, boundArgs) → DreamValue
                       →  vars.result = return value
```

Authors can write:

```dream
set target = get_member arg.user
require target
if target.level >= invoker.level then
  error "Cannot moderate that member"
end
set case = ban target reason: arg.rest
reply "Case #{case.id}"
```
