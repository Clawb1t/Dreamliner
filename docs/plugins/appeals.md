# Appeals plugin

Let punished users ask staff to take another look. A user opens the server's appeal page at
`https://dreamliner.site/server/<guild id>/appeals`, signs in with Discord, picks one of the infractions
on file for them (or a **manual appeal** if the server allows it), and fills in a form the server built.
The appeal goes to a Discord review channel with **Approve**, **Deny** and **Needs info** buttons. It
can also be browsed and decided on the dashboard's **View Appeals** page.

Banned users aren't members, so nothing on the appeal page requires being in the server. The bot only
needs to still be in it.

Appeals is free and is turned on per server like every other plugin.

## How an appeal moves

```
pending ──► approved          (punishment lifted, if the type's auto_reverse is on)
   │  ▲ ──► denied            (cooldown starts)
   ▼  │
needs_info  (staff asked a question; the user answers on their appeal page)

pending / needs_info ──► withdrawn   (by the user)
```

- **Approve** opens a modal with an optional note and a **Lift the punishment** checkbox, pre-ticked
  from the type's `auto_reverse`. Lifting does one of the following:
  - **Ban, tempban, or a manual appeal:** unbans the user, if they're still banned, and records an
    `unban` case.
  - **Mute or tempmute:** removes the timeout and records an `unmute` case.
  - **Warn, kick or softban:** revokes the case, marking it inactive.

  The result ("Unbanned", or "Couldn't unban: missing Ban Members") is saved on the appeal and shown
  to reviewers.
- **Deny** asks for a reason. It's required when `review.require_deny_reason` is on, and is sent to the
  user.
- **Needs info** asks the user a question. They answer on their appeal page, which puts the appeal
  back to pending and updates the review message.
- **Note** (in Discord, or "Add note" on the dashboard) adds a staff-only note to the appeal's
  timeline, and posts it in the appeal's discussion thread when there is one. The user never sees
  notes. It stays available after a decision.
- Lifting needs the same power as lifting it directly: Ban Members or the Infractions unban
  permission for bans, Moderate Members or the mute permission for timeouts, and Moderate Members
  or the warn permission to revoke a case (Manage Server always can). Without it, untick
  **Lift the punishment** to approve without changing anything.
- Nobody can decide, question, or add notes to their own appeal. Staff looking at their own
  appeal on the dashboard don't see the staff notes about it.
- Decisions are atomic. If two staff members decide at once, the first one wins and the second is told
  it was already decided.

Each decision DMs the user (if `decisions.dm_user` is on) with a link to their appeal page. When an
approval unbans someone and `decisions.invite_on_unban` is on, the DM also carries a single-use, 24h
invite back.

## Appeal button on infraction DMs

When the plugin is on, `dm_button.enabled` is set and the infraction type is appealable, the DMs that
`/warn`, `/mute`, `/kick`, `/ban`, `/tempban`, `/softban` and Automod send carry an **Appeal** link
button. It opens the appeal page with that case already picked.

Ban and kick DMs are sent **before** the action, while the bot still shares a server with the user, so
they actually arrive. If the action then fails, the case is removed again.

## Who can appeal what

An infraction is appealable when all of the following hold:

- its type is enabled under `types`;
- `min_wait` has passed since it was issued;
- it's still inside its `window`;
- it hasn't already been appealed `limits.max_per_case` times;
- there's no open appeal for it;
- no denied appeal for it is still inside `limits.deny_cooldown`;
- it's active, or the type has `allow_inactive`. Kicks and softbans are one-off, so they never count as
  inactive.

The page shows every case with the reason it can't be appealed yet, e.g. "Appealable in 2 days".

