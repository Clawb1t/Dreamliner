# Suggestions plugin

Community suggestion queue with staff review, persistent vote buttons, display statuses, blocks, and dashboard triage. Inspired by common Discord suggestion bots, stored in Dreamliner’s database so votes and queue state survive restarts.

## Modes

| Mode | Behavior |
|------|----------|
| `review` (default) | Submissions go to `review_channel_id` with Approve / Deny controls first |
| `autoapprove` | Submissions post straight to `suggestions_channel_id` with vote buttons |

## Configuration

```yaml
plugins:
  suggestions:
    enabled: true
    config:
      mode: review
      suggestions_channel_id: "1234567890123456789"
      review_channel_id: "9876543210987654321"
      denied_channel_id: ""
      archive_channel_id: ""
      log_channel_id: ""
      allowed_suggest_roles: []
      blocked_suggest_roles: []
      allowed_vote_roles: []
      review_ping_role: ""
      feed_ping_role: ""
      approved_role: ""
      implemented_role: ""
      anonymous: false
      cooldown: "1h"
      max_open: 5
      min_messages: 25
      min_account_age: "7d"
      min_member_age: "1d"
      command_channels: []
      ignored_channels: []
      allow_attachments: true
      min_length: 15
      max_length: 1000
      voting_enabled: true
      upvote_label: Upvote
      midvote_label: Neutral
      downvote_label: Downvote
      upvote_emoji: "👍"
      midvote_emoji: "😐"
      downvote_emoji: "👎"
      mid_vote_enabled: true
      allow_self_vote: false
      show_vote_count: true
      color_change_threshold: 10
      color_change_color: 5763719
      notify_author: true
      follow_on_upvote: true
```

### Channels and roles

| Field | Description |
|-------|-------------|
| `suggestions_channel_id` | Public feed for approved suggestions (required for posting) |
| `review_channel_id` | Staff queue channel (required in `review` mode) |
| `denied_channel_id` | Optional channel for denied suggestion posts |
| `archive_channel_id` | Optional archive when a suggestion is marked implemented |
| `log_channel_id` | Optional channel for staff action logs |
| `review_ping_role` | Role pinged when a suggestion enters the review queue |
| `feed_ping_role` | Role pinged when a suggestion is posted to the feed |
| `approved_role` | Optional role granted to the author on approve |
| `implemented_role` | Optional role granted when marked implemented |

### Eligibility and content

| Field | Description |
|-------|-------------|
| `allowed_suggest_roles` | If non-empty, only these roles may submit |
| `blocked_suggest_roles` | Roles that cannot submit |
| `allowed_vote_roles` | If non-empty, only these roles may vote |
| `anonymous` | Allow anonymous submissions (staff still see the author) |
| `cooldown` | Wait between submissions per user. Empty string disables |
| `max_open` | Max open approved (not implemented) suggestions per user. `0` = unlimited |
| `min_messages` | Minimum tracked guild messages before suggesting |
| `min_account_age` / `min_member_age` | Age gates. Empty string disables |
| `command_channels` | If non-empty, `/suggest` may only be used in these channels |
| `ignored_channels` | Channels where suggestion commands are refused |
| `allow_attachments` | Allow image attachments on suggestions |
| `min_length` / `max_length` | Suggestion text length bounds |

### Voting and notifications

| Field | Description |
|-------|-------------|
| `voting_enabled` | Show vote buttons on approved feed posts |
| `upvote_label` / `midvote_label` / `downvote_label` | Button labels |
| `upvote_emoji` / `midvote_emoji` / `downvote_emoji` | Button emojis |
| `mid_vote_enabled` | Include a neutral mid vote button |
| `allow_self_vote` | Allow authors to vote on their own suggestion |
| `show_vote_count` | Show live vote totals on the vote buttons |
| `color_change_threshold` | Net upvotes needed to recolor the embed. `0` disables |
| `color_change_color` | Embed color (decimal 0-16777215) once the threshold is met |
| `notify_author` | DM the author on approve, deny, and mark when possible |
| `follow_on_upvote` | Auto-follow a suggestion when a member upvotes it |

Set `enabled: false` on the plugin section to turn suggestions off without removing your settings.

## Commands

### Members

| Command | Permission | Description |
|---------|------------|-------------|
| `/suggest` | `can_suggest` | Open the suggestion form (`anonymous` option when enabled) |
| `/suggestion info` | `can_info` | Show a suggestion by number |
| `/suggestion top` | `can_top` | Top or bottom suggestions by votes |
| `/suggestion follow add` / `remove` / `list` | `can_follow` | Follow suggestions for update DMs |

### Staff

| Command | Permission | Description |
|---------|------------|-------------|
| `/suggestion approve` | `can_approve` | Approve a queued suggestion |
| `/suggestion deny` | `can_deny` | Deny with an optional public reason |
| `/suggestion silentdeny` | `can_deny` | Deny without notifying the author |
| `/suggestion dupe` | `can_deny` | Deny as a duplicate of another suggestion |
| `/suggestion mark` | `can_mark` | Set display status (see below) |
| `/suggestion delete` / `silentdelete` | `can_delete` | Remove a suggestion |
| `/suggestion queue` | `can_manage` | List suggestions awaiting review |
| `/suggestion massapprove` / `massdeny` | `can_manage` | Act on multiple IDs at once |
| `/suggestion search` | `can_info` | Search by text, number, status, or author |
| `/suggestion block` / `unblock` / `blocklist` | `can_block` | Block users from suggesting (optional duration) |

Grant `can_suggest`, `can_vote`, `can_follow`, `can_info`, and `can_top` to a Dreamliner Role on the dashboard's
**Roles** page (or `/permissions role grant`) to open member-facing commands — the built-in **Member** role is
a good place for these. Grant `can_approve`, `can_deny`, `can_mark`, `can_delete`, `can_block`, and `can_manage`
to your **Moderator**/**Admin** roles for the staff commands. See [permissions.md](../permissions.md).

## Voting

Approved suggestions get persistent Discord buttons. Votes are stored in SQLite and survive bot restarts. Changing your vote replaces the previous value. Configure labels, mid-vote, self-vote, role allowlists, and color thresholds in plugin config.

## Display statuses

Use `/suggestion mark` after approval:

| Value | Label |
|-------|-------|
| `none` | None |
| `considered` | In consideration |
| `progress` | In progress |
| `implemented` | Implemented |
| `no` | Not happening |

Marking **implemented** can move the post to `archive_channel_id` and optionally grant `implemented_role`.

## Dashboard

**Feedback → Suggestions** shows Queue / Approved / Denied with approve, deny, mark, and delete actions. Plugin settings live under **Feedback → Suggestions** on the dashboard.

## Requirements

- The bot needs **Send Messages**, **Embed Links**, and permission to use components in the feed and review channels.
- In `review` mode, both `suggestions_channel_id` and `review_channel_id` should be set.
- Message-count eligibility uses Dreamliner’s tracked guild messages.

## Setup

1. Create `#suggestions` and, for review mode, `#suggestion-review` channels.
2. Open the dashboard with `/config`.
3. Set `mode`, channel IDs, and eligibility fields under `plugins.suggestions.config`, then Save.
4. Members use `/suggest`. Staff triage in Discord or on the dashboard.
