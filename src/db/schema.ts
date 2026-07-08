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
  },
  (table) => [primaryKey({ columns: [table.guildId, table.statDate] })],
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
