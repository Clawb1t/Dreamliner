# Switch to Dreamliner

Switch moves a server's setup from MEE6, Dyno, YAGPDB, Carl-bot, Arcane, ProBot or Tatsu to Dreamliner. None of them can export their settings, so Switch reads them the way you see them: you screenshot each page of your old dashboard, and Autopilot sets up the matching Dreamliner feature for you to review.

Open it from your server's dashboard: **Server → Switch**.

## How it works

1. **Pick your old bot.** Switch lists only the parts of its dashboard it can bring over, using the same names that bot's dashboard uses.
2. **Import a part.** Switch tells you which page to open. Screenshot it (up to 4 screenshots if it doesn't fit), paste or drop them in, and press **Read with Autopilot**.
3. **Check what it found.** Autopilot lists every setting it read. Fix anything it got wrong.
4. **Import.** Switch opens the matching Dreamliner page and runs that page's Autopilot with your settings, including ignored channels and roles, word lists, limits, punishments, embeds and buttons. Lists (rules, roles, tags, milestones) come over in one go; for pages that hold one item per run (a board, a panel, a sticky), press **Import next** until they're all in.
5. **Save.** Nothing goes live until you save with the bar at the bottom of the dashboard.

A whole switch uses **one Autopilot use**, however many pages you import in the next 6 hours.

## What comes over

| MEE6 | Dreamliner |
|------|------------|
| Welcome & Goodbye | Welcomer and Autorole |
| Reaction Roles | Role panels |
| Moderator | Automod |
| Levels | Activity Rewards (see below) |
| Starboards | Starboard |
| Custom Commands | Tags |
| Ticketing | Tickets |
| Automations | Autoreplies |
| Achievements | Activity Rewards |
| Statistics Channels | Counters |
| Temporary Channels | Companion channels |
| Giveaways | Giveaways |

| Dyno | Dreamliner |
|------|------------|
| Automod | Automod |
| Slowmode | Slowmode |
| Autoresponder | Autoreplies |
| Auto Delete, Auto Purge | Autodelete |
| Welcome, Announcements | Welcomer |
| Autoroles | Autorole |
| Reaction Roles | Role panels |
| Levels | Activity Rewards |
| Starboard | Starboard |
| Giveaways | Giveaways |
| Tickets | Tickets |
| Custom Commands, Tags | Tags |

| YAGPDB | Dreamliner |
|--------|------------|
| Custom Commands | Autoreplies |
| Basic and Advanced Automoderator | Automod |
| Verification | Passport |
| Notifications (General) | Welcomer |
| Autorole | Autorole |
| Role Commands | Role panels |
| Ticket System | Tickets |

| Carl-bot | Dreamliner |
|----------|------------|
| Automod | Automod |
| Reaction roles | Role panels |
| Autoroles | Autorole |
| Tags | Tags |
| Triggers | Autoreplies |
| Greetings | Welcomer |
| Starboard | Starboard |
| Suggestions | Suggestions |
| Levels | Activity Rewards |
| Sticky Messages | Persist |
| Auto Purge | Autodelete |

| Arcane | Dreamliner |
|--------|------------|
| Leveling (role rewards, level-up message, No XP roles and channels) | Activity Rewards |
| Welcomer/Goodbye | Welcomer and Autorole |
| Role Management | Role panels and Autorole |
| Moderation | Automod |
| Custom Commands | Tags |
| Auto Responders | Autoreplies |
| Counters | Counters |

| ProBot | Dreamliner |
|--------|------------|
| Welcome & Goodbye | Welcomer |
| Auto Roles | Autorole |
| Self-Assignable Roles | Role panels |
| Leveling System | Activity Rewards |
| Auto Responder | Autoreplies |
| Starboard | Starboard |
| Temporary Channels | Companion channels |
| Statistics | Counters |
| Tickets | Tickets |
| Automod | Automod |

| Tatsu | Dreamliner |
|-------|------------|
| Leveled Roles | Activity Rewards |
| Greeting Messages | Welcomer |
| Reaction Roles | Role panels |
| Auto role | Autorole |

Variables in messages from any of these bots (like `{user.mention}`, `{{.User.Mention}}` or `[user]`) are rewritten to Dreamliner's placeholders.

Only MEE6 member levels carry over automatically (see below). For the other levelling bots, your level roles become milestones and members earn them again as they chat.

## MEE6 Levels

Dreamliner rewards activity by messages instead of XP. Switch reads MEE6's public leaderboard and:

- carries every ranked member's progress over, at about 20 XP per message (the same pace MEE6 uses), so nobody starts over
- turns each MEE6 level role into an Activity Rewards milestone at the matching number of messages

Your MEE6 leaderboard must be public: in MEE6, open **Levels** and turn on **Make my server's leaderboard public**. You can make it private again afterwards. Large servers take a minute, and the import can run once an hour.

After you save, members get their roles as they chat, or right away with `/rewards sync`.

## Finishing up

- Turn off the same features in your old bot while you test, so members don't get two welcomes.
- Remove the old bot when you're happy, and cancel any subscription on their website. Removing the bot doesn't cancel it.

MEE6, Dyno, YAGPDB, Carl-bot, Arcane, ProBot and Tatsu are trademarks of their respective owners. Dreamliner is not affiliated with, endorsed by, or sponsored by any of them.
