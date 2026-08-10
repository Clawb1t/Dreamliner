# Automod

Dreamliner’s Automod watches messages (and join bursts), awards points per hit, and runs one or more actions from a per-rule escalation ladder. Actions can create real moderation cases through the infractions system.

Automod is **off by default**. Enable it in the dashboard and **Save** before anything applies.

## Setup (dashboard)

1. Open the guild dashboard → **Automod**.
2. Turn the plugin **Enabled**, then click **Save** in the sidebar (same as other plugins).
3. Optionally apply a preset (**Light** / **Standard** / **Strict**). Presets update the editor only until you Save.
4. Open **Configure** on any filter to set:
   1. **Trigger** — thresholds / custom words / blocked domains  
   2. **Actions** — one or more actions on the first hit (delete, warn, timeout, kick, softban, tempban, ban, staff note)  
   3. **Escalation** — extra steps after more points in a rolling window  
   4. **Exceptions** — channels and roles this rule should skip  
5. Set server-wide ignores under **Settings**, then Save.

Changes in the Automod UI are not live until you press **Save**.

## Server settings

| Setting | What it does |
| --- | --- |
| **Ignored channels** | Automod never runs in these channels (snowflake picker). |
| **Ignored roles** | Members with any of these roles bypass Automod. |
| **Ignore above level** | Members at this permission level or higher are ignored. Leave blank to disable. Uses the guild **Levels** map. |
| **Log channel** | Optional channel for Automod hit logs. Falls back to the server moderation log channel. |
| **DM members on warn** | Default for warn DMs when a rule does not set its own notify toggle. |

## Configuring a rule

### Trigger

Each rule has its own detector settings, for example:

- Spam: messages allowed + time window  
- Caps: percent + minimum length  
- Links: link count + optional always-blocked domains  
- Custom filters: your own words, phrases, or regex patterns  
- Raid: join count + join window  

Built-in packs (profanity, slurs, invites, `@everyone` / `@here`) need no numeric thresholds. In the dashboard, **Profanity**, **Excessive swearing**, and **Slur detection** include a **View built-in word list** control so you can see exactly which terms are matched (not editable there; add extras under Custom filters).

Word-pack matching is fuzzy: leetspeak (`sh1t`, `a$$`), spacing/punctuation (`F - UCK`, `f.u.c.k`), and elongation (`fuuuuck`) are normalized before compare. Innocent words like `classic` / `assessment` are not matched as `ass`.

### Actions (multi-select)

On the first trigger you can enable **any combination** of:

| Action | Notes |
| --- | --- |
| **Delete message** | Removes the offending message. |
| **Warn** | Creates a warn case. |
| **Timeout** | Discord timeout; set duration in minutes. |
| **Kick** | Kicks the member. |
| **Softban** | Ban then unban; optional delete history days (0–7). |
| **Tempban** | Temporary ban; set hours + optional delete history days. |
| **Ban** | Permanent ban; optional delete history days. |
| **Staff note** | Internal note case only. |

If no punishment actions are selected, Automod only logs (optionally with delete).

Shared rule options:

| Option | What it does |
| --- | --- |
| **Points per hit** | Each trigger adds this many points toward escalation (default `1`). |
| **Case points** | Optional points stored on case metadata (defaults to points per hit). |
| **Case reason** | Optional reason override on created cases. |
| **DM the member** | Notify them when a case action runs. |

### Escalation

Hits are counted per user **per rule** in a rolling window (`strike_window_ms`, shown as minutes in the UI).

Score used for the ladder:

```text
score = hitCount × points_per_hit
```

Each ladder step has an **after N points** threshold and its own multi-action set. The highest matching step runs (not every step below it).

### Per-rule exceptions

In addition to server defaults, a rule can ignore specific channels and roles.

## Rules catalog

### Content filters

| Rule | Description |
| --- | --- |
| Profanity | Built-in swear word pack |
| Slur detection | Hate-speech / slur terms |
| Excessive swearing | Many swears in one message |
| Custom filters | Your words, phrases, and regex (replaces Censor) |

### Spam & noise

| Rule | Description |
| --- | --- |
| Spam | Too many messages in a short window |
| Emoji spam | Too many emoji / emotes |
| Duplicate messages | Same user repeating the same message |
| Copypasta | Same text pasted across the server |
| Sticker & GIF spam | Rapid stickers / GIFs |
| Attachment spam | Rapid file uploads |
| Newline spam | Excessive line breaks |
| Wall of text | Extremely long messages |
| Repeated characters | Floods like `aaaaaaa` |

### Mentions & links

| Rule | Description |
| --- | --- |
| Mass mentions | Too many unique user mentions |
| @everyone / @here | Unauthorized everyone/here pings |
| Invite links | Discord invite links |
| Link spam | Too many links, or blocked domains |

### Presentation

| Rule | Description |
| --- | --- |
| Excessive caps | High % of capital letters |
| Zalgo / obfuscation | Abuse of combining marks |

### Join protection

| Rule | Description |
| --- | --- |
| Raid detection | Burst of member joins |

## Presets

| Preset | Intent |
| --- | --- |
| **Light** | Few rules, lenient thresholds, light punishments |
| **Standard** | Balanced coverage for most servers |
| **Strict** | More rules, stricter thresholds, faster escalation |

Custom filter entries are preserved when you re-apply a preset.

## Discord commands

- `/automod status` — overview (includes ignore above level)
- `/automod test` — dry-run sample text against content rules (uses **saved** config)
- `/automod preset` — apply Light / Standard / Strict
- `/automod toggle` — enable/disable a rule
- `/automod filters list|add|remove` — manage custom filter entries
- `/automod ignore-channel` / `ignore-role` — server-wide bypasses

Dashboard **Test a message** also uses the last saved bot config.

## How hits become cases

1. A detector matches (unless the channel/role/level is ignored).  
2. A hit is stored in `automod_hits`.  
3. Recent hits in the rule’s window become a **score** (`hits × points`).  
4. The matching ladder step’s **actions** run (can be several at once).  
5. Case-creating actions call the infractions system and post case logs.  
6. An Automod moderation log entry is sent (rule log channel or server mod log).

Case metadata includes `source: "automod"`, `ruleId`, `hitCount`, `points`, and `score`.

## Permissions

Base `can_*` flags (prefer granting via Overrides / levels):

- `can_status` — check Automod status  
- `can_test` — run Automod tests  
- `can_configure` — configure Automod in Discord  

## Migration

- Legacy automod (`enabled_rules`, global `action`, etc.) is converted on config load.
- Former **Censor** rules (`censor_rules` + `plugins.censor`) are imported into Automod → **Custom filters**.
