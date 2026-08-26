import { sqliteTable, text, integer, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const scheduledPosts = sqliteTable("scheduled_posts", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  content: text("content").notNull(),
  cronExpr: text("cron_expr"),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

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

export const customEvents = sqliteTable("custom_events", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  config: text("config").notNull(),
  response: text("response").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const commandAliases = sqliteTable(
  "command_aliases",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    options: text("options").notNull().default("{}"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
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

export const managedRoles = sqliteTable("managed_roles", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  template: text("template").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const dreamCommands = sqliteTable(
  "dream_commands",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    /** `slash` (guild application command). Legacy `prefix` rows are disabled. */
    triggerType: text("trigger_type").notNull().default("slash"),
    minLevel: integer("min_level", { mode: "number" }).notNull().default(0),
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

/** Per-guild daily slash/Dreamcode command uses. */
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

/** Per-guild Dreamliner Aero subscription (platform-managed). Table/column
 *  names stay "one" — renaming a live, in-use table is out of scope for the
 *  Aero rebrand (see rebrand plan). */
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

/** Discord guild-SKU entitlements for Dreamliner Aero. */
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

/** Complimentary Aero codes created from the superuser dashboard. */
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

export const economyCurrencies = sqliteTable(
  "economy_currencies",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    nameSingular: text("name_singular").notNull(),
    symbol: text("symbol").notNull().default("🪙"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    tradeable: integer("tradeable", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("economy_currencies_guild_key").on(table.guildId, table.key)],
);

export const economyAccounts = sqliteTable(
  "economy_accounts",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    currencyKey: text("currency_key").notNull(),
    pocket: integer("pocket", { mode: "number" }).notNull().default(0),
    bank: integer("bank", { mode: "number" }).notNull().default(0),
    frozen: integer("frozen", { mode: "number" }).notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.currencyKey] })],
);

export const economyTransactions = sqliteTable("economy_transactions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  currencyKey: text("currency_key").notNull(),
  deltaPocket: integer("delta_pocket", { mode: "number" }).notNull().default(0),
  deltaBank: integer("delta_bank", { mode: "number" }).notNull().default(0),
  deltaFrozen: integer("delta_frozen", { mode: "number" }).notNull().default(0),
  balancePocket: integer("balance_pocket", { mode: "number" }).notNull(),
  balanceBank: integer("balance_bank", { mode: "number" }).notNull(),
  balanceFrozen: integer("balance_frozen", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  actorId: text("actor_id"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key"),
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyProfiles = sqliteTable(
  "economy_profiles",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    xp: integer("xp", { mode: "number" }).notNull().default(0),
    level: integer("level", { mode: "number" }).notNull().default(1),
    prestige: integer("prestige", { mode: "number" }).notNull().default(0),
    hideBalances: integer("hide_balances", { mode: "boolean" }).notNull().default(false),
    frozen: integer("frozen", { mode: "boolean" }).notNull().default(false),
    freezeReason: text("freeze_reason"),
    jobKey: text("job_key"),
    jobXp: integer("job_xp", { mode: "number" }).notNull().default(0),
    jobLevel: integer("job_level", { mode: "number" }).notNull().default(1),
    activePetId: integer("active_pet_id", { mode: "number" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const economyCooldowns = sqliteTable(
  "economy_cooldowns",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    availableAt: integer("available_at", { mode: "timestamp" }).notNull(),
    metaJson: text("meta_json").notNull().default("{}"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.key] })],
);

export const economyStreaks = sqliteTable(
  "economy_streaks",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    count: integer("count", { mode: "number" }).notNull().default(0),
    lastClaimAt: integer("last_claim_at", { mode: "timestamp" }),
    lastClaimDay: text("last_claim_day"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.key] })],
);

export const economyItems = sqliteTable("economy_items", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  emoji: text("emoji").notNull().default("📦"),
  itemType: text("item_type").notNull().default("collectible"),
  stackable: integer("stackable", { mode: "boolean" }).notNull().default(true),
  tradeable: integer("tradeable", { mode: "boolean" }).notNull().default(true),
  sellValue: integer("sell_value", { mode: "number" }).notNull().default(0),
  currencyKey: text("currency_key").notNull().default("coins"),
  effectJson: text("effect_json").notNull().default("{}"),
  lootJson: text("loot_json").notNull().default("[]"),
  roleId: text("role_id"),
  petSpeciesKey: text("pet_species_key"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyShops = sqliteTable("economy_shops", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  channelId: text("channel_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyShopListings = sqliteTable("economy_shop_listings", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  shopId: integer("shop_id", { mode: "number" }).notNull(),
  itemId: integer("item_id", { mode: "number" }).notNull(),
  price: integer("price", { mode: "number" }).notNull(),
  currencyKey: text("currency_key").notNull().default("coins"),
  stock: integer("stock", { mode: "number" }),
  maxPerUser: integer("max_per_user", { mode: "number" }),
  restockAmount: integer("restock_amount", { mode: "number" }),
  restockIntervalSeconds: integer("restock_interval_seconds", { mode: "number" }),
  nextRestockAt: integer("next_restock_at", { mode: "timestamp" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
});

export const economyInventory = sqliteTable(
  "economy_inventory",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    itemId: integer("item_id", { mode: "number" }).notNull(),
    quantity: integer("quantity", { mode: "number" }).notNull().default(0),
    equipped: integer("equipped", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.itemId] })],
);

export const economyEffects = sqliteTable("economy_effects", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  magnitude: integer("magnitude", { mode: "number" }).notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyJobs = sqliteTable("economy_jobs", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  emoji: text("emoji").notNull().default("💼"),
  payMin: integer("pay_min", { mode: "number" }).notNull().default(50),
  payMax: integer("pay_max", { mode: "number" }).notNull().default(150),
  currencyKey: text("currency_key").notNull().default("coins"),
  cooldownSeconds: integer("cooldown_seconds", { mode: "number" }).notNull().default(3600),
  requiredLevel: integer("required_level", { mode: "number" }).notNull().default(1),
  requiredItemId: integer("required_item_id", { mode: "number" }),
  failChanceBps: integer("fail_chance_bps", { mode: "number" }).notNull().default(0),
  failFine: integer("fail_fine", { mode: "number" }).notNull().default(0),
  careerXp: integer("career_xp", { mode: "number" }).notNull().default(10),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  flavorJson: text("flavor_json").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyPetSpecies = sqliteTable("economy_pet_species", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  emoji: text("emoji").notNull().default("🐾"),
  rarity: text("rarity").notNull().default("common"),
  baseAtk: integer("base_atk", { mode: "number" }).notNull().default(10),
  baseDef: integer("base_def", { mode: "number" }).notNull().default(10),
  baseHp: integer("base_hp", { mode: "number" }).notNull().default(50),
  baseSpeed: integer("base_speed", { mode: "number" }).notNull().default(10),
  adoptCost: integer("adopt_cost", { mode: "number" }).notNull().default(500),
  currencyKey: text("currency_key").notNull().default("coins"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyPets = sqliteTable("economy_pets", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  speciesId: integer("species_id", { mode: "number" }).notNull(),
  name: text("name").notNull(),
  xp: integer("xp", { mode: "number" }).notNull().default(0),
  level: integer("level", { mode: "number" }).notNull().default(1),
  hunger: integer("hunger", { mode: "number" }).notNull().default(100),
  energy: integer("energy", { mode: "number" }).notNull().default(100),
  happiness: integer("happiness", { mode: "number" }).notNull().default(100),
  atk: integer("atk", { mode: "number" }).notNull().default(10),
  def: integer("def", { mode: "number" }).notNull().default(10),
  hp: integer("hp", { mode: "number" }).notNull().default(50),
  speed: integer("speed", { mode: "number" }).notNull().default(10),
  lastTickAt: integer("last_tick_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyRecipes = sqliteTable("economy_recipes", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  outputItemId: integer("output_item_id", { mode: "number" }).notNull(),
  outputQty: integer("output_qty", { mode: "number" }).notNull().default(1),
  inputsJson: text("inputs_json").notNull().default("[]"),
  durationSeconds: integer("duration_seconds", { mode: "number" }).notNull().default(60),
  requiredLevel: integer("required_level", { mode: "number" }).notNull().default(1),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyCraftQueue = sqliteTable("economy_craft_queue", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  recipeId: integer("recipe_id", { mode: "number" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  completesAt: integer("completes_at", { mode: "timestamp" }).notNull(),
  collected: integer("collected", { mode: "boolean" }).notNull().default(false),
  cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
});

export const economyQuests = sqliteTable("economy_quests", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  questType: text("quest_type").notNull().default("daily"),
  objectiveType: text("objective_type").notNull(),
  objectiveTarget: integer("objective_target", { mode: "number" }).notNull().default(1),
  rewardCurrencyKey: text("reward_currency_key").notNull().default("coins"),
  rewardAmount: integer("reward_amount", { mode: "number" }).notNull().default(100),
  rewardItemId: integer("reward_item_id", { mode: "number" }),
  rewardItemQty: integer("reward_item_qty", { mode: "number" }).notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyQuestProgress = sqliteTable(
  "economy_quest_progress",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    questId: integer("quest_id", { mode: "number" }).notNull(),
    progress: integer("progress", { mode: "number" }).notNull().default(0),
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    periodKey: text("period_key").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.questId, table.periodKey] })],
);

export const economyAchievements = sqliteTable("economy_achievements", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  objectiveType: text("objective_type").notNull(),
  objectiveTarget: integer("objective_target", { mode: "number" }).notNull().default(1),
  rewardCurrencyKey: text("reward_currency_key").notNull().default("coins"),
  rewardAmount: integer("reward_amount", { mode: "number" }).notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyAchievementProgress = sqliteTable(
  "economy_achievement_progress",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    achievementId: integer("achievement_id", { mode: "number" }).notNull(),
    progress: integer("progress", { mode: "number" }).notNull().default(0),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.achievementId] })],
);

export const economyTrades = sqliteTable("economy_trades", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  initiatorId: text("initiator_id").notNull(),
  partnerId: text("partner_id").notNull(),
  status: text("status").notNull().default("open"),
  initiatorConfirmed: integer("initiator_confirmed", { mode: "boolean" }).notNull().default(false),
  partnerConfirmed: integer("partner_confirmed", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision", { mode: "number" }).notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const economyTradeOffers = sqliteTable("economy_trade_offers", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  tradeId: integer("trade_id", { mode: "number" }).notNull(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  offerType: text("offer_type").notNull(),
  currencyKey: text("currency_key"),
  amount: integer("amount", { mode: "number" }).notNull().default(0),
  itemId: integer("item_id", { mode: "number" }),
  quantity: integer("quantity", { mode: "number" }).notNull().default(0),
});

export const economyMarketListings = sqliteTable("economy_market_listings", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  sellerId: text("seller_id").notNull(),
  itemId: integer("item_id", { mode: "number" }).notNull(),
  quantity: integer("quantity", { mode: "number" }).notNull().default(1),
  price: integer("price", { mode: "number" }).notNull(),
  currencyKey: text("currency_key").notNull().default("coins"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  soldAt: integer("sold_at", { mode: "timestamp" }),
  buyerId: text("buyer_id"),
});

export const economyAuctions = sqliteTable("economy_auctions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  sellerId: text("seller_id").notNull(),
  itemId: integer("item_id", { mode: "number" }).notNull(),
  quantity: integer("quantity", { mode: "number" }).notNull().default(1),
  currencyKey: text("currency_key").notNull().default("coins"),
  startingBid: integer("starting_bid", { mode: "number" }).notNull(),
  buyoutPrice: integer("buyout_price", { mode: "number" }),
  currentBid: integer("current_bid", { mode: "number" }).notNull().default(0),
  currentBidderId: text("current_bidder_id"),
  status: text("status").notNull().default("active"),
  endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  settledAt: integer("settled_at", { mode: "timestamp" }),
});

export const economyAuctionBids = sqliteTable("economy_auction_bids", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  auctionId: integer("auction_id", { mode: "number" }).notNull(),
  guildId: text("guild_id").notNull(),
  bidderId: text("bidder_id").notNull(),
  amount: integer("amount", { mode: "number" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economyAuctionWatches = sqliteTable(
  "economy_auction_watches",
  {
    guildId: text("guild_id").notNull(),
    auctionId: integer("auction_id", { mode: "number" }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.auctionId, table.userId] })],
);

export const economySeasons = sqliteTable("economy_seasons", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
  endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
  softReset: integer("soft_reset", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("scheduled"),
  rewardsJson: text("rewards_json").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const economySeasonScores = sqliteTable(
  "economy_season_scores",
  {
    guildId: text("guild_id").notNull(),
    seasonId: integer("season_id", { mode: "number" }).notNull(),
    userId: text("user_id").notNull(),
    score: integer("score", { mode: "number" }).notNull().default(0),
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.seasonId, table.userId] })],
);

export const economyDailyStats = sqliteTable(
  "economy_daily_stats",
  {
    guildId: text("guild_id").notNull(),
    day: text("day").notNull(),
    minted: integer("minted", { mode: "number" }).notNull().default(0),
    sunk: integer("sunk", { mode: "number" }).notNull().default(0),
    transfers: integer("transfers", { mode: "number" }).notNull().default(0),
    shopRevenue: integer("shop_revenue", { mode: "number" }).notNull().default(0),
    marketVolume: integer("market_volume", { mode: "number" }).notNull().default(0),
    adminAdjust: integer("admin_adjust", { mode: "number" }).notNull().default(0),
    activeUsers: integer("active_users", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.day] })],
);

export const economySchedulerLeases = sqliteTable(
  "economy_scheduler_leases",
  {
    guildId: text("guild_id").notNull(),
    taskKey: text("task_key").notNull(),
    leaseUntil: integer("lease_until", { mode: "timestamp" }).notNull(),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    checkpointJson: text("checkpoint_json").notNull().default("{}"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.taskKey] })],
);

export const economyGuildState = sqliteTable("economy_guild_state", {
  guildId: text("guild_id").primaryKey(),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  seeded: integer("seeded", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
