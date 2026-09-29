# Birthdays

Members set their birthday once with `/birthday set`, and every server with Birthdays on celebrates it
the way its staff chose: an announcement with a wish button, a birthday role, a DM, and more.

Set it up on the dashboard: **Fun → Birthdays**.

## Commands

| Command | Permission | What it does |
|---------|------------|--------------|
| `/birthday set month day [year] [timezone]` | `can_set` | Save your birthday. The year is optional and only used to show ages. The timezone (e.g. `Europe/London`, `GMT+2`) makes it start at your own midnight in servers that use members' timezones. |
| `/birthday remove` | `can_set` | Remove your birthday everywhere. |
| `/birthday view [user]` | `can_view` | See someone's birthday and how long until it. |
| `/birthday upcoming` | `can_view` | The next 10 birthdays in the server. |
| `/birthday privacy celebrate` | `can_set` | Choose whether this server celebrates you. Other servers are unaffected. |
| `/birthday manage set user month day [year]` | `can_manage` | Set a member's birthday for them. |
| `/birthday manage remove user` | `can_manage` | Remove a member's birthday. |

A birthday is stored once per member, not per server, so setting it in one server works everywhere they
share with Dreamliner. `can_set` and `can_view` are granted to the built-in **Member** role and
`can_manage` to **Moderator** by default (see [permissions.md](../permissions.md)).

## What the dashboard sets up

### Announcement
Posted in a channel when a member's birthday starts.

- **Message:** text, an embed and an image card, with the same editor and live preview as the Welcomer.
- **Pings:** the birthday member (optional) and up to 5 roles.
- **Wish button:** (the birthday app emoji by default) members press it to wish the birthday member a happy birthday. Everyone counts once,
  the tally shows on the button (optional), and the birthday member can't wish themselves.
- **Link buttons:** up to 4 next to the wish button (5 without it), e.g. a gift or card page.
- **Reactions:** up to 5 emojis Dreamliner reacts with.
- **Birthday thread:** opens a thread on the announcement for wishes, with a custom name and archive time.
- **Delete later:** removes the announcement after 1 to 168 hours.
- **Send test announcement** posts it as if it were your birthday today (nothing is recorded, no role).

### Birthday role
A role given when the birthday starts and removed automatically after 1 to 168 hours (24 by default).
It must sit below Dreamliner's highest role.

### Birthday DM
A private message to the birthday member, with its own text, embed and card.

### Timing
- **Whose clock:** each member's own timezone (members without one use the server's), or the server's
  timezone for everyone.
- **Server timezone** and the **time of day** birthdays are celebrated (midnight by default).
- **29 February birthdays** are celebrated on 28 February or 1 March in other years.

### Who's celebrated
Only members with certain roles, never members with certain roles, whether ages are shown, and whether
members must include their birth year.

### Upcoming birthdays
How many members have set a birthday, how many opted out, and the next 12 birthdays.

## Placeholders

Everything the Welcomer supports (`{user}`, `{user_display}`, `{guild}`, ...), plus:

| Placeholder | Example |
|-------------|---------|
| `{age}` | `27` (empty without a birth year, or when ages are hidden) |
| `{age_ordinal}` | `27th` |
| `{birthday}` | `14 March` |
| `{birthday_date}` | `14 March 1999` (the year only when ages are shown) |
| `{birthdays_today}` | How many birthdays the server has celebrated in the last day |

## Behaviour

- Each birthday is celebrated once per year per server, even across restarts. If Dreamliner was offline
  when a birthday started, it still celebrates later that same day.
- A member who joins on their birthday is celebrated as soon as they join.
- Members who left the server, opted out, or are filtered by the role settings are skipped.
