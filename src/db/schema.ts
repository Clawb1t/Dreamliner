import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const guildConfigs = sqliteTable("guild_configs", {
  guildId: text("guild_id").primaryKey(),
  configYaml: text("config_yaml").notNull(),
  userConfigYaml: text("user_config_yaml"),
  defaultsSnapshotYaml: text("defaults_snapshot_yaml"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  updatedBy: text("updated_by"),
});

export const messageArchives = sqliteTable("message_archives", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  payload: text("payload").notNull(),
});

export const modCases = sqliteTable("mod_cases", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  modId: text("mod_id").notNull(),
  type: text("type").notNull(),
  reason: text("reason"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const guildMessageCounts = sqliteTable(
  "guild_message_counts",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const userMessageCounts = sqliteTable("user_message_counts", {
  userId: text("user_id").primaryKey(),
  count: integer("count").notNull().default(0),
  /** When this user last sent a tracked message, for public-profile "last seen". */
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
});

export const starboardPosts = sqliteTable(
  "starboard_posts",
  {
    guildId: text("guild_id").notNull(),
    boardName: text("board_name").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    starboardMessageId: text("starboard_message_id").notNull(),
    starCount: integer("star_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.boardName, table.sourceMessageId] })],
);

export const logMessages = sqliteTable(
  "log_messages",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    channelName: text("channel_name"),
    content: text("content").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId, table.messageId] })],
);

/** Collapsed per-user channel hops for the dashboard Tracker. */
export const guildUserTrail = sqliteTable("guild_user_trail", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp" }).notNull(),
  messageCount: integer("message_count").notNull().default(1),
  snippet: text("snippet").notNull().default(""),
});

export const censorRules = sqliteTable("censor_rules", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  pattern: text("pattern").notNull(),
  regex: integer("regex", { mode: "boolean" }).notNull().default(false),
  action: text("action").notNull().default("delete"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const modStrikes = sqliteTable(
  "mod_strikes",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const reactionRoleMappings = sqliteTable(
  "reaction_role_mappings",
  {
    guildId: text("guild_id").notNull(),
    messageId: text("message_id").notNull(),
    emoji: text("emoji").notNull(),
    roleId: text("role_id").notNull(),
    removeOnUnreact: integer("remove_on_unreact", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.messageId, table.emoji] })],
);

export const roleButtonPanels = sqliteTable(
  "role_button_panels",
  {
    guildId: text("guild_id").notNull(),
    messageId: text("message_id").notNull(),
    roleId: text("role_id").notNull(),
    label: text("label").notNull(),
    style: text("style").notNull().default("secondary"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.messageId, table.roleId] })],
);

export const selfRolePanels = sqliteTable(
  "self_role_panels",
  {
    guildId: text("guild_id").notNull(),
    messageId: text("message_id").notNull(),
    config: text("config").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.messageId] })],
);

export const tags = sqliteTable(
  "tags",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
);

export const reminders = sqliteTable("reminders", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  message: text("message").notNull(),
  remindAt: integer("remind_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** Tracks the live Discord message ID for a dashboard-configured sticky. */
export const persistedMessages = sqliteTable(
  "persisted_messages",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

/**
 * Tracks the live Discord message for a dashboard-configured role panel, for both post modes.
 * `fingerprint` diffs bot-posted content; `appliedRoleIds` (JSON array) diffs which
 * reactions/button rows this panel has actually applied on an "existing" mode message, so sync
 * only touches its own contribution and never a message's other content.
 */
export const rolePanelMessages = sqliteTable(
  "role_panel_messages",
  {
    guildId: text("guild_id").notNull(),
    panelId: text("panel_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    postMode: text("post_mode").notNull(),
    fingerprint: text("fingerprint").notNull().default(""),
    appliedRoleIds: text("applied_role_ids").notNull().default("[]"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.panelId] })],
);

export const channelAutodelete = sqliteTable(
  "channel_autodelete",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    delaySeconds: integer("delay_seconds").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

export const nameHistory = sqliteTable("name_history", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  oldName: text("old_name").notNull(),
  newName: text("new_name").notNull(),
  changeType: text("change_type").notNull(),
  /** Who made the change, from the audit log for nicknames; the user themself for usernames. Null if unresolved. */
  changedBy: text("changed_by"),
  changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
});

export const usernameSnapshots = sqliteTable("username_snapshots", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Last known guild nickname, roles, and timeout for Member Identity restore. */
export const memberIdentity = sqliteTable(
  "member_identity",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    nickname: text("nickname").notNull().default(""),
    roleIds: text("role_ids").notNull().default("[]"),
    timeoutUntil: integer("timeout_until", { mode: "number" }),
    username: text("username").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const guildStatsDaily = sqliteTable(
  "guild_stats_daily",
  {
    guildId: text("guild_id").notNull(),
    statDate: text("stat_date").notNull(),
    messages: integer("messages").notNull().default(0),
    joins: integer("joins").notNull().default(0),
    leaves: integer("leaves").notNull().default(0),
    edits: integer("edits").notNull().default(0),
    deletes: integer("deletes").notNull().default(0),
    reactions: integer("reactions").notNull().default(0),
    attachments: integer("attachments").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.statDate] })],
);

export const guildStatsUserDaily = sqliteTable(
  "guild_stats_user_daily",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    statDate: text("stat_date").notNull(),
    messages: integer("messages").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.statDate] })],
);

