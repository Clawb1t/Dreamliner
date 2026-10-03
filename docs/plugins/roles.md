# Roles plugin

Give, remove, and list roles on members from slash commands, and set up **if-then role rules** that
swap roles automatically.

## Configuration

```yaml
plugins:
  roles:
    enabled: true
```

Grant `can_give`, `can_remove`, and `can_list` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

## If-then role rules

Rules react to a member's roles. When a member has the rule's roles, the bot gives and removes others.
For example: *if a member has Role A and Role B, take both away and give Role C.* Set them up on the
dashboard's **Roles** page (up to 25 rules).

```yaml
plugins:
  roles:
    enabled: true
    config:
      rules:
        - name: "Promote to Veteran"
          match: all              # all: needs every if_roles role · any: one is enough
          if_roles: ["<role A>", "<role B>"]
          unless_roles: []        # members with any of these are skipped
          give_roles: ["<role C>"]
          remove_roles: []        # extra roles to take away
          remove_matched: true    # also take away the if_roles that triggered it
```

- Rules run whenever a member's roles change, and when someone joins already holding roles.
- Rules can lead into each other (A + B → C, then C → D) and are all worked out together, so a member
  ends up in the final state in one go. Rules that undo each other (A → B and B → A) are detected and
  skipped rather than looping.
- A rule only acts when something would change, so the bot's own role edits never re-trigger it.
- Roles above the bot's highest role, managed roles, and @everyone are left alone. The audit log reason
  names the rule.
- Existing members are only checked when their roles next change.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/roles give` | `can_give` | Give a role to a member |
| `/roles remove` | `can_remove` | Remove a role from a member |
| `/roles list` | `can_list` | List a member's roles |

## Requirements

- The bot needs **Manage Roles**.
- The bot's highest role must be above any role it assigns or removes.
- Managed roles (integrations, bot roles) cannot be changed.
