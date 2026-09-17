# Incident Response plugin

Correlates signals from [Automod](automod.md) (including its raid detector), [Impersonation Detection](impersonation.md), [Scam Protect](scam_protect.md), and Incident Response's own built-in server-nuke detectors into scored **incidents** — one entity (a member or a channel), scored and tracked over time, instead of a scattered stream of separate alerts. High-severity incidents can trigger automatic lockdowns or punishments, with an opt-in policy per severity tier.

## How it works

1. Each source plugin reports a **signal** when it trips — an Automod rule hit, a raid burst, an Impersonation Detection match, a Scam Protect trip, or one of the built-in nuke detectors (mass channel/role deletes, mass bans/kicks, webhook bursts, or Administrator granted to a very new account).
2. Signals about the same entity (member or channel) within the `correlation_window_ms` window are merged into one incident, rather than creating a new one each time.
3. Every signal carries a weight — a raid burst or a nuke signal weighs far more than a single low-severity Automod rule, and signals spanning **2 or more distinct sources** add a correlation bonus, since combined evidence from different systems is worse news than any one alone.
4. The incident's total risk score is compared against your `thresholds` to determine severity: Low (below `medium`), Medium, High, or Critical.
5. The first time an incident reaches a severity tier, that tier's `policy_*` actions run (if any) and its `notify_roles` are pinged in the incident alert. Actions include timing out, kicking, softbanning, or banning the member, and locking down a channel or the whole server.
6. A channel or server lockdown denies **Send Messages** for `@everyone`, remembering the exact previous permission state so unlocking restores it correctly instead of guessing. Lockdowns auto-unlock after `lockdown_duration_ms` (0 = manual unlock only) or via `/incident unlock`.
7. Staff review, resolve, or dismiss incidents from Discord (`/incident`) or the dashboard.

## Configuration

```yaml
plugins:
  incident_response:
    enabled: true
    config:
      log_channel_id: ""
      correlation_window_ms: 1800000
      thresholds:
        medium: 6
        high: 14
        critical: 26
      sources:
        automod: true
        raid: true
        impersonation: true
        scam_protect: true
        nuke_detection: true
      nuke:
        channel_delete_count: 3
        channel_delete_window_ms: 30000
        role_delete_count: 3
        role_delete_window_ms: 30000
        ban_count: 5
        ban_window_ms: 60000
        kick_count: 5
        kick_window_ms: 60000
        webhook_count: 3
        webhook_window_ms: 60000
        admin_grant_new_account_hours: 72
      policy_low:
        actions: []
        notify_roles: []
      policy_medium:
        actions: []
        notify_roles: []
      policy_high:
        actions: []
        notify_roles: []
      policy_critical:
        actions: []
        notify_roles: []
```

### General

| Field | Description |
|-------|-------------|
| `log_channel_id` | Channel incident alerts post to. Falls back to the server moderation log channel when unset. |
| `correlation_window_ms` | Signals about the same person/channel/server within this window merge into one incident. |
| `thresholds.medium` / `high` / `critical` | Risk score needed to reach each severity tier. Below `medium` is Low. |
| `sources.*` | Which signal sources feed Incident Response — turn any of them off to stop it correlating that source's alerts. |
| `nuke.*` | Thresholds for the built-in server-nuke detectors (mass channel/role deletes, mass bans/kicks, webhook bursts) and how new an account must be for a surprise Administrator grant to be flagged. |

### Severity policies

Each of `policy_low`, `policy_medium`, `policy_high`, and `policy_critical` has:

| Field | Description |
|-------|-------------|
| `actions` | Punitive/lockdown actions to run the **first time** an incident reaches this severity. Empty = alert only. |
| `notify_roles` | Roles pinged in the incident alert when this severity is first reached. |

Each action in `actions` has:

| Field | Description |
|-------|-------------|
| `type` | `timeout`, `kick`, `softban`, `ban`, `lockdown_channel`, or `lockdown_server`. |
| `duration_ms` | Timeout duration. Only used by `timeout`. |
| `delete_message_days` | Days of messages to delete (0-7). Only used by `softban`/`ban`. |
| `lockdown_duration_ms` | How long the lockdown lasts before auto-unlocking (0 = manual unlock only). Only used by the lockdown actions. |

Policies are opt-in — leave `actions` empty on any tier you only want to be alerted about, not acted on automatically.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/incident list [status]` | `can_manage` | List incidents, optionally filtered by status (defaults to open) |
| `/incident view <id>` | `can_manage` | View one incident's entity, severity, signal count, actions taken, and age |
| `/incident resolve <id>` | `can_manage` | Mark an incident resolved (action taken) |
| `/incident dismiss <id>` | `can_manage` | Mark an incident dismissed (false positive) |
| `/incident unlock <channel>` | `can_manage` | Manually unlock a channel Incident Response locked |

Grant `can_manage` to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) —
see [permissions.md](../permissions.md).

## Dashboard

The dashboard's **Incidents** page (nested under Incident Response) lists and filters incidents the same way `/incident list` does, with the same view/resolve/dismiss actions available from the UI.

## Requirements

- The bot needs **Manage Channels** to lock and unlock channels.
- Timeout/kick/softban/ban actions need the matching Discord permission (**Moderate Members**, **Kick Members**, or **Ban Members**).
- Feeding a source in requires that source's own plugin to be enabled — e.g. `sources.raid` only has anything to correlate if Automod's raid detector is active.

## Setup

1. Enable Incident Response and set `log_channel_id` (or rely on the moderation log channel).
2. Leave the default `thresholds` and signal weights as a starting point, or tune them once you've seen a few incidents.
3. For each severity tier you want to act on automatically, add one or more actions under that tier's `policy_*` and set `notify_roles`.
4. Review incoming incidents with `/incident list` or the dashboard, and resolve or dismiss them as you triage.
