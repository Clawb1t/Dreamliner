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
  // Was level >= 0 (everyone).
  member: [
    // booster_roles
    "booster_roles.can_view",
    "booster_roles.can_recheck",
    // counting
    "counting.can_stats",
    // economy
    "economy.can_balance",
    "economy.can_buy_pack",
    "economy.can_daily",
    "economy.can_exchange",
    "economy.can_give",
    "economy.can_sell",
    "economy.can_view",
    // reviews
    "reviews.can_review",
    // suggestions
    "suggestions.can_follow",
    "suggestions.can_info",
    "suggestions.can_suggest",
    "suggestions.can_top",
    "suggestions.can_vote",
    // tts
    "tts.can_speak",
    // music
    "music.can_play",
    "music.can_skip",
    "music.can_manage_playlists",
    // utility
    "utility.can_one",
  ],

  // Was level >= 25 OR level >= 50.
  moderator: [
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
    "dream_commands.can_list",
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
    // reminders
    "reminders.can_cancel",
    "reminders.can_create",
    "reminders.can_list",
    // reviews
    "reviews.can_delete",
    "reviews.can_list",
    "reviews.can_manage",
    // role_buttons
    "role_buttons.can_create",
    "role_buttons.can_delete",
    // roles
    "roles.can_give",
    "roles.can_list",
    "roles.can_remove",
    // slowmode
    "slowmode.can_clear",
    "slowmode.can_manage_rules",
    "slowmode.can_set",
    // social
    "social.can_manage",
    "social.can_view",
    // stats
    "stats.can_channel",
    "stats.can_server",
    "stats.can_user",
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
    "tags.can_list",
    "tags.can_show",
    // tickets (was >=25)
    "tickets.can_add_remove_members",
    "tickets.can_claim",
    "tickets.can_close",
    "tickets.can_close_others",
    "tickets.can_reopen",
    // translation
    "translation.can_translate",
    // tts
    "tts.can_blacklist",
    "tts.can_manage_channel",
    "tts.can_skip",
    // utility
    "utility.can_avatar",
    "utility.can_channelinfo",
    "utility.can_clean",
    "utility.can_context",
    "utility.can_convert_gif",
    "utility.can_create_emoji",
    "utility.can_create_sticker",
    "utility.can_emojiinfo",
    "utility.can_help",
    "utility.can_info",
    "utility.can_inviteinfo",
    "utility.can_jumbo",
    "utility.can_level",
    "utility.can_messageinfo",
    "utility.can_nickname",
    "utility.can_roleinfo",
    "utility.can_roles",
    "utility.can_search",
    "utility.can_server",
    "utility.can_snowflake",
    "utility.can_source",
    "utility.can_stealemoji",
    "utility.can_time",
    "utility.can_userinfo",
    "utility.can_vckick",
    "utility.can_vcmove",
    "utility.can_watchdog",
  ],

  // Was level >= 75 OR level >= 100.
  admin: [
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
    "utility.can_about",
    "utility.can_ping",
    "utility.can_reload_guild",
  ],
};
