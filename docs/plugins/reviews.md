# Reviews plugin

Collect star ratings and written feedback about your server with `/review`. Reviews are stored in the database, can post to a public channel, and appear in the dashboard under **Feedback → Reviews**.

## Configuration

```yaml
plugins:
  reviews:
    enabled: true
    config:
      review_channel_id: "1234567890123456789"
      min_messages: 50
      min_account_age: "7d"
      min_member_age: "3d"
      cooldown: "7d"
      allow_edit: true
      allowed_roles: []
      blocked_roles: []
      ignored_channels: []
      anonymous: false
      require_text: true
      min_text_length: 20
      max_text_length: 1000
      min_rating: 1
      max_rating: 5
```

| Field | Description |
|-------|-------------|
| `review_channel_id` | Optional channel where public review embeds are posted |
| `min_messages` | Minimum guild messages tracked by Dreamliner before someone can review (`0` disables) |
| `min_account_age` | Minimum Discord account age (`7d`, `30d`, …). Empty string disables |
| `min_member_age` | Minimum time in this server before reviewing. Empty string disables |
| `cooldown` | Wait time between reviews or edits per user. Empty string disables |
| `allow_edit` | When `true`, members can update an existing review instead of submitting only once |
| `allowed_roles` | If non-empty, only members with one of these roles may submit |
| `blocked_roles` | Members with any of these roles cannot submit |
| `ignored_channels` | Channel IDs where `/review` is refused |
| `anonymous` | When `true`, public embeds hide the author. Staff and the dashboard still see them |
| `require_text` | Require a written comment with the rating |
| `min_text_length` / `max_text_length` | Comment length bounds |
| `min_rating` / `max_rating` | Allowed star range (1-5) |

Set `enabled: false` on the plugin section to turn reviews off without removing your settings.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/review submit` | `can_review` | Open a modal for stars and an optional comment |
| `/review list` | `can_list` | List recent reviews (optional `rating` / `user` filters) |
| `/review delete` | `can_delete` | Soft-delete a review by ID |
| `/review stats` | `can_list` | Show average rating and total count |

Grant `can_review` to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) — the
built-in **Member** role is a good place for it. Grant `can_list`, `can_delete`, and `can_manage` to your
**Moderator**/**Admin** roles. See [permissions.md](../permissions.md).

## Behavior

- Submissions use a Discord modal (star rating plus text when required).
- If `allow_edit` is on and the member already has a review, submitting again updates it (subject to cooldown).
- If `review_channel_id` is set, Dreamliner posts or updates a public embed there.
- Soft-deleted reviews leave the public channel post and disappear from normal lists and stats.
- Message-count eligibility uses Dreamliner’s tracked guild messages, so brand-new servers may need time before members qualify.

## Dashboard

- **Feedback → Reviews** (data): browse ratings, comments, and authors.
- **Feedback → Reviews** (plugin settings): edit the fields above from the dashboard.

## Requirements

- The bot needs **Send Messages** and **Embed Links** in `review_channel_id` if you use a public channel.
- Members need access to a channel where slash commands work (and that channel must not be in `ignored_channels`).

## Setup

1. Create a `#reviews` channel (optional) and copy its ID.
2. Open the dashboard with `/config`.
3. Set `plugins.reviews.config.review_channel_id` and adjust eligibility fields as needed, then Save.
4. Members use `/review submit`; staff use `/review list`, `/review delete`, and `/review stats`.
