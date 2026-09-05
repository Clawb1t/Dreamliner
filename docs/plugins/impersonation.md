# Impersonation Detection

Lives in the Automod hub alongside Automod, Scam Protect, and Autodelete. Tracks every
member's username, display name, nickname, and avatar over time, and flags anyone whose
identity closely matches a protected role holder or a manually pinned watchlist entry.
Built for catching staff impersonation (a scammer copying a moderator's name and avatar to
DM members) and copycat/ban-evasion joins.

Off by default. Enable it in the dashboard's Automod hub and configure at least one
**Protected role** (or a watchlist entry) for it to have anything to compare against.

## How detection works

On a relevant identity change (join, username/display name/nickname/avatar update), the
member's new identity is compared against every currently protected identity:

- **Protected roles** — anyone currently holding a role you list under **Protected roles**.
  This is the easiest way to protect your whole staff team at once, no per-person setup.
- **Watchlist** — manually pinned identities from the dashboard or `/impersonation watchlist
  add`, either a real member (kept live-synced — no need to re-add if they change their own
  name/avatar) or a manual name/image with no real account behind it (protecting a persona,
  not a person).

Two checks run independently — either one alone can trigger a match:

- **Name similarity**: usernames and display names are normalized (case, accents, common
  lookalike Unicode characters like Cyrillic а/е/о/р swapped for Latin, zero-width
  characters stripped) and compared with edit distance, scored 0-100%. Catches
  "Moder@tor_" copying "Moderator" just as well as a byte-for-byte Cyrillic swap.
- **Avatar similarity**: a 64-bit perceptual fingerprint (pHash) of the avatar image, same
  technique as Automod's Image Scanning rule. Catches the same profile picture even after
  it's been recompressed or lightly cropped.

A member who themself holds a protected role, or any role in **Ignored roles**, is never
flagged (comparing staff against each other creates noise, not signal).

## Settings

| Setting | What it does |
| --- | --- |
| **Protected roles** | Members holding these roles are the identities everyone else gets compared against. |
| **Ignored roles** | These members are never flagged, even if they'd otherwise match. |
| **Compare scope** | `protected_only` (recommended) checks only against protected roles + watchlist. `everyone` also compares every member against every other member — thorough, but slower and noisier; capped internally at 2,000 comparisons per check as a safety limit. |
| **Checks** | Independently toggle join / username / display name / nickname / avatar checks. |
| **Name similarity threshold** | 0-100%; how close a name needs to be to count as a match. |
| **Avatar max distance** | 0-64; how close a pHash fingerprint needs to be (0 = identical). |
| **Log channel** | Where alerts post. Falls back to the server moderation log. |
| **Notify staff** | Post an alert card to the log channel on a match. |
| **DM flagged member** | Off by default — tips the person off, which isn't always what you want. |
| **Auto action** | `none` (just alert), `timeout`, `kick`, or `ban` the flagged member automatically. |

## The watchlist

Manage from the dashboard (richer: image upload, avatar preview) or in Discord:

- `/impersonation watchlist add label:<text> member:<user>` — pin a real member; their
  current name/avatar is looked up live at check time, so it's never stale.
- `/impersonation watchlist add label:<text> name:<text> image:<attachment>` — protect a
  manual identity with no real account (a persona, a partner brand, etc.).
- `/impersonation watchlist remove id:<id>` / `/impersonation watchlist list`

## Alerts

Every match is recorded, whether or not an auto action ran, so a `none` auto-action setup
still gives staff a queue to work through:

- Dashboard: a live feed with side-by-side avatar comparison, similarity scores, and
  one-click **Resolve** (action taken) / **Dismiss** (false positive) / jump-to-member.
- Discord: `/impersonation alerts list`, `/impersonation alerts resolve id:<id>`,
  `/impersonation alerts dismiss id:<id>`.

## Identity history

Every tracked change (join, username, display name, nickname, avatar) is logged
independently of whether it ever matched anything — a standalone "has this person changed
their identity before, and to what" record:

- Dashboard: look up any member to see their full timeline.
- Discord: `/impersonation history member:<user>`.

## Test tool

The dashboard has a **Test an identity** tool: pick a real member, or type a manual
name/upload an image, and it runs the exact same matching pipeline live detection uses
without creating an alert or taking any action — useful for sanity-checking thresholds and
watchlist entries before relying on them.

## Discord commands

- `/impersonation status` — current configuration
- `/impersonation history` — a member's identity change history
- `/impersonation watchlist add|remove|list`
- `/impersonation alerts list|resolve|dismiss`

## Permissions

Base `can_*` flags — grant them to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`), see [permissions.md](../permissions.md):

- `can_status` — check status and view alerts/history
- `can_configure` — configure settings in Discord
- `can_manage_watchlist` — add/remove watchlist entries