export const guildStatsChannelDaily = sqliteTable(
  "guild_stats_channel_daily",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    statDate: text("stat_date").notNull(),
    messages: integer("messages").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId, table.statDate] })],
);

export const autoreactionState = sqliteTable(
  "autoreaction_state",
  {
    guildId: text("guild_id").notNull(),
    ruleId: integer("rule_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    lastTriggeredAt: integer("last_triggered_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.ruleId, table.channelId] })],
);

export const autoreplyState = sqliteTable(
  "autoreply_state",
  {
    guildId: text("guild_id").notNull(),
    ruleId: integer("rule_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    lastTriggeredAt: integer("last_triggered_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.ruleId, table.channelId] })],
);

export const autothreadState = sqliteTable(
  "autothread_state",
  {
    guildId: text("guild_id").notNull(),
    ruleId: integer("rule_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    lastTriggeredAt: integer("last_triggered_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.ruleId, table.channelId] })],
);

export const counters = sqliteTable(
  "counters",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    value: integer("value").notNull().default(0),
    // Unused since counters moved to dashboard config (each entry carries its
    // own `metric` there); kept to avoid a destructive column drop.
    counterType: text("counter_type").notNull().default("custom"),
    // Last time a channel_name/voice_name counter actually renamed its
    // channel, so the refresh sweep can respect Discord's rename rate limit.
    lastRenamedAt: integer("last_renamed_at"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
);

export const companionRooms = sqliteTable(
  "companion_rooms",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    ownerId: text("owner_id").notNull().default(""),
    setupId: text("setup_id").notNull().default(""),
    textChannelId: text("text_channel_id").notNull().default(""),
    interfaceMessageId: text("interface_message_id").notNull().default(""),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    ghosted: integer("ghosted", { mode: "boolean" }).notNull().default(false),
    seq: integer("seq", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

export const dreamCommands = sqliteTable(
  "dream_commands",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    /** JSON-serialized CommandProgram (a reply, text or embed) built on the website. */
    program: text("program").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
);

/** Persisted audit log events for Discord channel + dashboard Logs. */
export const guildLogEvents = sqliteTable("guild_log_events", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  category: text("category").notNull(),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  actorId: text("actor_id"),
  targetId: text("target_id"),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  caseId: integer("case_id", { mode: "number" }),
  payload: text("payload").notNull().default("{}"),
  discordMessageId: text("discord_message_id"),
});

/** Pending/resolved guild bot avatar/banner changes awaiting staff approval. */
export const botAvatarRequests = sqliteTable("bot_avatar_requests", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  requesterId: text("requester_id").notNull(),
  /** Discord channel id, or `dashboard` when submitted from the website. */
  requestChannelId: text("request_channel_id").notNull(),
  requestMessageId: text("request_message_id"),
  reviewMessageId: text("review_message_id"),
  /** Base64-encoded normalized PNG (avatar 512×512, banner 680×240). */
  avatarPng: text("avatar_png").notNull(),
  /** avatar | banner */
  kind: text("kind").notNull().default("avatar"),
  /** pending | approved | denied | failed | cancelled | superseded */
  status: text("status").notNull().default("pending"),
  reviewerId: text("reviewer_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
});

/** Last-known guild bot bio and applied brand images. */
export const botGuildProfiles = sqliteTable("bot_guild_profiles", {
  guildId: text("guild_id").primaryKey(),
  bio: text("bio"),
  /** Base64 PNG, empty string if cleared, null if never stored. */
  avatarPng: text("avatar_png"),
  /** Base64 PNG, empty string if cleared, null if never stored. */
  bannerPng: text("banner_png"),
  /** JSON display name style, null when cleared or never set. */
  nameStyle: text("name_style"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  updatedBy: text("updated_by"),
});

/** Server reviews submitted via /review. */
export const reviews = sqliteTable("reviews", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  rating: integer("rating", { mode: "number" }).notNull(),
  content: text("content").notNull().default(""),
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

/** Community suggestions with staff review and voting. */
export const suggestions = sqliteTable("suggestions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  suggestionNumber: integer("suggestion_number", { mode: "number" }).notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  attachmentUrl: text("attachment_url"),
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  /** awaiting_review | approved | denied */
  status: text("status").notNull().default("awaiting_review"),
  /** none | considered | progress | implemented | no */
  displayStatus: text("display_status").notNull().default("none"),
  reviewChannelId: text("review_channel_id"),
  reviewMessageId: text("review_message_id"),
  feedChannelId: text("feed_channel_id"),
  feedMessageId: text("feed_message_id"),
  deniedChannelId: text("denied_channel_id"),
  deniedMessageId: text("denied_message_id"),
  archiveChannelId: text("archive_channel_id"),
  archiveMessageId: text("archive_message_id"),
  staffActorId: text("staff_actor_id"),
  denialReason: text("denial_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  implementedAt: integer("implemented_at", { mode: "timestamp" }),
});

export const suggestionVotes = sqliteTable(
  "suggestion_votes",
  {
    suggestionId: integer("suggestion_id", { mode: "number" }).notNull(),
    userId: text("user_id").notNull(),
    /** up | mid | down */
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.suggestionId, table.userId] })],
);

export const suggestionComments = sqliteTable("suggestion_comments", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  suggestionId: integer("suggestion_id", { mode: "number" }).notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const suggestionBlocks = sqliteTable(
  "suggestion_blocks",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    reason: text("reason"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const suggestionFollows = sqliteTable(
  "suggestion_follows",
  {
    suggestionId: integer("suggestion_id", { mode: "number" }).notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.suggestionId, table.userId] })],
);

/** Dashboard custom charts saved per guild (stats page). */
export const guildCustomCharts = sqliteTable("guild_custom_charts", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  title: text("title").notNull(),
  chartType: text("chart_type").notNull(),
  definitionJson: text("definition_json").notNull(),
  sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Rolling automod rule hits used for escalation ladders. */
export const automodHits = sqliteTable("automod_hits", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  ruleId: text("rule_id").notNull(),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** Per-guild daily slash/custom command uses. */
export const commandUsageDaily = sqliteTable(
  "command_usage_daily",
  {
    guildId: text("guild_id").notNull(),
    commandName: text("command_name").notNull(),
    statDate: text("stat_date").notNull(),
    uses: integer("uses").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.commandName, table.statDate] })],
);

