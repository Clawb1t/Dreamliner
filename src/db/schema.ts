import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const guildConfigs = sqliteTable("guild_configs", {
  guildId: text("guild_id").primaryKey(),
  // JSON-serialized GuildConfig (not YAML — see drizzle/migrations for the rename+backfill).
  configJson: text("config_json").notNull(),
  userConfigJson: text("user_config_json"),
  defaultsSnapshotJson: text("defaults_snapshot_json"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  updatedBy: text("updated_by"),
});

// --- Permission roles ----------------------------------------------------------
// Replaces the old level+override permission model: named, Discord-role-style
// permission groups. A member's effective grants are the OR of every role they
// belong to — either targeted directly, or via one of their Discord roles. Kept
// as structured tables (not folded into guild_configs' YAML blob) so a role has a
// stable id to "click into", and so a permission check / toggle-grid write is an
// indexed row lookup instead of parse-then-scan JSON on every gated command.

export const guildPermissionRoles = sqliteTable(
  "guild_permission_roles",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    color: integer("color", { mode: "number" }),
    // "member" | "moderator" | "admin" for the three built-in roles, null for a custom role.
    builtIn: text("built_in"),
    position: integer("position", { mode: "number" }).notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("guild_permission_roles_guild").on(table.guildId)],
);

/** Discord roles/users assigned into a permission role — its "members", same idea as Discord's own role membership. */
export const guildPermissionRoleTargets = sqliteTable(
  "guild_permission_role_targets",
  {
    roleId: integer("role_id", { mode: "number" }).notNull(),
    targetType: text("target_type").notNull(), // "role" | "user"
    targetId: text("target_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.targetType, table.targetId] }),
    index("guild_permission_role_targets_role").on(table.roleId),
  ],
);

/** One row per granted `<plugin>.<permission>` flag on a role. */
export const guildPermissionRoleGrants = sqliteTable(
  "guild_permission_role_grants",
  {
    roleId: integer("role_id", { mode: "number" }).notNull(),
    grantKey: text("grant_key").notNull(), // "<plugin>.<permission>", e.g. "infractions.can_ban"
  },
  (table) => [primaryKey({ columns: [table.roleId, table.grantKey] })],
);

export const messageArchives = sqliteTable(
  "message_archives",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [index("message_archives_guild").on(table.guildId)],
);

export const modCases = sqliteTable(
  "mod_cases",
  {
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
    /** Whether this case has a public, shareable document page at /case/:shareToken. */
    public: integer("public", { mode: "boolean" }).notNull().default(false),
    shareToken: text("share_token").unique(),
    /** Editable public-facing summary shown on the shared page, separate from the internal `reason`. */
    publicNote: text("public_note"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
  },
  (table) => [
    index("mod_cases_guild").on(table.guildId),
    index("mod_cases_guild_user").on(table.guildId, table.userId),
  ],
);

/** One capture batch of a member's recent message content, taken either automatically when a
 * moderation case is created against them, or manually via `/evidence add`. Kept 42 days
 * regardless of the server's `content_retention_days` config setting. */
export const evidenceMessages = sqliteTable(
  "evidence_messages",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    /** Groups every row captured in one /warn, /ban, or /evidence add into a single card. */
    captureId: text("capture_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    authorName: text("author_name").notNull(),
    content: text("content").notNull().default(""),
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
    capturedBy: text("captured_by"),
    /** "case" = auto-captured when a moderation case was created; "manual" = /evidence add. */
    source: text("source").notNull(),
    caseId: integer("case_id", { mode: "number" }),
  },
  (table) => [
    index("evidence_messages_guild_user").on(table.guildId, table.userId),
    index("evidence_messages_case").on(table.caseId),
    index("evidence_messages_capture").on(table.captureId),
  ],
);

/** Screenshots and other files a mod attaches to a case from the dashboard. Stored on disk under
 * data/guild-assets/<guildId>/cases/<caseId>/, this row holds the metadata. */
export const caseEvidenceFiles = sqliteTable(
  "case_evidence_files",
  {
    id: text("id").primaryKey(),
    caseId: integer("case_id", { mode: "number" }).notNull(),
    guildId: text("guild_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size", { mode: "number" }).notNull(),
    caption: text("caption"),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("case_evidence_files_case").on(table.caseId)],
);

/** One exported voice clip (metadata only — the mp4 itself lives on disk under
 * data/guild-assets/<guildId>/clips/<id>.mp4, same convention as caseEvidenceFiles). The clip's
 * own id doubles as its unguessable share link, so no separate share-token column is needed. */
export const voiceClips = sqliteTable(
  "voice_clips",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull().default(""),
    durationMs: integer("duration_ms", { mode: "number" }).notNull(),
    fileName: text("file_name").notNull(),
    byteSize: integer("byte_size", { mode: "number" }).notNull(),
    /** "public" | "password" | "private" — see resolveClipAccess() in the clipping plugin. */
    privacy: text("privacy").notNull().default("public"),
    passwordHash: text("password_hash"),
    keepForever: integer("keep_forever", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    editedAt: integer("edited_at", { mode: "timestamp" }),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    /** JSON array of {startMs, endMs, text} segments from a local Whisper model, or null if
     * transcription is still running or failed — generated in the background after export so it
     * never blocks /clip's reply. */
    transcript: text("transcript"),
  },
  (table) => [index("voice_clips_owner").on(table.ownerId), index("voice_clips_expires").on(table.expiresAt)],
);

/** A participant captured in a voice clip, snapshotted at export time (avatar/name/username can
 * change or the user can leave the guild later — the clip page must still show who they were). */
export const voiceClipParticipants = sqliteTable(
  "voice_clip_participants",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    clipId: text("clip_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    username: text("username").notNull(),
    avatarUrl: text("avatar_url"),
  },
  (table) => [
    index("voice_clip_participants_clip").on(table.clipId),
    index("voice_clip_participants_user").on(table.userId),
  ],
);

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

/** Collapsed per-user channel hops, used for risk scoring (Watchdog) and last-seen lookups. */
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

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    message: text("message").notNull(),
    remindAt: integer("remind_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("reminders_guild").on(table.guildId),
    index("reminders_user").on(table.userId),
  ],
);

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
export const guildLogEvents = sqliteTable(
  "guild_log_events",
  {
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
  },
  (table) => [index("guild_log_events_guild_created").on(table.guildId, table.createdAt)],
);

/** Pending/resolved guild bot avatar/banner changes awaiting staff approval. */
export const botAvatarRequests = sqliteTable(
  "bot_avatar_requests",
  {
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
  },
  (table) => [index("bot_avatar_requests_guild").on(table.guildId)],
);

/**
 * Last-known guild bot nickname, bio, and applied brand images — the "draft" the dashboard
 * edits. Independent of what's actually live on Discord right now: bot_customisation's enabled
 * toggle decides whether the live per-guild bot profile mirrors this draft or sits at Discord's
 * default, so these columns stay put across an enable/disable flip either way.
 */
export const botGuildProfiles = sqliteTable("bot_guild_profiles", {
  guildId: text("guild_id").primaryKey(),
  /** Empty string if cleared, null if never stored. */
  nick: text("nick"),
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
export const reviews = sqliteTable(
  "reviews",
  {
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
  },
  (table) => [index("reviews_guild").on(table.guildId)],
);

/** Community suggestions with staff review and voting. */
export const suggestions = sqliteTable(
  "suggestions",
  {
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
  },
  (table) => [index("suggestions_guild_number").on(table.guildId, table.suggestionNumber)],
);

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
export const guildCustomCharts = sqliteTable(
  "guild_custom_charts",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    title: text("title").notNull(),
    chartType: text("chart_type").notNull(),
    definitionJson: text("definition_json").notNull(),
    sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("guild_custom_charts_guild").on(table.guildId)],
);

/** Rolling automod rule hits used for escalation ladders. */
export const automodHits = sqliteTable(
  "automod_hits",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    ruleId: text("rule_id").notNull(),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("automod_hits_guild_user").on(table.guildId, table.userId)],
);

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
  /** Show the plane/airline trading card collection on the public profile page. Off by default. */
  showTradingCards: integer("show_trading_cards", { mode: "boolean" }).notNull().default(false),
  /** Hide the "As seen in these servers" section on the public profile page. Off by default. */
  hideServersSection: integer("hide_servers_section", { mode: "boolean" }).notNull().default(false),
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
  /** Cached guild count at sample time — backs the public status page's "Servers" chart,
   *  nullable so old rows recorded before this column existed don't need backfilling. */
  guildCount: integer("guild_count", { mode: "number" }),
  /** Process RSS at sample time, in MB — backs the public status page's "RAM usage" spark.
   *  Nullable for the same backfill reason as guildCount above. */
  ramUsageMb: integer("ram_usage_mb", { mode: "number" }),
  /** Lavalink node snapshot at sample time — backs the public status page's Lavalink panel.
   *  Null whenever music isn't configured or the node wasn't connected at sample time, same
   *  backfill/unavailable reasoning as the other nullable columns here. */
  lavalinkPlayers: integer("lavalink_players", { mode: "number" }),
  lavalinkPlayingPlayers: integer("lavalink_playing_players", { mode: "number" }),
  lavalinkMemoryUsedMb: integer("lavalink_memory_used_mb", { mode: "number" }),
  lavalinkCpuLoadPct: real("lavalink_cpu_load_pct"),
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

/**
 * Network signal captured at the moment of a web Passport verification, used to
 * cluster likely alt accounts within a guild (see `functions/altMatching.ts`).
 * Raw IP/geo fields are bot-internal only — never returned by the bridge.
 */
export const passportNetworkSignals = sqliteTable(
  "passport_network_signals",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    ipAddress: text("ip_address").notNull(),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("passport_network_signals_guild").on(table.guildId),
  ],
);

