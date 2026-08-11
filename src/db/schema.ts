import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

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

export const persistedMessages = sqliteTable(
  "persisted_messages",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    content: text("content").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
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
    counterType: text("counter_type").notNull().default("custom"),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.name] })],
);

export const companionChannels = sqliteTable(
  "companion_channels",
  {
    guildId: text("guild_id").notNull(),
    ownerId: text("owner_id").notNull(),
    channelId: text("channel_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.ownerId] })],
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

/** Pending/resolved guild bot avatar changes awaiting staff approval. */
export const botAvatarRequests = sqliteTable("bot_avatar_requests", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  guildId: text("guild_id").notNull(),
  requesterId: text("requester_id").notNull(),
  requestChannelId: text("request_channel_id").notNull(),
  requestMessageId: text("request_message_id"),
  reviewMessageId: text("review_message_id"),
  /** Base64-encoded normalized PNG (512×512). */
  avatarPng: text("avatar_png").notNull(),
  /** pending | approved | denied | failed | cancelled | superseded */
  status: text("status").notNull().default("pending"),
  reviewerId: text("reviewer_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
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