/** Per-guild lifetime command uses. */
export const commandUsageTotals = sqliteTable(
  "command_usage_totals",
  {
    guildId: text("guild_id").notNull(),
    commandName: text("command_name").notNull(),
    uses: integer("uses").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.commandName] })],
);

/** Website/Discord user preferences (accent color, public profile bio/visibility, etc.). */
export const userProfiles = sqliteTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  accentColor: text("accent_color"),
  bio: text("bio"),
  profileVisible: integer("profile_visible", { mode: "boolean" }).notNull().default(true),
  /** Show the global coin balance pill in the site navbar. Off by default — most visitors don't use the economy. */
  showNavBalance: integer("show_nav_balance", { mode: "boolean" }).notNull().default(false),
  /** Show the "Exchange" item in the site navbar's user dropdown. Off by default, same reasoning as above. */
  showNavExchange: integer("show_nav_exchange", { mode: "boolean" }).notNull().default(false),
  /** Show the plane/airline trading card collection on the public profile page. Off by default. */
  showTradingCards: integer("show_trading_cards", { mode: "boolean" }).notNull().default(false),
  /** Days a user's message *content* (not counts/timestamps) stays retained: 0/1/7/14/30. */
  contentRetentionDays: integer("content_retention_days").notNull().default(30),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Platform-wide badge definitions (Developer, Dreamliner One Supporter, etc.), superuser-managed. */
