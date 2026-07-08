# Reaction roles plugin

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

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/reactionrole create` | `can_create` | Map an emoji reaction on a message to a role |
| `/reactionrole delete` | `can_delete` | Remove a reaction-role mapping |

## Requirements

- The bot needs **Manage Roles** and **Add Reactions**.
- The bot's highest role must be above assigned roles.
- Dreamliner adds the configured reaction to the target message when a mapping is created.
