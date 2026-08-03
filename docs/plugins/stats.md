# Stats plugin

View detailed activity statistics for the server, a user, or a channel — including activity graphs and trend analysis.

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
| `/stats server [days]` | `can_server` | Server activity graph + analysis |
| `/stats user [user] [days]` | `can_user` | User message graph + rank/share |
| `/stats channel [channel] [days]` | `can_channel` | Channel activity graph + share |

`days` can be `7`, `14` (default), or `30`.

### What you get

- **Activity graph** (PNG) for the selected window
- Averages, peak day, active days, busiest weekday
- Trend vs the earlier half of the window (up / down / stable)
- Server: joins/leaves + net change, top messagers, top channels
- User: lifetime totals, server share, rank among active messagers
- Channel: stats-tracked totals plus currently retained log rows

## Data collection

Dreamliner records:

- Guild daily totals: messages, joins, leaves
- Per-user daily message counts
- Per-channel daily message counts
- Lifetime message counters (utility plugin)

Days use **UTC** date boundaries.

## Notes

- Historical graphs only cover days since Dreamliner started tracking that dimension.
- Per-user / per-channel daily series began with the stats graphing update; older lifetime totals still appear in overview fields.
- Channel “retained in logs” depends on the logs plugin and its retention window.
