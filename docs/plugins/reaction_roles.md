# Reaction roles plugin (legacy)

> **Superseded.** Reaction roles are now configured through the [Role Panels](./role_panels.md)
> dashboard feature — `/reactionrole` has been removed. Mappings created with the old command
> before this change keep working automatically (the bot still reacts/unreacts and grants/revokes
> the role); there is just no way to create new ones via command anymore. To manage reaction roles
> going forward, use Role Panels in the dashboard.

Assign roles when members react to a message. Optionally remove the role when the reaction is removed.

## Configuration

```yaml
plugins:
  reaction_roles:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_delete: true
```

The `can_create`/`can_delete` flags no longer gate anything (there's no command left to gate) —
they're kept only so old configs stay valid.

## Requirements

- The bot needs **Manage Roles** and **Add Reactions**.
- The bot's highest role must be above assigned roles.