export const badgeDefinitions = sqliteTable("badge_definitions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon").notNull().default(""),
  /** Base64-encoded PNG, uploaded by a superuser. Falls back to `icon` (emoji/glyph) when unset. */
  iconImage: text("icon_image"),
  colorHex: text("color_hex"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Lifetime count of messages a user has sent per UTC hour-of-day (0-23), for "active hours". */
export const userHourlyActivity = sqliteTable(
  "user_hourly_activity",
  {
    userId: text("user_id").notNull(),
    hourUtc: integer("hour_utc", { mode: "number" }).notNull(),
    count: integer("count", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.hourUtc] })],
);

/** Badges assigned to a user, and whether/where they show on the user's public profile. */
export const userBadges = sqliteTable(
  "user_badges",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    badgeId: integer("badge_id", { mode: "number" }).notNull(),
    assignedAt: integer("assigned_at", { mode: "timestamp" }).notNull(),
    assignedBy: text("assigned_by").notNull(),
    displayed: integer("displayed", { mode: "boolean" }).notNull().default(true),
    displayOrder: integer("display_order", { mode: "number" }).notNull().default(0),
  },
  (table) => [uniqueIndex("user_badges_user_badge_idx").on(table.userId, table.badgeId)],
);

/** Periodic Discord gateway ping / uptime samples for the public status page. */
export const botStatusSamples = sqliteTable("bot_status_samples", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  sampledAt: integer("sampled_at", { mode: "number" }).notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull().default(true),
  wsPingMs: integer("ws_ping_ms", { mode: "number" }),
});

/** Daily rollup of bot status samples (uptime % + avg ping). */
export const botStatusDaily = sqliteTable("bot_status_daily", {
  statDate: text("stat_date").primaryKey(),
  upSamples: integer("up_samples", { mode: "number" }).notNull().default(0),
  downSamples: integer("down_samples", { mode: "number" }).notNull().default(0),
  pingSum: integer("ping_sum", { mode: "number" }).notNull().default(0),
  pingCount: integer("ping_count", { mode: "number" }).notNull().default(0),
  pingMax: integer("ping_max", { mode: "number" }).notNull().default(0),
});

