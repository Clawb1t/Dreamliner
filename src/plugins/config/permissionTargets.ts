export type PermissionTarget = {
  /** Autocomplete / option value, e.g. "ban" or "tag create" */
  key: string;
  /** Display label shown in Discord, e.g. "/ban" */
  label: string;
  plugin: string;
  permission: string;
};

/** User-facing command → plugin permission flag mappings. */
export const PERMISSION_TARGETS: PermissionTarget[] = [
  // Utility
  { key: "search", label: "/search", plugin: "utility", permission: "can_search" },
  { key: "bansearch", label: "/bansearch", plugin: "utility", permission: "can_search" },
  { key: "clean", label: "/clean", plugin: "utility", permission: "can_clean" },
  { key: "info", label: "/info", plugin: "utility", permission: "can_info" },
  { key: "user", label: "/user", plugin: "utility", permission: "can_userinfo" },
  { key: "server", label: "/server", plugin: "utility", permission: "can_server" },
  { key: "channel", label: "/channel", plugin: "utility", permission: "can_channelinfo" },
  { key: "message", label: "/message", plugin: "utility", permission: "can_messageinfo" },
  { key: "invite", label: "/invite", plugin: "utility", permission: "can_inviteinfo" },
  { key: "role", label: "/role", plugin: "utility", permission: "can_roleinfo" },
  { key: "emoji", label: "/emoji", plugin: "utility", permission: "can_emojiinfo" },
  { key: "snowflake", label: "/snowflake", plugin: "utility", permission: "can_snowflake" },
  { key: "rolelist", label: "/rolelist", plugin: "utility", permission: "can_roles" },
  { key: "level", label: "/level", plugin: "utility", permission: "can_level" },
  { key: "watchdog", label: "/watchdog", plugin: "utility", permission: "can_watchdog" },
  { key: "context", label: "/context", plugin: "utility", permission: "can_context" },
  { key: "source", label: "/source", plugin: "utility", permission: "can_source" },
  { key: "nickname", label: "/nickname", plugin: "utility", permission: "can_nickname" },
  { key: "voice move", label: "/voice move", plugin: "utility", permission: "can_vcmove" },
  { key: "voice disconnect", label: "/voice disconnect", plugin: "utility", permission: "can_vckick" },
  { key: "ping", label: "/ping", plugin: "utility", permission: "can_ping" },
  { key: "about", label: "/about", plugin: "utility", permission: "can_about" },
  { key: "help", label: "/help", plugin: "utility", permission: "can_help" },
  { key: "reload", label: "/reload", plugin: "utility", permission: "can_reload_guild" },
  { key: "avatar", label: "/avatar", plugin: "utility", permission: "can_avatar" },
  { key: "jumbo", label: "/jumbo", plugin: "utility", permission: "can_jumbo" },
  { key: "stealemoji", label: "/stealemoji", plugin: "utility", permission: "can_stealemoji" },
  { key: "time", label: "/time", plugin: "utility", permission: "can_time" },
  { key: "convert to gif", label: "Convert to GIF", plugin: "utility", permission: "can_convert_gif" },
  { key: "create quote", label: "Create Quote", plugin: "utility", permission: "can_create_quote" },

  // Infractions
  { key: "warn", label: "/warn", plugin: "infractions", permission: "can_warn" },
  { key: "note", label: "/note", plugin: "infractions", permission: "can_note" },
  { key: "mute", label: "/mute", plugin: "infractions", permission: "can_mute" },
  { key: "kick", label: "/kick", plugin: "infractions", permission: "can_kick" },
  { key: "ban", label: "/ban", plugin: "infractions", permission: "can_ban" },
  { key: "unban", label: "/unban", plugin: "infractions", permission: "can_unban" },
  { key: "softban", label: "/softban", plugin: "infractions", permission: "can_softban" },
  { key: "infraction view", label: "/infraction view", plugin: "infractions", permission: "can_view" },
  { key: "infraction reason", label: "/infraction reason", plugin: "infractions", permission: "can_edit_reason" },
  { key: "infraction duration", label: "/infraction duration", plugin: "infractions", permission: "can_edit_duration" },
  { key: "infraction delete", label: "/infraction delete", plugin: "infractions", permission: "can_delete" },

  // Moderation plugins
  { key: "automod status", label: "/automod status", plugin: "automod", permission: "can_status" },
  { key: "automod test", label: "/automod test", plugin: "automod", permission: "can_test" },
  { key: "automod configure", label: "/automod preset", plugin: "automod", permission: "can_configure" },
  { key: "scamprotect setup", label: "/scamprotect setup", plugin: "scam_protect", permission: "can_setup" },
  { key: "scamprotect status", label: "/scamprotect status", plugin: "scam_protect", permission: "can_status" },
  { key: "slowmode set", label: "/slowmode set", plugin: "slowmode", permission: "can_set" },
  { key: "slowmode clear", label: "/slowmode clear", plugin: "slowmode", permission: "can_clear" },
  { key: "slowmode rule", label: "/slowmode rule", plugin: "slowmode", permission: "can_manage_rules" },
  { key: "slowmode check", label: "/slowmode check", plugin: "slowmode", permission: "can_manage_rules" },
  { key: "slowmode bypass", label: "/slowmode bypass", plugin: "slowmode", permission: "can_configure" },
  { key: "slowmode individual", label: "/slowmode individual", plugin: "slowmode", permission: "can_configure" },

  // Roles
  { key: "roles give", label: "/roles give", plugin: "roles", permission: "can_give" },
  { key: "roles remove", label: "/roles remove", plugin: "roles", permission: "can_remove" },
  { key: "roles list", label: "/roles list", plugin: "roles", permission: "can_list" },
  { key: "selfrole configure", label: "/selfrole configure", plugin: "self_grantable_roles", permission: "can_configure" },

  // Automation
  { key: "welcome set", label: "/welcome set", plugin: "welcome_message", permission: "can_set" },
  { key: "welcome test", label: "/welcome test", plugin: "welcome_message", permission: "can_test" },
  { key: "welcome disable", label: "/welcome disable", plugin: "welcome_message", permission: "can_disable" },
  { key: "tag create", label: "/tag create", plugin: "tags", permission: "can_create" },
  { key: "tag edit", label: "/tag edit", plugin: "tags", permission: "can_edit" },
  { key: "tag delete", label: "/tag delete", plugin: "tags", permission: "can_delete" },
  { key: "tag list", label: "/tag list", plugin: "tags", permission: "can_list" },
  { key: "tag show", label: "/tag show", plugin: "tags", permission: "can_show" },
  { key: "autoreaction add", label: "/autoreaction add", plugin: "autoreactions", permission: "can_add" },
  { key: "autoreaction remove", label: "/autoreaction remove", plugin: "autoreactions", permission: "can_remove" },
  { key: "autoreaction list", label: "/autoreaction list", plugin: "autoreactions", permission: "can_list" },
  { key: "autoreply add", label: "/autoreply add", plugin: "autoreplies", permission: "can_add" },
  { key: "autoreply remove", label: "/autoreply remove", plugin: "autoreplies", permission: "can_remove" },
  { key: "autoreply list", label: "/autoreply list", plugin: "autoreplies", permission: "can_list" },
  { key: "autothread add", label: "/autothread add", plugin: "autothreads", permission: "can_add" },
  { key: "autothread remove", label: "/autothread remove", plugin: "autothreads", permission: "can_remove" },
  { key: "autothread list", label: "/autothread list", plugin: "autothreads", permission: "can_list" },
  { key: "remind", label: "/remind", plugin: "reminders", permission: "can_create" },
  { key: "reminders list", label: "/reminders list", plugin: "reminders", permission: "can_list" },
  { key: "reminders cancel", label: "/reminders cancel", plugin: "reminders", permission: "can_cancel" },

  // Tracking & misc
  { key: "names user", label: "/names user", plugin: "name_history", permission: "can_view" },
  { key: "names search", label: "/names search", plugin: "name_history", permission: "can_search" },
  { key: "locate", label: "/locate", plugin: "locate_user", permission: "can_locate" },
  { key: "seen", label: "/seen", plugin: "locate_user", permission: "can_seen" },
  { key: "stats server", label: "/stats server", plugin: "stats", permission: "can_server" },
  { key: "stats user", label: "/stats user", plugin: "stats", permission: "can_user" },
  { key: "stats channel", label: "/stats channel", plugin: "stats", permission: "can_channel" },
  { key: "rank", label: "/rank", plugin: "stats", permission: "can_user" },
  { key: "translate", label: "/translate", plugin: "translation", permission: "can_translate" },
  { key: "autorole add", label: "/autorole add", plugin: "autorole", permission: "can_add" },
  { key: "autorole remove", label: "/autorole remove", plugin: "autorole", permission: "can_remove" },
  { key: "autorole list", label: "/autorole list", plugin: "autorole", permission: "can_list" },
  { key: "review submit", label: "/review submit", plugin: "reviews", permission: "can_review" },
  { key: "review list", label: "/review list", plugin: "reviews", permission: "can_list" },
  { key: "review delete", label: "/review delete", plugin: "reviews", permission: "can_delete" },
  { key: "review stats", label: "/review stats", plugin: "reviews", permission: "can_list" },
  { key: "suggest", label: "/suggest", plugin: "suggestions", permission: "can_suggest" },
  { key: "suggestion follow", label: "/suggestion follow", plugin: "suggestions", permission: "can_follow" },
  { key: "suggestion info", label: "/suggestion info", plugin: "suggestions", permission: "can_info" },
  { key: "suggestion top", label: "/suggestion top", plugin: "suggestions", permission: "can_top" },
  { key: "suggestion search", label: "/suggestion search", plugin: "suggestions", permission: "can_info" },
  { key: "suggestion queue", label: "/suggestion queue", plugin: "suggestions", permission: "can_manage" },
  { key: "suggestion approve", label: "/suggestion approve", plugin: "suggestions", permission: "can_approve" },
  { key: "suggestion deny", label: "/suggestion deny", plugin: "suggestions", permission: "can_deny" },
  { key: "suggestion mark", label: "/suggestion mark", plugin: "suggestions", permission: "can_mark" },
  { key: "suggestion delete", label: "/suggestion delete", plugin: "suggestions", permission: "can_delete" },
  { key: "suggestion block", label: "/suggestion block", plugin: "suggestions", permission: "can_block" },
  {
    key: "suggestion massapprove",
    label: "/suggestion massapprove",
    plugin: "suggestions",
    permission: "can_manage",
  },
  { key: "command toggle", label: "/command toggle", plugin: "dream_commands", permission: "can_edit" },
  { key: "command remove", label: "/command remove", plugin: "dream_commands", permission: "can_remove" },
  { key: "command list", label: "/command list", plugin: "dream_commands", permission: "can_list" },

  // Economy
  { key: "economy balance", label: "/balance", plugin: "economy", permission: "can_balance" },
  { key: "economy daily", label: "/daily", plugin: "economy", permission: "can_daily" },
  { key: "economy exchange", label: "/exchange", plugin: "economy", permission: "can_exchange" },
  { key: "economy admin", label: "/economy settings", plugin: "economy", permission: "can_admin_manage" },

  // Economy — trading cards (/planes)
  { key: "planes view", label: "/planes inventory|card view|card list", plugin: "economy", permission: "can_view" },
  { key: "planes buy_pack", label: "/planes pack buy", plugin: "economy", permission: "can_buy_pack" },
  { key: "planes give", label: "/planes card give", plugin: "economy", permission: "can_give" },
  { key: "planes sell", label: "Sell button (pack reveal / hangar)", plugin: "economy", permission: "can_sell" },

  // Anime
  { key: "anime neko", label: "/anime neko", plugin: "anime", permission: "can_neko" },
  { key: "anime saved", label: "/anime saved", plugin: "anime", permission: "can_saved" },
];

const byKey = new Map(PERMISSION_TARGETS.map((target) => [target.key, target]));

export function findPermissionTarget(key: string): PermissionTarget | undefined {
  const normalized = key.trim().toLowerCase().replace(/^\/+/, "");
  return byKey.get(normalized) ?? PERMISSION_TARGETS.find((target) => target.label.toLowerCase() === `/${normalized}`);
}

export function autocompletePermissionTargets(query: string, limit = 25): PermissionTarget[] {
  const q = query.trim().toLowerCase().replace(/^\/+/, "");
  if (!q) return PERMISSION_TARGETS.slice(0, limit);

  const scored = PERMISSION_TARGETS.map((target) => {
    const key = target.key;
    const label = target.label.toLowerCase();
    let score = 0;
    if (key === q || label === `/${q}`) score = 100;
    else if (key.startsWith(q) || label.startsWith(`/${q}`)) score = 80;
    else if (key.includes(q) || label.includes(q)) score = 40;
    else return null;
    return { target, score };
  }).filter((entry): entry is { target: PermissionTarget; score: number } => entry !== null);

  scored.sort((a, b) => b.score - a.score || a.target.key.localeCompare(b.target.key));
  return scored.slice(0, limit).map((entry) => entry.target);
}
