# Booster Roles plugin

Reward server boosters with different roles depending on how long they've been continuously
boosting the server — e.g. a role at 1 month, another at 3 months, another at 1 year.

## Configuration

Dashboard-managed, like Autodelete and Persist — configure tiers on the website's config editor.

```yaml
plugins:
  booster_roles:
    enabled: true
    config:
      stacking: false
      tiers:
        - enabled: true
          name: "Booster"
          role_id: "123456789012345678"
          duration_days: 0
        - enabled: true
          name: "Booster (3 months)"
          role_id: "234567890123456789"
          duration_days: 90
        - enabled: true
          name: "Booster (1 year)"
          role_id: "345678901234567890"
          duration_days: 365
```

| Field | Description |
|-------|-------------|
| `stacking` | If `true`, boosters keep every tier role they've earned. If `false` (default), only the highest tier they currently qualify for is kept — lower tier roles are removed as they move up. |
| `tiers` | List of tiers (see below) |
| `enabled` | Turn a tier on/off without deleting it |
| `name` | Optional label shown in the dashboard and `/booster roles` |
| `role_id` | Role granted once a booster reaches this tier's duration |
| `duration_days` | Continuous boosting days required to earn this tier (`0` = immediately on boosting) |

Grant `can_view` and `can_recheck` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md). Both are granted to the
built-in **Member** role by default, so every member can use these commands out of the box.

## Commands

| Command | Permission | Description |
|---------|------------|--------------|
| `/booster roles` | `can_view` | List configured tiers, and how close you are to each one |
| `/booster recheck` | `can_recheck` | Immediately recheck your own boost duration against the tiers and apply any role change |

## Behavior

- Boost duration is measured from Discord's `premiumSince` timestamp — how long the member has
  been *continuously* boosting. Un-boosting and re-boosting resets it.
- When a member starts or stops boosting, their tier roles are updated immediately.
- Because tier eligibility also changes just from time passing, the bot re-checks every currently
  boosting member across all guilds with this plugin enabled every 15 minutes.
- A member who stops boosting loses every tier role from this plugin.

## Requirements

- The bot needs **Manage Roles**, and each tier's role must sit below the bot's highest role.
