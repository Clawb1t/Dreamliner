export type BuiltInTier = "member" | "moderator" | "admin";

export const BUILT_IN_ROLE_NAMES: Record<BuiltInTier, string> = {
  member: "Member",
  moderator: "Moderator",
  admin: "Admin",
};

/**
 * Every can_* grant key each built-in Dreamliner Role starts with, merged from every plugin's
 * old level-gated defaultOverrides.ts (deleted — see git history). Grant keys are
 * "<pluginKey>.<permission>", matching src/core/permissionCatalog.ts's grantKeyFor().
 */
export const BUILT_IN_ROLE_GRANTS: Record<BuiltInTier, string[]> = {
  // Everyone. Anything that only affects the member themselves, uses content staff already set
  // up, or reads information the member could already see. Nothing here acts on other members,
  // changes server-wide state, records anyone, or reveals staff-only data (bans, cases, name
  // history, whereabouts, anonymous review authors, deleted messages).
  member: [
    // activity_rewards
    "activity_rewards.can_view",
    "activity_rewards.can_sync",
    // booster_roles
    "booster_roles.can_view",
    "booster_roles.can_recheck",
    // counting
    "counting.can_stats",
    // dream_commands
    "dream_commands.can_list",
    // economy
    "economy.can_balance",
    "economy.can_buy_pack",
    "economy.can_daily",
    "economy.can_exchange",
    "economy.can_give",
    "economy.can_sell",
    "economy.can_view",
    // images
    "images.can_use",
    // reminders (a member only ever sees and cancels their own)
    "reminders.can_create",
    "reminders.can_list",
    "reminders.can_cancel",
    // reviews
    "reviews.can_review",
    // roles
    "roles.can_list",
    // stats
    "stats.can_channel",
    "stats.can_server",
    "stats.can_user",
    // suggestions
    "suggestions.can_comment",
    "suggestions.can_follow",
    "suggestions.can_info",
    "suggestions.can_suggest",
    "suggestions.can_top",
    "suggestions.can_vote",
    // tags
    "tags.can_list",
    "tags.can_show",
    // tickets (their own ticket only; closing others' is can_close_others)
    "tickets.can_close",
    // translation
    "translation.can_translate",
    // tts
    "tts.can_speak",
    // music
    "music.can_play",
    "music.can_skip",
    "music.can_manage_playlists",
    // utility (read-only lookups; /context, /source and message info only read the current channel)
    "utility.can_about",
    "utility.can_avatar",
    "utility.can_channelinfo",
    "utility.can_context",
    "utility.can_convert_gif",
    "utility.can_discofy",
    "utility.can_emojiinfo",
    "utility.can_help",
    "utility.can_info",
    "utility.can_inviteinfo",
    "utility.can_jumbo",
    "utility.can_level",
    "utility.can_listening_to",
    "utility.can_messageinfo",
    "utility.can_one",
    "utility.can_ping",
    "utility.can_quote_to_discofy",
    "utility.can_roleinfo",
    "utility.can_roles",
    "utility.can_server",
    "utility.can_snowflake",
    "utility.can_source",
    "utility.can_time",
    "utility.can_userinfo",
  ],

  // Was level >= 25 OR level >= 50.
  moderator: [
    // applications
    "applications.can_review",
    // counting
    "counting.can_reset",
    // bot_customisation
    "bot_customisation.can_avatar",
    "bot_customisation.can_banner",
    "bot_customisation.can_bio",
    "bot_customisation.can_display_name",
    "bot_customisation.can_nickname",
    // dream_commands
    "dream_commands.can_edit",
    "dream_commands.can_remove",
    // giveaways
    "giveaways.can_reroll",
    "giveaways.can_end",
    "giveaways.can_pause",
    // incident_response
    "incident_response.can_manage",
    // infractions
    "infractions.can_edit_duration",
    "infractions.can_edit_reason",
    "infractions.can_kick",
    "infractions.can_mute",
    "infractions.can_note",
    "infractions.can_view",
    "infractions.can_warn",
    // locate_user
    "locate_user.can_locate",
    "locate_user.can_seen",
    // music
    "music.can_control_playback",
    "music.can_manage_queue",
    "music.can_autoplay",
    // name_history
    "name_history.can_search",
    "name_history.can_view",
    // passport
    "passport.can_test",
    // reaction_roles
    "reaction_roles.can_create",
    "reaction_roles.can_delete",
    // reviews
    "reviews.can_delete",
    "reviews.can_list",
    "reviews.can_manage",
    // role_buttons
    "role_buttons.can_create",
    "role_buttons.can_delete",
    // roles
    "roles.can_give",
    "roles.can_remove",
    // slowmode
    "slowmode.can_clear",
    "slowmode.can_manage_rules",
    "slowmode.can_set",
    // social
    "social.can_manage",
    "social.can_view",
    // suggestions
    "suggestions.can_approve",
    "suggestions.can_block",
    "suggestions.can_delete",
    "suggestions.can_deny",
    "suggestions.can_manage",
    "suggestions.can_mark",
    // tags
    "tags.can_create",
    "tags.can_delete",
    "tags.can_edit",
    // tickets (was >=25)
    "tickets.can_add_remove_members",
    "tickets.can_claim",
    "tickets.can_close_others",
    "tickets.can_reopen",
    // tts
    "tts.can_blacklist",
    "tts.can_manage_channel",
    "tts.can_skip",
    // utility
    "utility.can_clean",
    "utility.can_create_emoji",
    "utility.can_create_sticker",
    "utility.can_nickname",
    "utility.can_search",
    "utility.can_stealemoji",
    "utility.can_vckick",
    "utility.can_vcmove",
    "utility.can_watchdog",
  ],

  // Was level >= 75 OR level >= 100.
  admin: [
    // activity_rewards
    "activity_rewards.can_manage",
    // giveaways
    "giveaways.can_cancel",
    "giveaways.can_view_all",
    "giveaways.can_create_via_dashboard",
    // infractions
    "infractions.can_ban",
    "infractions.can_delete",
    "infractions.can_softban",
    "infractions.can_unban",
    // music
    "music.can_force_skip",
    "music.can_manage_dj",
    "music.can_manage_settings",
    // tickets (was >=75 / >=100)
    "tickets.can_blacklist",
    "tickets.can_delete",
    "tickets.can_manage_panels",
    "tickets.can_view_all",
    // utility
    "utility.can_reload_guild",
  ],
};
