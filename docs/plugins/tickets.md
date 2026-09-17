# Tickets plugin

Support ticket panels, categories, staff claiming, escalation, and transcripts. Panels, categories, and their behavior are configured entirely from the **dashboard**; Discord commands handle day-to-day ticket management.

## How it works

1. From the dashboard, build one or more **panels** — a message (plain text and/or an embed) posted to a channel, showing one or more **categories** as buttons (max 5) or a select menu (max 25).
2. A member opens a ticket by clicking a category. If the category has form questions configured, they answer those first in a modal; the answers are included in the ticket.
3. Dreamliner creates a private channel or thread (per the category's `mode`) named from `naming_pattern`, posts the welcome message, and optionally pings `ping_role_ids` (then deletes that ping message).
4. Staff (from the category's `support_role_ids`, or the plugin-wide `staff_role_ids` when empty) claim, assign, reply, and manage the ticket. An **escalation** ladder can ping a role, alert another channel, bump priority, or auto-close a ticket after a set number of minutes without a staff reply.
5. Closing a ticket generates a transcript, which is posted to `transcript_channel_id` (falling back to `default_transcript_channel_id`) and/or DMed to the opener, and can request feedback (a rating) if enabled.

## Configuration

```yaml
plugins:
  tickets:
    enabled: true
    config:
      staff_role_ids: []
      log_channel_id: ""
      default_transcript_channel_id: ""
      dm_transcript_on_close: true
      feedback_enabled: false
      max_open_tickets_per_user: 1
      blacklist_notify: true
      panels: []
```

### Plugin-wide settings

| Field | Description |
|-------|-------------|
| `staff_role_ids` | Support staff roles, used as the fallback when a category has no `support_role_ids` of its own. |
| `log_channel_id` | Channel for ticket open/claim/close event logs. |
| `default_transcript_channel_id` | Default transcript channel when a category has no override. |
| `dm_transcript_on_close` | DM the opener their transcript when the ticket closes. |
| `feedback_enabled` | Plugin-wide default: DM the opener a rating request after close. |
| `max_open_tickets_per_user` | Default limit on how many tickets one member may have open at once. |
| `blacklist_notify` | Tell blacklisted members why their ticket attempt was blocked. |
| `panels` | Ticket panels for this server — build and edit these from the dashboard, not by hand. |

### Panel fields

| Field | Description |
|-------|-------------|
| `name` | Dashboard-only label for this panel. |
| `enabled` | Turn this panel on or off without deleting it. |
| `channel_id` | Channel the panel message is posted in. |
| `style` | `buttons` (max 5 categories) or `select` (max 25 categories). |
| `content` / `embed` | The panel message's optional text and embed. |
| `categories` | The panel's categories (see below), 1-25. |

### Category fields

| Field | Description |
|-------|-------------|
| `label` / `description` / `emoji` / `button_style` | How the category appears on the panel. |
| `category_channel_id` | Discord channel category new ticket channels are created under. |
| `mode` | Open tickets as a private `channel` or a private `thread`. |
| `naming_pattern` | Channel/thread name pattern. Supports `{number}`, `{username}`, `{category}`. |
| `welcome_message` | Message posted in the new ticket. Supports `{user}`, `{guild}`, `{category}`, plus each question's answer as `{answer_1}`, `{answer_2}`, ... |
| `support_role_ids` / `ping_role_ids` | Roles that can see/reply, and roles pinged (then unpinned) when a ticket opens. |
| `form_questions` | Up to 5 questions asked in a modal before the ticket opens. |
| `max_open_per_user` | Per-user open-ticket limit for this category. `0` disables new tickets. Empty uses the plugin-wide limit. |
| `auto_close_hours` | Auto-close after this many hours of opener inactivity. `0` disables. |
| `escalation` | SLA ladder — up to 10 steps, each firing after N minutes of staff silence (see below). |
| `close_permission` | Who may close tickets from this category: `opener`, `staff`, or `either`. |
| `require_close_reason` | Require a reason when closing a ticket. |
| `transcript_channel_id` | Transcript channel override for this category. |
| `feedback_enabled` | Per-category override for the plugin-wide feedback setting. |

### Escalation steps

| Field | Description |
|-------|-------------|
| `after_minutes` | Trigger this step after this many minutes without a staff reply (or since the ticket opened, if staff never replied). |
| `action` | `ping_role`, `notify_channel`, `set_priority`, or `close`. |
| `role_id` / `channel_id` / `priority` | Used by the matching action type. |
| `message` | Optional note appended to the ping/alert. |

Escalation re-arms whenever staff reply again.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/ticket new` | — | Open a ticket (only when the server has exactly one panel with exactly one category and no form questions — otherwise use the panel buttons/menu) |
| `/ticket close [reason]` | `close_permission` on the category (opener/staff/either) | Close the ticket in this channel |
| `/ticket claim` / `unclaim` | `can_claim` | Claim or unclaim the ticket in this channel |
| `/ticket assign <user>` / `unassign` | `can_assign` | Assign or unassign the ticket to another member |
| `/ticket status set <status>` | `can_set_status` | Set the ticket's status (Open, In Progress, Awaiting Response, Awaiting Further Information, On Hold) |
| `/ticket add <user>` / `remove <user>` | `can_add_remove_members` | Add or remove a member from the ticket |
| `/ticket rename <name>` | `can_manage_panels` | Rename the ticket's channel |
| `/ticket priority <level>` | `can_claim` | Set the ticket's priority (low/medium/high/urgent) |
| `/ticket transcript` | — | DM yourself the ticket's latest transcript (posts to the log channel instead if your DMs are closed) |
| `/ticket stats [member] [days]` | `can_view_stats` | Ticket handler performance stats — closed count, average resolution time, average first-response time |
| `/ticket blacklist <target> [reason]` | `can_blacklist` | Block a member from opening tickets |

Also available: `can_reopen` (reopen closed tickets), `can_view_all` (view any ticket, not just ones you're part of), and `can_delete` (permanently delete tickets) — used by the dashboard's ticket view rather than a dedicated slash command.

Grant these to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) — see [permissions.md](../permissions.md).

## Dashboard

**Support → Tickets** is where panels and categories are built and edited, and where the **View Tickets** page shows every open/closed ticket with claim, assign, status, and delete actions.

## Requirements

- The bot needs **Manage Channels** (create ticket channels) and, for thread-mode categories, permission to create private threads.
- `category_channel_id` must be set on every category so ticket channels have somewhere to be created.

## Setup

1. Open the dashboard's **Support → Tickets** page and create a panel: pick a channel, a style (buttons or select), and an embed/message.
2. Add at least one category: set its ticket-channel category, naming pattern, welcome message, support roles, and optionally form questions and an escalation ladder.
3. Save — Dreamliner posts (or reposts) the panel message.
4. Grant the staff-facing permissions above to your support roles.
