/**
 * Channel-list settings that accept category ids as well as channel ids (a category means every
 * channel in it, including ones created later). The single source of truth: it's exported in
 * `schema/guild-config.meta.json` (`categoryChannelFields`) and the dashboard only lets these
 * fields pick a whole category.
 *
 * Only add a field once its bot-side check matches through `channelInList` (src/core/channelMatch.ts).
 *
 * Paths are `<plugin>.<path inside plugins.<plugin>.config>`; `*` stands for any key or index
 * (automod rule ids, starboard board names).
 */
export const CATEGORY_CHANNEL_FIELDS = [
  // automod/functions/handlers.ts isIgnored / isRuleIgnored
  "automod.ignored_channels",
  "automod.rules.*.ignored_channels",
  // activity_rewards/functions/config.ts isIgnoredChannel
  "activity_rewards.ignored_channels",
  // feedback/eligibility.ts checkFeedbackEligibility (reviews + suggestions)
  "reviews.ignored_channels",
  "suggestions.ignored_channels",
  "suggestions.command_channels",
  // starboard/functions/starboard.ts processBoard
  "starboard.ignored_channels",
  "starboard.boards.*.ignored_channels",
  // music/functions/limits.ts musicChannelBlock
  "music.allowed_voice_channels",
  "music.allowed_text_channels",
  // team_control/functions/tasks.ts countStaffMessage
  "team_control.activity.staff_channel_ids",
  // translation/functions/autoTranslate.ts isIgnoredChannel
  "translation.ignored_channels",
  // characters/functions/triggers.ts channelAllowed
  "characters.allowed_channels",
  "characters.blocked_channels",
  // slowmode/functions/rules.ts ruleAppliesToChannel
  "slowmode.rules.*.channels",
  // Single "listens in" channel per rule (a filter, not a destination): a category rule covers
  // every channel in it. autoreactions / autoreplies / autothreads handlers.ts, autodelete config.ts
  "autoreactions.rules.*.channel_id",
  "autoreplies.rules.*.channel_id",
  "autothreads.rules.*.channel_id",
  "autodelete.rules.*.channel_id",
] as const;

export type CategoryChannelField = (typeof CATEGORY_CHANNEL_FIELDS)[number];