/** Per-guild Dreamliner One subscription (platform-managed). */
export const guildOneSubscriptions = sqliteTable("guild_one_subscriptions", {
  guildId: text("guild_id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  note: text("note"),
  grantedBy: text("granted_by").notNull(),
  grantedAt: integer("granted_at", { mode: "timestamp" }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

/** Discord guild-SKU entitlements for Dreamliner One. */
export const guildOneEntitlements = sqliteTable("guild_one_entitlements", {
  entitlementId: text("entitlement_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  skuId: text("sku_id").notNull(),
  userId: text("user_id"),
  startsAt: integer("starts_at", { mode: "timestamp" }),
  endsAt: integer("ends_at", { mode: "timestamp" }),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Complimentary Dreamliner One codes created from the superuser dashboard. */
export const oneDiscountCodes = sqliteTable("one_discount_codes", {
  code: text("code").primaryKey(),
  label: text("label"),
  days: integer("days", { mode: "number" }),
  maxRedemptions: integer("max_redemptions", { mode: "number" }),
  redemptionCount: integer("redemption_count", { mode: "number" }).notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const oneDiscountRedemptions = sqliteTable("one_discount_redemptions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  redeemedAt: integer("redeemed_at", { mode: "timestamp" }).notNull(),
});

/** Join welcome messages tracked for early-leave delete + wave tallies. */
export const welcomeJoinMessages = sqliteTable("welcome_join_messages", {
  messageId: text("message_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  memberId: text("member_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  waveEnabled: integer("wave_enabled", { mode: "boolean" }).notNull().default(false),
  waveCount: integer("wave_count", { mode: "number" }).notNull().default(0),
  waverIds: text("waver_ids").notNull().default("[]"),
});

/** Members waiting to complete Passport verification. */
export const passportPending = sqliteTable(
  "passport_pending",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    pingMessageId: text("ping_message_id"),
    pingChannelId: text("ping_channel_id"),
    status: text("status").notNull().default("pending"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

/** Completed Passport verifications. */
export const passportVerifications = sqliteTable(
  "passport_verifications",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp" }).notNull(),
    method: text("method").notNull().default("web"),
    accountCreatedAt: integer("account_created_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

// --- Economy -----------------------------------------------------------------
// Two independent ledgers: a bot-wide global economy ("coins") and a per-guild
// server economy whose name/symbol/rates are configured per guild.

export const economyGlobalAccounts = sqliteTable("economy_global_accounts", {
  userId: text("user_id").primaryKey(),
  balance: real("balance").notNull().default(0),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
  lastDailyAt: integer("last_daily_at", { mode: "timestamp" }),
  dailyStreak: integer("daily_streak", { mode: "number" }).notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const economyServerAccounts = sqliteTable(
  "economy_server_accounts",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    balance: real("balance").notNull().default(0),
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
    lastDailyAt: integer("last_daily_at", { mode: "timestamp" }),
    dailyStreak: integer("daily_streak", { mode: "number" }).notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

// --- Dreamliner Exchange (server stocks) --------------------------------------
// Every guild with the economy plugin enabled is listed as a "stock" whose price
// drifts up or down based on that server's message activity relative to its own
// recent baseline. Users invest their global coins to buy shares.

export const economyStocks = sqliteTable("economy_stocks", {
  guildId: text("guild_id").primaryKey(),
  symbol: text("symbol").notNull(),
  guildName: text("guild_name").notNull(),
  guildIcon: text("guild_icon"),
  price: real("price").notNull().default(10),
  activityScore: real("activity_score").notNull().default(1),
  listedAt: integer("listed_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const economyStockPriceHistory = sqliteTable(
  "economy_stock_price_history",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    price: real("price").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("economy_stock_history_guild_time").on(table.guildId, table.recordedAt)],
);

/** Persisted (not in-memory) message counts per guild per minute — survives restarts. */
export const economyStockActivityMinutes = sqliteTable(
  "economy_stock_activity_minutes",
  {
    guildId: text("guild_id").notNull(),
    minuteBucket: text("minute_bucket").notNull(),
    messages: integer("messages", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.minuteBucket] })],
);

export const economyStockHoldings = sqliteTable(
  "economy_stock_holdings",
  {
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    shares: real("shares").notNull().default(0),
    costBasis: real("cost_basis").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.guildId] })],
);

export const economyStockTransactions = sqliteTable(
  "economy_stock_transactions",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    type: text("type").notNull(),
    shares: real("shares").notNull(),
    price: real("price").notNull(),
    amount: real("amount").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("economy_stock_tx_user_time").on(table.userId, table.createdAt)],
);

// --- Anime (nekos.best) --------------------------------------------------------
// One row per member per saved neko image.

export const animeSavedNekos = sqliteTable(
  "anime_saved_nekos",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    imageUrl: text("image_url").notNull(),
    artistName: text("artist_name"),
    artistHref: text("artist_href"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("anime_saved_nekos_user_time").on(table.userId, table.createdAt),
    uniqueIndex("anime_saved_nekos_user_image").on(table.userId, table.imageUrl),
  ],
);

export const tickets = sqliteTable("tickets", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  panelId: text("panel_id").notNull(),
  categoryId: text("category_id").notNull(),
  number: integer("number", { mode: "number" }).notNull(),
  channelId: text("channel_id").notNull(),
  threadId: text("thread_id"),
  mode: text("mode").notNull().default("channel"),
  openerId: text("opener_id").notNull(),
  claimedBy: text("claimed_by"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("medium"),
  formResponses: text("form_responses").notNull().default("[]"),
  memberIds: text("member_ids").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp" }),
  closedBy: text("closed_by"),
  closeReason: text("close_reason"),
  lastActivityAt: integer("last_activity_at", { mode: "timestamp" }).notNull(),
  ratingScore: integer("rating_score", { mode: "number" }),
  ratingComment: text("rating_comment"),
  lastStaffReplyAt: integer("last_staff_reply_at", { mode: "timestamp" }),
  escalationStep: integer("escalation_step", { mode: "number" }).notNull().default(-1),
});

export const ticketTranscripts = sqliteTable("ticket_transcripts", {
  id: text("id").primaryKey(),
  ticketId: integer("ticket_id", { mode: "number" }).notNull(),
  guildId: text("guild_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  payload: text("payload").notNull(),
});

/** Dashboard-configured YouTube upload watchers ("Social Notifications"). */
export const socialYoutubeWatchers = sqliteTable("social_youtube_watchers", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  discordChannelId: text("discord_channel_id").notNull(),
  sourceChannelId: text("source_channel_id").notNull(),
  sourceChannelHandle: text("source_channel_handle"),
  sourceChannelName: text("source_channel_name").notNull(),
  sourceChannelAvatarUrl: text("source_channel_avatar_url"),
  sourceChannelUrl: text("source_channel_url").notNull(),
  uploadsPlaylistId: text("uploads_playlist_id").notNull(),
  messageContent: text("message_content").notNull().default(""),
  /** JSON string[] of role IDs to ping. */
  mentionRoleIds: text("mention_role_ids").notNull().default("[]"),
  /** JSON-serialized SocialEmbedConfig. */
  embedConfig: text("embed_config").notNull(),
  lastVideoId: text("last_video_id"),
  lastVideoPublishedAt: integer("last_video_published_at", { mode: "timestamp" }),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const ticketBlacklist = sqliteTable(
  "ticket_blacklist",
  {
    guildId: text("guild_id").notNull(),
    targetId: text("target_id").notNull(),
    targetType: text("target_type").notNull(),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.targetId] })],
);

// --- Plane cards (Dreamliner trading cards) -----------------------------------
// A global catalog of plane "card types" (real aircraft, added by the bot's
// developers). Users buy packs with global economy coins, opening them adds
// random cards to a per-user inventory (stacked by quantity, not unique
// serials), and cards can be given one at a time to another user.

export const planeCardTypes = sqliteTable("plane_card_types", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  /** plane | airline: which stat fields apply, see catalog.ts CARD_TYPES. */
  cardType: text("card_type").notNull().default("plane"),
  /** Free-text subtitle shown in card footers: manufacturer for planes, e.g. hub/founded for airlines. */
  subtitle: text("subtitle").notNull().default(""),
  rarity: text("rarity").notNull().default("common"),
  // Plane-only stats.
  speed: integer("speed", { mode: "number" }).notNull().default(50),
  agility: integer("agility", { mode: "number" }).notNull().default(50),
  passengerCount: integer("passenger_count", { mode: "number" }).notNull().default(0),
  // Airline-only stats.
  reputation: integer("reputation", { mode: "number" }).notNull().default(50),
  fleetSize: integer("fleet_size", { mode: "number" }).notNull().default(0),
  destinations: integer("destinations", { mode: "number" }).notNull().default(0),
  // Shared by both card types.
  safety: integer("safety", { mode: "number" }).notNull().default(50),
  /** File name of the card art in assets/planes/, e.g. "a350.png"; served as a Discord attachment, not a URL. */
  imageKey: text("image_key").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const planeCardInventory = sqliteTable(
  "plane_card_inventory",
  {
    userId: text("user_id").notNull(),
    planeTypeId: integer("plane_type_id", { mode: "number" }).notNull(),
    quantity: integer("quantity", { mode: "number" }).notNull().default(0),
    firstObtainedAt: integer("first_obtained_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.planeTypeId] })],
);

/** Log of every pack purchase, mainly for the dashboard/superuser tooling. */
export const planeCardPackOpenings = sqliteTable(
  "plane_card_pack_openings",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    cost: real("cost").notNull(),
    /** JSON array of plane_card_types ids drawn, in order. */
    planeTypeIds: text("plane_type_ids").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("plane_card_pack_openings_user_time").on(table.userId, table.createdAt)],
);

/** Single-row global pack settings (price/size). Bot-wide, not per-guild: managed only via
 *  /planesadmin, deliberately not exposed on the per-server dashboard config. */
export const planeGlobalSettings = sqliteTable("plane_global_settings", {
  id: text("id").primaryKey().default("global"),
  packPrice: real("pack_price").notNull().default(10),
  packSize: integer("pack_size", { mode: "number" }).notNull().default(1),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Global per-account voice preference (not per-guild) — set via /tts voice or the website account page. */
export const ttsUserVoices = sqliteTable("tts_user_voices", {
  userId: text("user_id").primaryKey(),
  voice: text("voice").notNull(),
});

/** Per-guild block list — a blacklisted user's messages are never spoken and /tts voice is denied. */
export const ttsBlacklist = sqliteTable(
  "tts_blacklist",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);