/** A guild owner's "these two aren't alts" call, excluded from future alt clusters. */
export const passportAltDismissals = sqliteTable(
  "passport_alt_dismissals",
  {
    guildId: text("guild_id").notNull(),
    userIdA: text("user_id_a").notNull(),
    userIdB: text("user_id_b").notNull(),
    dismissedAt: integer("dismissed_at", { mode: "timestamp" }).notNull(),
    dismissedBy: text("dismissed_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userIdA, table.userIdB] })],
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

export const tickets = sqliteTable(
  "tickets",
  {
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
    /** Work-in-progress status shown alongside open/closed (e.g. "awaiting_response"). Null = no special status. */
    subStatus: text("sub_status"),
    /** First time any staff member replied — set once, never overwritten. Powers the response-time stat. */
    firstStaffReplyAt: integer("first_staff_reply_at", { mode: "timestamp" }),
    /** Who sent that first staff reply — the response-time stat is attributed to them specifically. */
    firstResponderId: text("first_responder_id"),
  },
  (table) => [index("tickets_guild").on(table.guildId)],
);

export const ticketTranscripts = sqliteTable(
  "ticket_transcripts",
  {
    id: text("id").primaryKey(),
    ticketId: integer("ticket_id", { mode: "number" }).notNull(),
    guildId: text("guild_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [index("ticket_transcripts_guild").on(table.guildId)],
);

/** Dashboard-configured YouTube upload watchers ("Social Notifications"). */
export const socialYoutubeWatchers = sqliteTable(
  "social_youtube_watchers",
  {
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
  },
  (table) => [index("social_youtube_watchers_guild").on(table.guildId)],
);

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

/** Global per-account language preference (not per-guild) — set via /language or the website
 *  account page. Every reply Dreamliner sends that member is translated into this locale;
 *  unset means English. See src/i18n/. */
export const userLocales = sqliteTable("user_locales", {
  userId: text("user_id").primaryKey(),
  locale: text("locale").notNull(),
});

/** Languages Dreamliner can reply in. "en" is a built-in row (English text lives inline in code
 *  as every t() call's fallback, so it has no dictionary of its own); ja/es/tr are seeded
 *  built-ins with a starter dictionary; anything else is a language a platform superuser created
 *  from the dashboard. See src/i18n/registry.ts. */
export const botLanguages = sqliteTable("bot_languages", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  flag: text("flag").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** The dictionary: one row per (locale, key) -> translated string. Superuser-editable from the
 *  dashboard (Platform > Languages). A key missing here just falls back to the English text
 *  supplied inline at its t() call site — see src/i18n/catalog.ts. */
export const botTranslations = sqliteTable(
  "bot_translations",
  {
    locale: text("locale").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.locale, table.key] })],
);

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

/** Global (not per-guild) perceptual-hash blocklist for the Image Scanning automod rule.
 *  Platform superuser-managed only (dashboard's /dashboard/scam-images page) — every guild
 *  with the rule enabled matches against this same shared list. `phash` is a 64-bit dHash
 *  as 16 hex chars; see src/plugins/automod/functions/imageHash.ts. */
export const scamImageHashes = sqliteTable("scam_image_hashes", {
  id: text("id").primaryKey(),
  phash: text("phash").notNull(),
  label: text("label").notNull().default(""),
  addedBy: text("added_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// --- Global Watchdog ---------------------------------------------------------------
// Platform-wide, superuser-curated watchlist of confirmed bad actors (raid operators,
// scammers, etc.) — same "small superuser-curated platform table" shape as
// scamImageHashes/badgeDefinitions above. Never populated automatically; each server
// opts in independently via its own `global_watchdog_action` config field and decides
// what happens (alert/kick/ban) when a listed user joins. See src/bridge/globalWatchdog.ts.
export const globalWatchdogEntries = sqliteTable("global_watchdog_entries", {
  userId: text("user_id").primaryKey(),
  reason: text("reason").notNull(),
  evidenceUrl: text("evidence_url"),
  addedBy: text("added_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// --- Raid Defense Mesh -------------------------------------------------------------
// Opt-in pairing between servers: when one side's existing raid-burst detector trips,
// the other gets an alert naming the accounts involved. Only ever reacts to an already
// -detected raid; never ambient tracking. See src/plugins/raid_mesh/.
export const raidMeshLinks = sqliteTable(
  "raid_mesh_links",
  {
    guildId: text("guild_id").notNull(),
    linkedGuildId: text("linked_guild_id").notNull(),
    linkedAt: integer("linked_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.linkedGuildId] })],
);

/** Single-use, short-lived invite codes used to establish a raid_mesh_links pair. */
export const raidMeshInvites = sqliteTable("raid_mesh_invites", {
  code: text("code").primaryKey(),
  guildId: text("guild_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

// --- Impersonation Detection ------------------------------------------------------
// Lives in the Automod hub. Tracks identity changes (username/display name/nickname/
// avatar) per member and flags anyone whose identity closely matches a protected role
// holder or a manually pinned watchlist entry. See src/plugins/impersonation/.

/** Append-only identity change log — also powers the "has this person changed their name
 *  or avatar before, and to what" history view, independent of any impersonation match. */
export const impersonationHistory = sqliteTable(
  "impersonation_history",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    field: text("field").notNull(), // "username" | "display_name" | "nickname" | "avatar" | "joined"
    oldValue: text("old_value"),
    newValue: text("new_value"),
    /** For field "avatar": dHash (16 hex chars) of old/new, stored in old_value/new_value instead of a URL. */
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("impersonation_history_guild_user").on(table.guildId, table.userId, table.changedAt)],
);

/** Manually pinned identities staff want protected beyond whatever roles are configured
 *  (e.g. the server owner's personal alt, a well-known partner/streamer with no server role). */
export const impersonationWatchlist = sqliteTable("impersonation_watchlist", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  label: text("label").notNull(),
  /** Optional: keep this entry's name/avatar live-synced to a real member instead of a frozen snapshot. */
  targetUserId: text("target_user_id"),
  name: text("name").notNull().default(""),
  avatarHash: text("avatar_hash"),
  addedBy: text("added_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** One row per detected likely-impersonation event, surfaced on the dashboard's alerts feed. */
export const impersonationAlerts = sqliteTable(
  "impersonation_alerts",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    subjectUserId: text("subject_user_id").notNull(),
    subjectUsername: text("subject_username").notNull(),
    subjectAvatarUrl: text("subject_avatar_url"),
    /** What was matched: a live member (matchedUserId) or a watchlist entry (matchedWatchlistId), never both. */
    matchedUserId: text("matched_user_id"),
    matchedWatchlistId: text("matched_watchlist_id"),
    matchedLabel: text("matched_label").notNull(),
    matchedAvatarUrl: text("matched_avatar_url"),
    trigger: text("trigger").notNull(), // "join" | "username" | "display_name" | "nickname" | "avatar"
    nameSimilarity: integer("name_similarity", { mode: "number" }),
    avatarDistance: integer("avatar_distance", { mode: "number" }),
    autoAction: text("auto_action"), // "timeout" | "kick" | "ban" | null
    status: text("status").notNull().default("open"), // "open" | "resolved" | "dismissed"
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("impersonation_alerts_guild_status_created").on(table.guildId, table.status, table.createdAt),
  ],
);

// --- Incident Response --------------------------------------------------------
// Correlates signals reported by other security plugins (Automod, Impersonation, Scam
// Protect, Automod's own raid rule) plus this plugin's own audit-log "nuke" detectors into a
// persisted Incident per (guild, entity), scored and escalated by src/plugins/incident_response.

/** One correlated incident per (guild, entity) within the configured correlation window. */
export const incidents = sqliteTable(
  "incidents",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    entityType: text("entity_type").notNull(), // "user" | "channel" | "guild"
    entityId: text("entity_id").notNull(),
    severity: text("severity").notNull().default("low"), // "low" | "medium" | "high" | "critical"
    riskScore: integer("risk_score", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("open"), // "open" | "acknowledged" | "resolved" | "dismissed"
    title: text("title").notNull(),
    signalCount: integer("signal_count", { mode: "number" }).notNull().default(0),
    sourceCount: integer("source_count", { mode: "number" }).notNull().default(0),
    /** Highest severity the Response Policy Engine has already acted on, so re-computing the
     * same severity after another signal never re-fires its actions. */
    respondedSeverity: text("responded_severity"),
    actionsTaken: text("actions_taken").notNull().default("[]"),
    firstSignalAt: integer("first_signal_at", { mode: "timestamp" }).notNull(),
    lastSignalAt: integer("last_signal_at", { mode: "timestamp" }).notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("incidents_guild_status").on(table.guildId, table.status),
    index("incidents_guild_entity").on(table.guildId, table.entityType, table.entityId),
  ],
);

/** Individual signal that fed into an incident — the "entity graph" edges on the dashboard. */
export const incidentSignals = sqliteTable(
  "incident_signals",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    incidentId: integer("incident_id", { mode: "number" }).notNull(),
    guildId: text("guild_id").notNull(),
    source: text("source").notNull(), // "automod" | "raid" | "impersonation" | "scam_protect" | "nuke_detection"
    signalType: text("signal_type").notNull(),
    weight: integer("weight", { mode: "number" }).notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    secondaryEntityType: text("secondary_entity_type"),
    secondaryEntityId: text("secondary_entity_id"),
    reason: text("reason").notNull(),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("incident_signals_incident").on(table.incidentId),
    index("incident_signals_guild_created").on(table.guildId, table.createdAt),
  ],
);

/** A channel lock the Response Policy Engine (or a manager via `/incident unlock`) applied,
 * recording the @everyone SendMessages state from just before locking so unlock restores it
 * exactly instead of guessing. */
export const incidentLockdowns = sqliteTable(
  "incident_lockdowns",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    incidentId: integer("incident_id", { mode: "number" }),
    previousOverwrite: text("previous_overwrite").notNull(), // "allow" | "deny" | "inherit"
    lockedAt: integer("locked_at", { mode: "timestamp" }).notNull(),
    lockedBy: text("locked_by").notNull(),
    unlockAt: integer("unlock_at", { mode: "timestamp" }),
    unlockedAt: integer("unlocked_at", { mode: "timestamp" }),
    unlockedBy: text("unlocked_by"),
  },
  (table) => [
    index("incident_lockdowns_guild").on(table.guildId),
    index("incident_lockdowns_unlock_at").on(table.unlockAt),
  ],
);

// --- Music: user-curated saved playlists (per-user, usable in any server) ---------------------

export const musicPlaylists = sqliteTable(
  "music_playlists",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("music_playlists_owner_name").on(table.ownerId, table.name),
    index("music_playlists_owner").on(table.ownerId),
  ],
);

export const musicPlaylistTracks = sqliteTable(
  "music_playlist_tracks",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id", { mode: "number" }).notNull(),
    position: integer("position", { mode: "number" }).notNull(),
    // Lavalink "encoded" track string - re-resolved via a title/author search fallback if stale.
    encoded: text("encoded"),
    title: text("title").notNull(),
    artist: text("artist"),
    uri: text("uri"),
    artworkUrl: text("artwork_url"),
    durationMs: integer("duration_ms", { mode: "number" }).notNull().default(0),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("music_playlist_tracks_playlist").on(table.playlistId, table.position)],
);

// --- Music: resume-on-restart session state ------------------------------------------------

/** One row per guild with an active/paused player, so it can rejoin and resume after a bot
 *  process restart. Written throttled by sessionPersistence.ts; deleted when the queue naturally
 *  empties and disconnects (unless stay_connected_247) or on explicit /stop or /leave. */
export const musicSessions = sqliteTable("music_sessions", {
  guildId: text("guild_id").primaryKey(),
  voiceChannelId: text("voice_channel_id").notNull(),
  textChannelId: text("text_channel_id").notNull(),
  // Full metadata (not just "encoded") so a track can be reconstructed synthetically on resume
  // without a re-resolve/decode round trip - encoded alone isn't enough to rebuild a Track object.
  currentTrackEncoded: text("current_track_encoded"),
  currentTrackTitle: text("current_track_title"),
  currentTrackAuthor: text("current_track_author"),
  currentTrackUri: text("current_track_uri"),
  currentTrackArtworkUrl: text("current_track_artwork_url"),
  currentTrackDurationMs: integer("current_track_duration_ms", { mode: "number" }),
  currentTrackSourceName: text("current_track_source_name"),
  currentTrackRequestedBy: text("current_track_requested_by"),
  positionMs: integer("position_ms", { mode: "number" }).notNull().default(0),
  volume: integer("volume", { mode: "number" }).notNull().default(80),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  loopMode: text("loop_mode").notNull().default("off"), // "off" | "track" | "queue"
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Queued-but-not-playing tracks for a guild's session, in order. Child of musicSessions. */
export const musicQueueItems = sqliteTable(
  "music_queue_items",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    position: integer("position", { mode: "number" }).notNull(),
    encoded: text("encoded").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    uri: text("uri"),
    artworkUrl: text("artwork_url"),
    durationMs: integer("duration_ms", { mode: "number" }).notNull().default(0),
    sourceName: text("source_name"),
    requestedBy: text("requested_by").notNull(),
  },
  (table) => [index("music_queue_items_guild").on(table.guildId, table.position)],
);
