/** Canonical log event types. Missing toggle keys default to enabled. */
export const LOG_EVENT_TYPES = [
  // Members
  "member_join",
  "member_leave",
  "member_kick",
  "member_ban",
  "member_unban",
  "member_timeout",
  "member_nick",
  "member_roles",
  // Messages
  "message_edit",
  "message_delete",
  "message_bulk_delete",
  "message_pin",
  // Channels / threads
  "channel_create",
  "channel_delete",
  "channel_update",
  "thread_create",
  "thread_update",
  "thread_delete",
  // Roles / guild structure
  "role_create",
  "role_delete",
  "role_update",
  "guild_update",
  "emoji_create",
  "emoji_delete",
  "emoji_update",
  "sticker_create",
  "sticker_delete",
  "sticker_update",
  "invite_create",
  "invite_delete",
  "webhook_update",
  // Voice
  "voice_join",
  "voice_leave",
  "voice_move",
  "voice_server_mute",
  "voice_server_deafen",
  "voice_self_mute",
  "voice_self_deafen",
  "voice_stream",
  "voice_video",
  // Moderation
  "case_create",
  "case_update",
  "case_delete",
  "case_expire",
  "automod",
  "raid",
  "censor",
  "clean",
  "voice_mod",
  "dm_failed",
  "dreamcode_mod",
  "dreamcode_server",
  "passport_verify",
  "passport_kick",
  "economy_adjust",
  "economy_transfer",
  "economy_shop",
  "economy_trade",
  "economy_auction",
  "economy_freeze",
  "economy_season",
  // Dashboard / website admin actions
  "dashboard_config",
  "dashboard_tag",
  "dashboard_command",
  "dashboard_suggestion",
  "dashboard_automod",
  "dashboard_chart",
  "dashboard_scam_protect",
  "dashboard_welcome",
  "dashboard_review",
  "dashboard_bot_brand",
  "dashboard_economy",
] as const;

export type LogEventType = (typeof LOG_EVENT_TYPES)[number];

export type LogEventCategory = "server" | "moderation";

export const LOG_EVENT_META: Record<
  LogEventType,
  { label: string; category: LogEventCategory; group: string }
