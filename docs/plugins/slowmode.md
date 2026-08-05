# Slowmode plugin

Manage Discord’s native **channel** slowmode, plus bot-enforced **individual** slowmode for specific users or roles (for example VIP at 2s while members are at 6s).

## Configuration

```yaml
plugins:
  slowmode:
    enabled: true
    config:
      default_seconds: 5
      individual_enabled: true
      allow_manage_messages_bypass: true
      individual_default_seconds: 0
      rules:
        - id: 1
          target: role
          target_id: "VIP_ROLE_ID"
          seconds: 2
          channels: ["*"]
        - id: 2
          target: role
          target_id: "MEMBER_ROLE_ID"
          seconds: 6
          channels: ["*"]
    overrides:
      - level: ">=50"
        config:
          can_set: true
          can_clear: true
          can_manage_rules: true
          can_configure: true
```

| Field | Description |
|-------|-------------|
| `default_seconds` | Fallback for Discord `/slowmode set` when no value is provided |
| `individual_enabled` | Master switch for per-user/role slowmode enforcement |
| `allow_manage_messages_bypass` | When `true` (default), members with **Manage Messages** skip individual slowmode. When `false`, nobody bypasses |
| `individual_default_seconds` | Delay applied when no user/role rule matches (`0` = no limit) |
| `rules` | List of individual rules (`target`, `target_id`, `seconds`, `channels`) |

### How individual delay is chosen

1. Bots are never limited.
2. If `allow_manage_messages_bypass` is on and the member has **Manage Messages** in that channel, they skip individual slowmode.
3. A **user** rule for that channel wins over role rules.
4. Among matching **role** rules, the **lowest** delay wins (VIP 2s beats member 6s).
5. If nothing matches, `individual_default_seconds` is used (`0` means off).

### Enforcement

- Timer starts from the **last allowed message’s send time** + rule delay (not from when the bot processes it).
- The next message inside that window is deleted; only then does the `slowmode` emoji appear on the allowed message.
- Violations do **not** reset or extend the timer.
- When the emoji disappears, the cooldown is cleared — you can send again.
- A background sweeper drops expired slots/reactions so nothing stays blocked after the window ends.

If you are testing as staff: with `allow_manage_messages_bypass: true` (default), **Manage Messages** skips individual slowmode — use `/slowmode bypass enabled:false` to enforce on everyone.

Native Discord channel slowmode and individual rules can both apply. A common setup is channel slowmode off, with tiered individual rules.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/slowmode set` | `can_set` + Manage Channels | Set Discord channel slowmode (0–21600 seconds) |
| `/slowmode clear` | `can_clear` + Manage Channels | Remove Discord channel slowmode |
| `/slowmode status` | `can_set` | Show channel + individual slowmode summary |
| `/slowmode rule add` | `can_manage_rules` | Open a form to add a user/role rule |
| `/slowmode rule remove` | `can_manage_rules` | Remove a rule by ID |
| `/slowmode rule list` | `can_manage_rules` | List rules and key settings |
| `/slowmode check` | `can_manage_rules` | Show effective delay for a member in a channel |
| `/slowmode bypass` | `can_configure` | Toggle Manage Messages bypass |
| `/slowmode individual` | `can_configure` | Enable/disable individual mode and set default delay |

## Requirements

- For Discord channel `/slowmode set|clear`, the bot and the invoker need **Manage Channels**.
- For individual enforcement, the bot needs **Manage Messages** (delete violations), **Add Reactions**, and **Read Message History** (marker emoji).
- Individual delays must be between 1 and 21600 seconds (6 hours). Channel slowmode allows 0–21600.
