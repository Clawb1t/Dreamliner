# Dreamcode examples

Upload with `/command create`. Default prefix `d!`.

---

## Boom — anyone

**level:** `0`

```dream
@prefix
reply "💥"
```

---

## Meow — slash, no args

**type:** `slash` · **level:** `0`

```dream
@slash
@slash noargs
@slash description "Says meow"
reply "🐱"
```

Usage: `/meow` (no arguments option in Discord)

---

## Warn — slash with typed args

**type:** `slash` · **level:** `50`

```dream
@slash
@slash description "Warn a member"
@slash arg user target "Who to warn" required
@slash arg string reason "Reason"
set case = warn arg.target reason: arg.reason
reply "Warned {arg.target.mention}"
```

Usage: `/warn` with Discord user + string options

---

## Dice

**level:** `0`

```dream
@prefix
set n = random 1 6
reply "{invoker.mention} rolled **{n}**"
```

---

## 8-ball

**level:** `0`

```dream
@prefix
require arg.rest
set answer = choose "Yes,No,Maybe,Ask again,Absolutely,No way"
reply "**{arg.rest}** → {answer}"
```

---

## Staff: hierarchy-safe ban

**level:** `50`

```dream
@prefix
set target = get_member arg.user
require target
if target.level >= invoker.level then
  error "You cannot moderate that member"
end
set case = ban target reason: arg.rest
reply "Banned {target.mention} · case `#{case.id}`"
```

Usage: `d!ban @User spam`

---

## Staff: short mute + log

**level:** `50`

```dream
@prefix
set target = arg.user
require target
mute target duration: 10m reason: "chill"
log_mod "Dreamcode mute" "{invoker.mention} muted {target} for 10m"
reply "Timed out {target} for 10 minutes"
```

---

## Softban purge

**level:** `100`

```dream
@prefix
require arg.user
softban arg.user reason: arg.rest delete_days: 1
reply "Softbanned {arg.user}"
```

---

## Clean user spam in channel

**level:** `50`

```dream
@prefix
require arg.user
set out = clean 50 user: arg.user
reply "Deleted {out.deleted} messages (archive `{out.archiveId}`)"
```

---

## Role grant with check

**level:** `50`

```dream
@prefix
require arg.user
require arg.role
if has_role arg.user arg.role then
  error "They already have that role"
end
add_role arg.user arg.role reason: "Dreamcode grant"
reply "Gave {arg.role.mention} to {arg.user.mention}"
```

---

## Toggle role

**level:** `50`

```dream
@prefix
require arg.user
require arg.role
set added = toggle_role arg.user arg.role
if added then
  reply "Added {arg.role.mention}"
else
  reply "Removed {arg.role.mention}"
end
```

---

## Voice move to mentioned channel

**level:** `50`

```dream
@prefix
require arg.user
require arg.channel
voice_move arg.user arg.channel
reply "Moved {arg.user} → {arg.channel}"
```

---

## Case lookup

**level:** `50`

```dream
@prefix
require arg.1
set c = case_get arg.1
require c
reply "Case `#{c.id}` · {c.type} · <@{c.userId}> · {c.reason}"
```

---

## Infraction count gate

**level:** `50`

```dream
@prefix
set target = arg.user
require target
set n = case_count target
if n >= 3 then
  mute target duration: 1h reason: "3+ cases"
  reply "{target} has {n} cases — muted 1h"
else
  warn target reason: arg.rest
  reply "Warned {target} ({n} prior cases)"
end
```

---

## Counter + announce

**level:** `50` (counter must exist)

```dream
@prefix
set v = counter_add events 1
send arg.channel "Event count is now **{v}**"
```

---

## Reminder for self

**level:** `0`

```dream
@prefix
require arg.1
require arg.rest
remind arg.1 arg.rest
reply "I'll remind you in {arg.1}"
```

Usage: `d!remind 30m check the oven`

---

## Schedule announcement

**level:** `100`

```dream
@prefix
require arg.channel
schedule_post arg.channel arg.rest duration: 5m
reply "Scheduled in 5 minutes → {arg.channel}"
delete_trigger
```

---

## Tag broadcast

**level:** `50`

```dream
@prefix
require arg.1
send_tag arg.1 channel: channel
```

---

## Locate member

**level:** `50`

```dream
@prefix
set target = get_member arg.user
require target
set vc = locate target
if vc then
  reply "{target.mention} is in {vc.mention}"
else
  reply "{target.mention} is not in voice"
end
```

---

## Slowmode helper

**level:** `50`

```dream
@prefix
set secs = arg.1
require secs
slowmode secs
reply "Slowmode set to {secs}s"
```

---

## Lock channel briefly

**level:** `100`

```dream
@prefix
lock_channel
reply "Channel locked for 10s…"
wait 10s
unlock_channel
reply "Unlocked"
```