> = {
  member_join: { label: "Member join", category: "server", group: "Members" },
  member_leave: { label: "Member leave", category: "server", group: "Members" },
  member_kick: { label: "Member kick", category: "server", group: "Members" },
  member_ban: { label: "Member ban", category: "server", group: "Members" },
  member_unban: { label: "Member unban", category: "server", group: "Members" },
  member_timeout: { label: "Timeout change", category: "server", group: "Members" },
  member_nick: { label: "Nickname change", category: "server", group: "Members" },
  member_roles: { label: "Role change", category: "server", group: "Members" },
  message_edit: { label: "Message edit", category: "server", group: "Messages" },
  message_delete: { label: "Message delete", category: "server", group: "Messages" },
  message_bulk_delete: { label: "Bulk delete", category: "server", group: "Messages" },
  message_pin: { label: "Message pin", category: "server", group: "Messages" },
  channel_create: { label: "Channel create", category: "server", group: "Channels" },
  channel_delete: { label: "Channel delete", category: "server", group: "Channels" },
  channel_update: { label: "Channel update", category: "server", group: "Channels" },
  thread_create: { label: "Thread create", category: "server", group: "Threads" },
  thread_update: { label: "Thread update", category: "server", group: "Threads" },
  thread_delete: { label: "Thread delete", category: "server", group: "Threads" },
  role_create: { label: "Role create", category: "server", group: "Roles" },
  role_delete: { label: "Role delete", category: "server", group: "Roles" },
  role_update: { label: "Role update", category: "server", group: "Roles" },
  guild_update: { label: "Server update", category: "server", group: "Server" },
  emoji_create: { label: "Emoji create", category: "server", group: "Emoji & stickers" },
  emoji_delete: { label: "Emoji delete", category: "server", group: "Emoji & stickers" },
  emoji_update: { label: "Emoji update", category: "server", group: "Emoji & stickers" },
  sticker_create: { label: "Sticker create", category: "server", group: "Emoji & stickers" },
  sticker_delete: { label: "Sticker delete", category: "server", group: "Emoji & stickers" },
  sticker_update: { label: "Sticker update", category: "server", group: "Emoji & stickers" },
  invite_create: { label: "Invite create", category: "server", group: "Invites" },
  invite_delete: { label: "Invite delete", category: "server", group: "Invites" },
  webhook_update: { label: "Webhook update", category: "server", group: "Server" },
  voice_join: { label: "Voice join", category: "server", group: "Voice" },
  voice_leave: { label: "Voice leave", category: "server", group: "Voice" },
  voice_move: { label: "Voice move", category: "server", group: "Voice" },
  voice_server_mute: { label: "Server mute", category: "server", group: "Voice" },
  voice_server_deafen: { label: "Server deafen", category: "server", group: "Voice" },
  voice_self_mute: { label: "Self mute", category: "server", group: "Voice" },
  voice_self_deafen: { label: "Self deafen", category: "server", group: "Voice" },
  voice_stream: { label: "Stream", category: "server", group: "Voice" },
  voice_video: { label: "Video", category: "server", group: "Voice" },
  case_create: { label: "Case create", category: "moderation", group: "Moderation" },
  case_update: { label: "Case update", category: "moderation", group: "Moderation" },
  case_delete: { label: "Case delete", category: "moderation", group: "Moderation" },
  case_expire: { label: "Case expire", category: "moderation", group: "Moderation" },
  automod: { label: "Automod", category: "moderation", group: "Moderation" },
  raid: { label: "Raid", category: "moderation", group: "Moderation" },
  censor: { label: "Automod (legacy censor)", category: "moderation", group: "Moderation" },
  clean: { label: "Clean", category: "moderation", group: "Moderation" },
  voice_mod: { label: "Voice mod action", category: "moderation", group: "Moderation" },
  dm_failed: { label: "DM failed", category: "moderation", group: "Moderation" },
  dreamcode_mod: { label: "Dreamcode mod log", category: "moderation", group: "Moderation" },
  dreamcode_server: { label: "Dreamcode server log", category: "server", group: "Server" },
  passport_verify: { label: "Passport verify", category: "moderation", group: "Passport" },
  passport_kick: { label: "Passport kick", category: "moderation", group: "Passport" },
  economy_adjust: { label: "Economy adjust", category: "server", group: "Economy" },
  economy_transfer: { label: "Economy transfer", category: "server", group: "Economy" },
  economy_shop: { label: "Economy shop", category: "server", group: "Economy" },
  economy_trade: { label: "Economy trade", category: "server", group: "Economy" },
  economy_auction: { label: "Economy auction", category: "server", group: "Economy" },
  economy_freeze: { label: "Economy freeze", category: "server", group: "Economy" },
  economy_season: { label: "Economy season", category: "server", group: "Economy" },
  dashboard_config: { label: "Config update", category: "server", group: "Dashboard" },
  dashboard_tag: { label: "Tag change", category: "server", group: "Dashboard" },
  dashboard_command: { label: "Dream command change", category: "server", group: "Dashboard" },
  dashboard_suggestion: { label: "Suggestion admin", category: "moderation", group: "Dashboard" },
  dashboard_automod: { label: "Automod update", category: "moderation", group: "Dashboard" },
  dashboard_chart: { label: "Custom chart", category: "server", group: "Dashboard" },
  dashboard_scam_protect: { label: "Scam protect", category: "moderation", group: "Dashboard" },
  dashboard_welcome: { label: "Welcomer asset", category: "server", group: "Dashboard" },
  dashboard_review: { label: "Review admin", category: "server", group: "Dashboard" },
  dashboard_bot_brand: { label: "Bot brand", category: "server", group: "Dashboard" },
  dashboard_economy: { label: "Economy change", category: "server", group: "Dashboard" },
};

export function isLogEventType(value: string): value is LogEventType {
  return (LOG_EVENT_TYPES as readonly string[]).includes(value);
}

export function defaultLoggingEvents(): Record<LogEventType, boolean> {
  return Object.fromEntries(LOG_EVENT_TYPES.map((key) => [key, true])) as Record<LogEventType, boolean>;
}

export function getLoggingEventGroups(): Array<{
  group: string;
  events: Array<{ key: LogEventType; label: string; category: LogEventCategory }>;
}> {
  const map = new Map<string, Array<{ key: LogEventType; label: string; category: LogEventCategory }>>();
  for (const key of LOG_EVENT_TYPES) {
    const meta = LOG_EVENT_META[key];
    const list = map.get(meta.group) ?? [];
    list.push({ key, label: meta.label, category: meta.category });
    map.set(meta.group, list);
  }
  return [...map.entries()].map(([group, events]) => ({ group, events }));
}
