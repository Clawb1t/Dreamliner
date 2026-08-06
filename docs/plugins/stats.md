# Stats plugin

Browse detailed activity statistics through an interactive dashboard — similar to `/help` — with category menus, multiple chart types per area, and trend analysis.

## Configuration

```yaml
plugins:
  stats:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_server: true
          can_user: true
          can_channel: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/stats server [days]` | `can_server` | Server analytics dashboard |
| `/stats user [user] [days]` | `can_user` | User analytics dashboard |
| `/stats channel [channel] [days]` | `can_channel` | Channel analytics dashboard |

`days` can be `7`, `14` (default), `30`, or `0` (all time — every recorded day since tracking began).

## Interactive dashboard

Each stats view opens a **home overview** with menus to explore:

- **Category select** — switch between data areas (Overview, Activity, Membership, Engagement, Leaderboards for servers; Activity and Patterns for users/channels)
- **Time window select** — change the analysis window (7 / 14 / 30 UTC days, or all time)
- **Home** — return to the overview
- **Chart navigation** — Previous / Next chart buttons when a category has multiple graphs

### Server categories

| Category | Charts |
|----------|--------|
| Overview | Summary metrics, engagement totals, top lists |
| Activity | Messages line · messages bar · weekday distribution |
| Membership | Joins/leaves line · net change bar · active users line |
| Engagement | Edits/deletes/reactions line · attachments bar · engagement pie |
| Leaderboards | Top users leaderboard · top channels leaderboard · all-time users leaderboard |

### User / channel categories

| Category | Charts |
|----------|--------|
| Overview | Lifetime totals, rank/share, analysis |
| Activity | Daily bar · daily line · weekday distribution |
| Patterns | Weekday bar · traffic share pie |

## Data collection

Dreamliner records:

- Guild daily totals: messages, joins, leaves, edits, deletes, reactions, attachments
- Per-user daily message counts
- Per-channel daily message counts
- Lifetime message counters (utility plugin)
- Derived metrics at query time: averages, peaks, weekday patterns, trends, rankings, active users per day

Days use **UTC** date boundaries.

## Notes

- Historical graphs only cover days since Dreamliner started tracking that dimension.
- Engagement metrics (edits, deletes, reactions, attachments) begin after the stats engagement update.
- Channel “retained in logs” depends on the logs plugin and its retention window.
- Run `npm run db:migrate` after updating to apply the engagement columns migration.
