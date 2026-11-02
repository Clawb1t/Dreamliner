# Team Control plugin

Staff management. A server defines a **rank ladder** (lowest first), each rank linked to a Discord
role. Anyone holding a rank role is on the team, at the highest rank they hold. Discord roles stay the
source of truth; Dreamliner keeps what roles can't (when someone joined the team, suspensions, trials).

- **Shifts**: clock in, break, clock out. Breaks don't count. Optional on-duty role and nickname prefix,
  shift types per rank, an on-duty cap, automatic voiding of very short shifts and automatic clock-out
  after `max_hours` (with a DM). Staff on approved LOA can't clock in (`block_on_loa`).
- **Leave**: leave of absence (LOA) or reduced activity (RA). Requests are reviewed with Approve and Deny
  buttons (deny asks for a reason) or approved automatically. The LOA/RA role goes on when leave starts
  and comes off when it ends. Staff on leave are excused from quotas and inactivity alerts.
- **Staff actions**: promotion, demotion, warning, strike, suspension, termination. Promotions and
  demotions swap rank roles; suspensions take the rank roles away and give them back when they end;
  terminations remove rank, duty, LOA, RA and suspended roles. Strikes expire, and strike thresholds can
  notify managers, demote, suspend or terminate. Any action can be voided (it stays on record, and roles
  aren't changed back).
- **Activity and quotas**: per period (weekly, biweekly or monthly, UTC): time on shift, mod actions
  (cases they opened), tickets closed, messages in staff channels and voice time. Each rank can require
  any of these; a member on leave for at least half the period is excused. Members inactive for
  `inactivity_days` get one alert per inactive streak.
- **Roster**: one auto-updating message listing every rank and who's on duty, with Clock in, Break and
  Clock out buttons.
- **Profiles, notes and feedback**: staff profiles (`/team profile` and the **Team profile** user context
  menu), private manager notes, and ratings from members: after a ticket closes (the opener gets a DM
  with 1 to 5 stars) or with `/team rate`. Staff see feedback anonymised; managers see who left it.
- **Onboarding**: a checklist for new staff and an optional trial. When a trial ends, a review with Pass
  (promote one rank), Extend 7 days and Fail (remove from the team) is posted.

## Authority

On top of the `can_*` permissions, an actor can only act on staff ranked **below** them, and can only
promote to ranks below their own. Owners, Administrators and Manage Server holders bypass this (unless
the server turned `admin_bypass` off). Discord's role hierarchy still applies: Dreamliner's role must be
above every rank role, and the actor must be able to give the role themselves. Duty, LOA, RA and
suspended roles are handed out automatically, so they must be below Dreamliner and have no staff
permissions (the dashboard warns when one doesn't qualify).

## Dreamliner One

Free: up to 10 ranks, 3 shift types, 10 checklist items, a 90-day history window in commands and on the
dashboard (data is kept 400 days), and manual reports with `/team report`.

Dreamliner One: up to 25 ranks, 15 shift types, 40 checklist items, unlimited history (kept 3 years),
**points mode** (weighted points per metric with a points quota per rank), **scheduled reports** posted
at the end of every period, and CSV export of activity. A config saved with One-only values stays valid
without One; the extra values are simply ignored.

## Commands

| Command | Who |
| --- | --- |
| `/team shift start [type]` · `break` · `end` | Team members (or `can_shift`) |
| `/team shift status [user]` · `leaderboard [period]` | `can_view_team` or team members |
| `/team leave request <kind> <days> [starts_in_days]` · `status` · `end` | Team members (or `can_request_leave`) |
| `/team leave list` | `can_review_leave` |
| `/team action promote/demote <user> [rank] [reason]` | `can_promote` |
| `/team action warn/strike/suspend/terminate <user> …` · `void <id> <reason>` | `can_discipline` (suspend and terminate ask for confirmation) |
| `/team onboarding view [user]` · `check <user> <item> [done]` | Own checklist; others and `check` need `can_manage` |
| `/team profile [user]` · Team profile (user context menu) | Own profile; others need `can_view_team` |
| `/team roster` | `can_view_team` or team members |
| `/team activity [user] [period]` | Own activity; others need `can_view_team` |
| `/team report [period]` · `note <user> <text>` · `sync` | `can_manage` |
| `/team rate <staff> <rating> [comment]` | `can_rate` |

Built-in Dreamliner Roles: Member gets `can_view_team` and `can_rate`; Admin gets everything else.

## Configuration

Dashboard-managed: the Team Control page on the website covers ranks, every setting below, the roster,
members, shifts, leave, actions, activity and feedback. Autopilot can set it up conversationally
(`team_control_setup`).

```yaml
plugins:
  team_control:
    enabled: true
    config:
      ranks:
        - id: trial
          name: Trial Mod
          role_id: "111111111111111111"
          quota: { shift_hours: 2, mod_actions: 5, tickets: 0, messages: 0, voice_hours: 0 }
          points_quota: 0          # points mode only (Dreamliner One)
        - id: mod
          name: Moderator
          role_id: "222222222222222222"
          quota: { shift_hours: 4, mod_actions: 10, tickets: 0, messages: 0, voice_hours: 0 }
          points_quota: 0
      manager_role_ids: ["333333333333333333"]
      log_channel_id: "444444444444444444"
      shifts:
        enabled: true
        duty_role_id: null
        nickname_prefix: ""        # e.g. "[On duty] " (max 12)
        log_channel_id: null       # falls back to log_channel_id
        types: []                  # [{ id, name, rank_ids: [] }]
        allow_breaks: true
        min_minutes: 5
        max_hours: 12
        max_on_duty: 0             # 0 = no limit
        block_on_loa: true
      leave:
        enabled: true
        loa_role_id: null
        ra_role_id: null
        request_channel_id: null
        log_channel_id: null
        ping_role_id: null         # defaults to manager_role_ids
        require_reason: true
        min_days: 1
        max_days: 60
        cooldown_days: 0
        auto_approve: false
        exempt_from_quota: true
      actions:
        enabled: true
        log_channel_id: null
        announce_channel_id: null
        dm_member: true
        require_reason: true
        suspended_role_id: null
        strike_expiry_days: 90     # 0 = never
        strike_thresholds:
          - { strikes: 3, action: notify, suspend_days: 7 }   # notify | demote | suspend | terminate
      activity:
        enabled: true
        period: weekly             # weekly | biweekly | monthly (UTC)
        week_start: monday         # monday | sunday
        staff_channel_ids: []      # empty = staff messages aren't counted
        inactivity_days: 7         # 0 = off
        report_channel_id: null
        scheduled_reports: false   # Dreamliner One
        points_mode: false         # Dreamliner One
        weights: { shift_hour: 10, mod_action: 2, ticket: 3, message: 0.1, voice_hour: 2 }
      roster: { enabled: false, channel_id: null, show_buttons: true, title: Team roster }
      feedback: { enabled: true, after_ticket: true, direct: true, cooldown_hours: 24, members_only: true, log_channel_id: null }
      onboarding:
        enabled: false
        checklist: []              # [{ id, label, description }]
        trial_rank_id: null        # null = any rank
        trial_days: 14             # 0 = no trial
        review_channel_id: null
        dm_welcome: true
```

Ids for ranks, shift types and checklist items match `^[a-z0-9_-]{1,32}$` and shouldn't change once in
use. Names are up to 50 (ranks) and 40 (shift types) characters, the roster title up to 100.

## Data

Tables (migration `0129_team_control.sql`): `team_members`, `team_shifts`, `team_leave`,
`team_actions`, `team_notes`, `team_feedback`, `team_onboarding`, `team_activity_daily`,
`team_roster_messages`, `team_reports`, `team_inactivity_alerts`, plus an index on `mod_cases`
(`guild_id, mod_id, created_at`). Ticket ratings are also written to `tickets.rating_score`.

Two scheduled tasks, both restart-safe because all state is in the database:
`team-control:tick` (every minute: auto clock-out, leave start and end, suspension end, trial end) and
`team-control:sweep` (every 30 minutes: member sync, roster refresh, inactivity alerts, scheduled
reports, daily retention pruning).

Members can export and erase their Team Control data from the website's privacy page.
