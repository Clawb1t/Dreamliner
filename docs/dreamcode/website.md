# Dreamcode website editor contract

This document is the integration guide for building a Dreamcode creation tool on the Dreamliner site. The Discord bot and the website **must share the same language surface**.

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

## Recommended editor UX

1. **Block / line editor** that emits Dreamcode text (not a separate IR). The bot stores **source text**.
2. **Action palette** grouped by `category`, filtered by search on `key` + `description`.
3. **Insert action** → generate a line:
   - Positional: `ban {user}`
   - Named: `mute {user} duration: 10m reason: "spam"`
4. **Variable / context picker** inserting paths from [context.md](./context.md) (`invoker.level`, `arg.user`, …).
5. **Live validate** by running the same parser rules (or calling a future `/api/dreamcode/validate` that wraps `compileDreamcode`).
6. **Examples gallery** from [examples.md](./examples.md).
7. **Danger cues**: highlight `mutates: true` actions; warn for `lockdown`, `ban`, `clean`, etc.

## Validation rules the site should mirror

Before allowing save/publish:

1. Source parses (balanced `if`/`else`/`end`, strings closed).
2. Every action key exists in the catalog.
3. Required params present (positional or named).
4. No unknown named args.
5. File size under 32 KB (bot limit).
6. Command name: `^[a-z0-9_]{1,32}$`.

Optional (runtime-only, cannot fully validate on site): Discord hierarchy, bot permissions, entity existence.

## Runtime model (for preview docs)

```
prefix + name + args  →  MessageCreate
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

## What the website must NOT invent

Do not invent action keys that are not in `ACTION_DEFS`. Add them in the bot first, regenerate the catalog, then ship UI.

Do not expose:

- Guild config upload / permissions grants
- Creating/removing Dreamcode commands from inside Dreamcode
- Cross-guild data
- Arbitrary JavaScript

## Versioning

Bump `actions.catalog.json` → `version` when you make breaking param renames. Prefer additive changes (new actions, new optional named params).

## Shipping checklist

- [ ] Action added to `ACTION_DEFS`
- [ ] Host implements key in `createDiscordActionHost`
- [ ] `npm run dreamcode:export`
- [ ] Docs updated (`actions.md` summary + examples if user-facing)
- [ ] Site loads new catalog
- [ ] Validate sample scripts with `compileDreamcode`
