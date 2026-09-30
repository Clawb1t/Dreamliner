# Built-in progression badge art

Progression badges are small icons that sit right after a user's name. They show on the `/rank`
card, the public profile, and every leaderboard on the site.

**Most progression badges are made on the superuser dashboard** (Dashboard → Badges →
Progression badges). There you:
- pick the stat a badge tracks
- add up to ten tiers, each with its own goal and uploaded image
- assign any badge to a user at any tier

Those images are stored in the database, not here.

This folder only holds art for **built-in** badges defined in code
(`BUILT_IN_BADGES` in `src/core/progressionBadges/index.ts`):

| Badge | File | Notes |
|---|---|---|
| `dreamliner_one` | `dreamliner_one.svg` | Only the bot draws this, on `/rank`. The site uses its own bolt glyph. |

A built-in badge is only shown once its art exists here, as `<key>.svg|png|webp|gif`. The folder
is re-scanned every minute.
