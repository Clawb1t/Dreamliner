# Dreamcode errors

## Phases

| Phase | When | User / site impact |
|-------|------|--------------------|
| **parse** | Lexer/parser | `/command create` rejects; site should block save |
| **validate** | After parse | Same — unknown actions, bad arity |
| **runtime** | While running | Channel reply: `Dreamcode error: …` |
| **abort** | `error` / failed `require` | Channel reply with abort text (not a crash) |

Messages often include `(line L, col C)`.

## Create-time validation (`compileDreamcode`)

Rejects before DB write:

1. Unterminated strings, unexpected characters  
2. Broken `if` / `else` / `end`  
3. Unknown action keys  
4. Unknown named arguments  
5. Missing required parameters  
6. Positional args after named args  
7. Too many positionals  

Does **not** check Discord entity existence, bot permissions, or hierarchy.

## Common create failures

| Message | Fix |
|---------|-----|
| `Unterminated string` | Close `"` on the same line |
| `Expected 'then'` | `if condition then` on one line |
| `Expected 'end'` | Close the `if` |
| `Unknown action '…'` | Use a key from [actions.md](./actions.md) / catalog JSON |
| `Action 'mute' requires 'duration'` | Add `duration: 10m` |
| `Unknown argument '…'` | Check named param names in the catalog |
| `Expected end of line` | One statement per line |

## Common runtime failures

| Message | Cause |
|---------|-------|
| `Required value was missing or empty.` | `require` failed |
| Custom `error "..."` text | Intentional abort |
| `You cannot moderate…` | Hierarchy / self / bot |
| `Bot lacks … permission` | Missing Discord permission |
| `Member not found…` | Left server / bad id |
| `Exceeded max steps / duration` | Script too heavy |
| `Wait budget exceeded` | Too much `wait` |
| `Tag/Counter '…' not found` | Missing prerequisite object |
| `Channel is not a text channel` | Wrong channel type |

## Level / rate reactions (not text errors)

| Reaction | Meaning |
|----------|---------|
| ❌ | Invoker level &lt; command `min_level` |
| ⏳ | Per-user rate limit (~1.5s) |

## Website handling

- Map parse/validate errors to inline markers using `line` / `column` from `DreamcodeError.pos`.  
- Show `phase` to authors (`parse` vs `validate`).  
- Link unknown action keys to the catalog search.  
- Never treat runtime Discord failures as syntax errors.
