# Member identity plugin

Saves a member's server identity when they leave (and optionally while they are still in the server) so chosen parts can be restored when they rejoin. Configure it on the dashboard or in guild YAML.

Dreamliner stores nickname, role IDs, and timeout expiry. Guild avatars and banners belong to the user account and cannot be restored.

## Identity cards

`/identity [user]` replies (only to you) with a link to that member's identity card on the website, `/identity/<serverId>/<userId>`. The card shows what is saved (nickname, roles, timeout, last saved time) and, for each part, whether it would come back on rejoin under the server's current settings, with the reason when it would not (deleted role, role above Dreamliner, managed role, restore turned off, missing permission). Anyone currently in the server can open anyone's card for that server; people outside the server see nothing.

## Configuration

```yaml
plugins:
  member_identity:
    enabled: true
    config:
      save_on_leave: true
      save_on_update: true
      restore_nickname: true
      restore_roles: true
      restore_timeout: false
      skip_managed_roles: true
      ignore_bots: true
      ignored_roles: []
      delay_ms: 0
```

| Field | Description |
|-------|-------------|
| `save_on_leave` | Snapshot identity when the member leaves |
| `save_on_update` | Keep the snapshot current on nickname, role, or timeout changes. Recommended so incomplete leave payloads still restore correctly |
| `restore_nickname` | Reapply the saved server nickname on rejoin |
| `restore_roles` | Reapply saved roles on rejoin. Roles are **added**; autorole and other join roles are not stripped |
| `restore_timeout` | Reapply a remaining timeout if it had not expired when they left (requires Moderate Members). Off by default |
| `skip_managed_roles` | Skip Discord-managed roles (integrations, bots, boost) |
| `ignore_bots` | Do not save or restore bot accounts |
| `ignored_roles` | Role IDs that are never restored even if they were saved |
| `delay_ms` | Wait after join before restoring (`0` = immediately). Max 5 minutes |

Set `enabled: false` on the plugin section to turn the plugin off without deleting stored snapshots.

## Requirements

- The bot needs **Manage Roles** to restore roles, and its highest role must be **above** every role it should reapply.
- The bot needs **Manage Nicknames** to restore nicknames.
- Timeout restore also needs **Moderate Members**.
- Unassignable, deleted, ignored, and (when enabled) managed roles are skipped.

## How it works with Autorole

Member Identity adds persisted roles on top of whatever Autorole assigns. It does not remove other roles. If you do not want a specific role restored (for example a one-time welcome role), add it to `ignored_roles`.
