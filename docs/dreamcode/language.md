# Dreamcode language reference

Dreamcode is a **line-oriented** language. One statement per line (after stripping comments). The website editor should emit this text format.

## Lexical rules

| Rule | Detail |
|------|--------|
| Encoding | UTF-8 |
| Comments | `#` to end of line |
| Strings | Double quotes `"..."`, escapes `\"` `\\` `\n` `\t` |
| Numbers | Integers like `42` |
| Durations | `10m`, `2s`, `1h`, `1d`, `1w` (also allowed as strings) |
| Identifiers | `[a-zA-Z_][a-zA-Z0-9_]*` |
| Paths | `invoker.level`, `arg.1`, `target.id` |
| Action names | Case-insensitive (`Ban` = `ban`) |
| Variable names | Case-sensitive |

## Trigger directives — `@prefix` / `@slash`

Every command file must declare its trigger type at the **top** (before any statements):

```dream
@prefix
reply "💥"
```

```dream
@slash
@slash description "Says meow"
@slash noargs
reply "🐱"
```

| Directive | Meaning |
|-----------|---------|
| `@prefix` | Message command (`d!name`, configurable prefix) |
| `@slash` | Guild slash command (`/name`, max 10 per server) |

You cannot use both. `/command create` reads this from the file (there is no Discord `type` option).

### Slash properties

After `@slash`, additional lines configure Discord:

```dream
@slash
@slash description "Warn a member"
@slash ephemeral
@slash arg user target "Who to warn" required
@slash arg string reason "Why"
set case = warn arg.target reason: arg.reason
reply "Warned {arg.target.mention}"
```

| Property | Effect |
|----------|--------|
| *(bare)* `@slash` | Declares slash trigger |
| `noargs` | No Discord options at all |
| `ephemeral` | Replies only visible to the invoker |
| `description "…"` | Slash command description (1–100 chars) |
| `arg <type> <name> ["desc"] [required]` | Typed Discord option → `arg.<name>` |

#### Slash arg types

`string`, `integer`, `number`, `boolean`, `user`, `channel`, `role`, `mentionable`, `attachment`

- Access values as `arg.<name>` (e.g. `arg.target`, `arg.reason`).
- First `user` / `role` / `channel` option also fills `arg.user` / `arg.role` / `arg.channel`.
- If you declare **no** `@slash arg` and **no** `noargs`, Discord gets a legacy optional string option named `args` (parsed like prefix args).
- Max 25 typed args. Cannot combine `noargs` with `arg`.

## Statements

### Assignment — `set`

```dream
set name = <expression>
set name = <action> [args...]
```

Examples:

```dream
set target = arg.user
set member = get_member arg.user
set case = ban target reason: "spam"
set n = random 1 10
```

### Abort helpers

```dream
require <expression>    # abort if falsy
error <expression>      # abort with message shown to invoker
```

### Conditionals

```dream
if <condition> then
  # ...
else
  # optional
end
```

`then` is on the same line as `if`. Indentation is cosmetic only.

Conditions may call actions:

```dream
if has_role invoker arg.role then
  reply "You have the role"
end

if not arg.user then
  error "Mention a user"
end
```

### Action statements

```dream
<action> [positional...] [name: value...]
```

Return values are stored in the automatic variable `result`. Prefer `set x = action …` when you need the value.

```dream
ban arg.user reason: arg.rest
reply "Done, case flow used result → {result.id}"
```

## Expressions

### Literals

`true`, `false`, `null`, numbers, strings, durations.

### Paths

Read locals first, then globals. Missing paths → `null` (no throw).

### Operators

| Op | Notes |
|----|-------|
| `==` `!=` | Entities with `.id` compare by id |
| `<` `<=` `>` `>=` | Numeric |
| `and` `or` | Short-circuit |
| `not` | Prefix unary |

### String interpolation

Inside `"..."`:

```dream
reply "Hi {invoker.mention}, level {invoker.level}"
```

Objects stringify as `mention` → `name` → `id`.

### Action calls inside expressions

Allowed in `set`, `require`, `if` conditions, and comparison sides when the next tokens look like arguments (not `.` or comparison ops alone).

```dream
set ok = has_role invoker "123456789012345678"
set len = length arg.rest
```

## Arguments to actions

1. **Positional** — bound left-to-right to the action’s `positional` list.  
2. **Named** — `key: value` after positionals; keys are case-insensitive.

```dream
mute arg.user duration: 10m reason: "chill"
tempban target duration: 1d reason: arg.rest delete_days: 1
```

## Automatic variable `result`

After every action (including lookups), `result` holds the return value (or `null`).

## Falsy values

`null`, `false`, `0`, `""`, empty arrays.

## Runtime limits

| Limit | Default | Meaning |
|-------|---------|---------|
| `maxSteps` | 500 | Statement/expression evaluation ticks |
| `maxDurationMs` | 15000 | Wall clock per run |
| `maxWaitMs` | 10000 | Sum of all `wait` calls |

See `DEFAULT_LIMITS` in code / `limits` in [`actions.catalog.json`](./actions.catalog.json).

## What is forbidden

- Loops / functions / imports (v1)
- JavaScript, `eval`, Node APIs
- Cross-guild operations
- Editing guild YAML / bot permissions from scripts
- Creating/removing Dreamcode commands from scripts

## Grammar sketch (informal)

```
program     := directive* stmt*
directive   := "@prefix" NL
             | "@slash" NL
             | "@slash" slash_prop NL
slash_prop  := "noargs" | "ephemeral" | "description" string
             | "arg" type name [string] ["required"]
stmt        := set | require | error | if | action_stmt
set         := "set" ident "=" rhs
rhs         := action_call | expr
if          := "if" condition "then" NL stmt* ["else" NL stmt*] "end"
action_call := ident arg*
arg         := named | primary
named       := ident ":" primary
expr        := or (comparison / logic as documented)
primary     := string | number | duration | bool | null | path | action_call
path        := ident ("." (ident|number))*
```
