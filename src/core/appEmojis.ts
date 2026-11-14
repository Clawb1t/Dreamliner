/**
 * A few of Dreamliner's uploaded application emojis (see app-emojis.txt at the repo root for the
 * full catalog) reused directly in message content rather than through the tone-based
 * success/error/neutral set in core/embeds.ts.
 */
export const APP_EMOJI = {
  globe: "<:icons_globe:1544417296703815710>",
  translate: "<:icons_translate:1544417978261438614>",
  flag: "<:icons_flag:1544417544251772999>",
  /** Animated: shown in front of a character's "is typing…" placeholder. */
  typing: "<a:typing:1561913718978256906>",
  // Team Control: duty statuses, quota marks, checklists and leaderboard places.
  online: "<:icons_online:1544417572152283136>",
  idle: "<:icons_idle:1544417557983797298>",
  offline: "<:icons_offline:1544417569438433332>",
  night: "<:icons_night:1544417359094095913>",
  hourglass: "<:icons_hoursglass:1544417711864549479>",
  pause: "<:icons_pause:1544417366744760380>",
  correct: "<:icons_Correct:1544417199798886530>",
  wrong: "<:icons_Wrong:1544417460638457937>",
  snooze: "<:icons_snooze:1544418203042578473>",
  square: "<:icons_square:1544418208549970101>",
  star: "<:icons_star:1544417435636080741>",
  tada: "<:icons_tada:1544417975472492594>",
  join: "<:icons_join:1544417310780166154>",
  leave: "<:icons_leave:1544417327335088148>",
  first: "<:1_:1570990883984384050>",
  second: "<:icons_2:1544417991813238868>",
  third: "<:icons_3:1544417993449013308>",
} as const;