A user can't appeal at all if they:
- are in `limits.blocked_users`;
- have a role in `limits.blocked_roles` (only checked while they're still in the server);
- have an account younger than `limits.min_account_age`;
- already have `limits.max_open_per_user` appeals waiting.

**Manual appeals** (`manual.enabled`) cover punishments with no case on file, such as a ban made by
hand or by another bot. With `manual.require_ban` on, only users who really are banned can file one.

## Forms

Up to 10 forms, each with up to 20 questions. Each infraction type, and manual appeals, picks a form
with `form_id`; an empty `form_id` uses the first form. Forms are filled in on the website, so they can
use:
- text, short or paragraph, with `min_length` and `max_length`;
- single-choice selects and radio groups;
- checkbox groups;
- a single checkbox, e.g. "I've read the rules";
- text blocks.

Every answer is checked again on the bot before the appeal is saved.

## Autopilot

The **Autopilot** button on the Appeals page sets the whole plugin up from a short conversation:
- the review channel and ping roles;
- which punishments can be appealed, when, and whether approving lifts them;
- manual appeals;
- complete appeal forms with their questions;
- limits, decision DMs, the page copy and look, and the Appeal button on punishment DMs.

Anything not discussed is left as it is. Forms work differently: when Autopilot writes forms, they
replace the existing ones, and each punishment type is pointed at one of them. Blocked users and
uploaded backgrounds are still set by hand. The result fills in the page, ready to review and
save. The wizard is `appeals_setup` (bot: `src/core/ai/wizards/appeals.ts`).

## Configuration

Dashboard-managed: everything below is edited on the **Appeals** page of the website's config editor,
which has a live preview of the public page.

```yaml
plugins:
  appeals:
    enabled: true
    config:
      accepting: true                 # pause new appeals without losing the setup
      page:
        headline: "Appeal a punishment in {guild}"
        body: "Sign in with Discord to see what's on file for you…"
        guidelines: ""                # markdown, shown above the form
        inherit_accent: true          # use the server's public accent color
        background: none              # none | color | url (https only) | asset (uploaded) | guild_banner
        background_asset_id: ""       # set by the dashboard's upload button
        show_moderator: false         # keep staff anonymous to appellants
        show_case_reason: true
        link_on_server_page: true     # "Appeal a punishment" link on /server/<id>
      types:
        ban:      { enabled: true, form_id: "", min_wait: "", window: "", allow_inactive: false, auto_reverse: true }
        tempban:  { enabled: true }
        softban:  { enabled: false }
        kick:     { enabled: false }
        mute:     { enabled: true }
        tempmute: { enabled: true }
        warn:     { enabled: true, min_wait: "24h", window: "90d" }
      manual:
        enabled: false
        require_ban: true
        label: "Something else"
      forms:
        - id: "00000000-0000-4000-8000-0000000a9fe1"
          name: "Appeal form"
          questions: [ … ]
      limits:
        max_per_case: 2
        deny_cooldown: "30d"
        max_open_per_user: 1
        min_account_age: ""
        blocked_users: []
        blocked_roles: []
      review:
        channel_id: "123456789012345678"
        ping_roles: []
        thread: true                  # a discussion thread per appeal
        require_deny_reason: true
        show_history: true            # list the user's other cases and appeals
      decisions:
        dm_user: true
        approve_message: "Your appeal in **{guild}** was approved. {lifted}"
        deny_message: "Your appeal in **{guild}** was denied."
        needs_info_message: "The staff team in **{guild}** has a question about your appeal…"
        invite_on_unban: true
        invite_channel_id: ""
      dm_button:
        enabled: true
        label: "Appeal"
```

Durations use `30m`, `24h`, `7d` or `2w`; an empty string means none.

The decision messages support `{user}`, `{guild}`, `{case}`, `{type}`, `{reason}` and `{link}`; the
approve message also supports `{lifted}`, which describes what was lifted.

## Permissions

| Flag | Grants |
|------|--------|
| `can_review` | Approve, deny, or ask for more info (Discord buttons and the dashboard) |
| `can_view` | Read the dashboard's View Appeals page |

Both are granted to the built-in Moderator role by default. Server managers (Manage Server) can always
view and decide.

## Uploaded backgrounds

The dashboard can upload a PNG, JPEG or WebP (up to 4MB) as the page background. The bot
decodes and re-encodes it as a PNG at most 2000px wide, stores it under
`data/guild-assets/<guild>/appeals/`, keeps the 10 newest per server, and serves it publicly at
`/api/appeals/<guild>/background/<asset id>` (appellants are often banned, so it can't require
membership).

## Rate limits

Submitting, replying and withdrawing are limited to 5 a minute per user on the bot, on top of the
website's per-IP limits and the bridge's per-user limits (see `src/bridge/rateLimit.ts`).

## Logs

Appeal events go to the Logs plugin under **Appeals**: `appeal_submitted`, `appeal_approved`,
`appeal_denied`, `appeal_info`, and `appeal_reversal_failed` (an approval whose unban or untimeout
failed).

## Other places appeals show up

- The dashboard's **Cases** modal lists the appeals filed against a case.
- A public case page (`/case/<token>`) shows an **Appeal this case** button when the case type is
  appealable.
- The server's public page shows an **Appeal a punishment** link when `page.link_on_server_page` is on.
- Appeals you filed or reviewed are included in your data export. Like cases, they stay with the server
  when you erase your account.
