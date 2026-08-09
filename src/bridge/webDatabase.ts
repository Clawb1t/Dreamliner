import {
  and,
  asc,
  count,
  desc,
  eq,
  like,
  or,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type DbColumnMeta = {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "datetime" | "json";
  searchable?: boolean;
};

export type DbTableMeta = {
  name: string;
  label: string;
  description: string;
  primaryKey: string[];
  columns: DbColumnMeta[];
  rowCount: number;
};

type TableDef = {
  name: string;
  label: string;
  description: string;
  table: SQLiteTable;
  guildId: Column;
  /** JS property names that form the row key (excluding guildId). */
  keyFields: string[];
  columns: Array<DbColumnMeta & { column: Column; redact?: "omit" | "preview" }>;
  defaultOrder?: { field: string; dir: "asc" | "desc" };
};

const PREVIEW_LEN = 180;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function col(
  column: Column,
  name: string,
  label: string,
  type: DbColumnMeta["type"],
  opts: { searchable?: boolean; redact?: "omit" | "preview" } = {},
): TableDef["columns"][number] {
  return { column, name, label, type, searchable: opts.searchable, redact: opts.redact };
}

const CATALOG: TableDef[] = [
  {
    name: "guild_configs",
    label: "Guild config",
    description: "Stored YAML config snapshots for this server.",
    table: schema.guildConfigs,
    guildId: schema.guildConfigs.guildId,
    keyFields: ["guildId"],
    defaultOrder: { field: "updatedAt", dir: "desc" },
    columns: [
      col(schema.guildConfigs.guildId, "guildId", "Guild ID", "string", { searchable: true }),
      col(schema.guildConfigs.configYaml, "configYaml", "Config YAML", "string", { redact: "preview" }),
      col(schema.guildConfigs.userConfigYaml, "userConfigYaml", "User YAML", "string", {
        redact: "preview",
      }),
      col(
        schema.guildConfigs.defaultsSnapshotYaml,
        "defaultsSnapshotYaml",
        "Defaults snapshot",
        "string",
        { redact: "preview" },
      ),
      col(schema.guildConfigs.updatedAt, "updatedAt", "Updated", "datetime"),
      col(schema.guildConfigs.updatedBy, "updatedBy", "Updated by", "string", { searchable: true }),
    ],
  },
  {
    name: "mod_cases",
    label: "Mod cases",
    description: "Infractions and moderation case history.",
    table: schema.modCases,
    guildId: schema.modCases.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.modCases.id, "id", "ID", "number", { searchable: true }),
      col(schema.modCases.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.modCases.modId, "modId", "Moderator ID", "string", { searchable: true }),
      col(schema.modCases.type, "type", "Type", "string", { searchable: true }),
      col(schema.modCases.reason, "reason", "Reason", "string", { searchable: true }),
      col(schema.modCases.active, "active", "Active", "boolean"),
      col(schema.modCases.expiresAt, "expiresAt", "Expires", "datetime"),
      col(schema.modCases.metadata, "metadata", "Metadata", "json", { redact: "preview" }),
      col(schema.modCases.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "name_history",
    label: "Name history",
    description: "Nickname and username change history.",
    table: schema.nameHistory,
    guildId: schema.nameHistory.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.nameHistory.id, "id", "ID", "number", { searchable: true }),
      col(schema.nameHistory.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.nameHistory.oldName, "oldName", "Old name", "string", { searchable: true }),
      col(schema.nameHistory.newName, "newName", "New name", "string", { searchable: true }),
      col(schema.nameHistory.changeType, "changeType", "Change type", "string", { searchable: true }),
      col(schema.nameHistory.changedAt, "changedAt", "Changed", "datetime"),
    ],
  },
  {
    name: "tags",
    label: "Tags",
    description: "Saved tag responses for this server.",
    table: schema.tags,
    guildId: schema.tags.guildId,
    keyFields: ["name"],
    defaultOrder: { field: "name", dir: "asc" },
    columns: [
      col(schema.tags.name, "name", "Name", "string", { searchable: true }),
      col(schema.tags.content, "content", "Content", "string", {
        searchable: true,
        redact: "preview",
      }),
      col(schema.tags.createdBy, "createdBy", "Created by", "string", { searchable: true }),
      col(schema.tags.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "dream_commands",
    label: "Dream commands",
    description: "Custom Dreamcode slash commands.",
    table: schema.dreamCommands,
    guildId: schema.dreamCommands.guildId,
    keyFields: ["name"],
    defaultOrder: { field: "updatedAt", dir: "desc" },
    columns: [
      col(schema.dreamCommands.name, "name", "Name", "string", { searchable: true }),
      col(schema.dreamCommands.source, "source", "Source", "string", { redact: "preview" }),
      col(schema.dreamCommands.triggerType, "triggerType", "Trigger", "string", { searchable: true }),
      col(schema.dreamCommands.minLevel, "minLevel", "Min level", "number"),
      col(schema.dreamCommands.createdBy, "createdBy", "Created by", "string", { searchable: true }),
      col(schema.dreamCommands.createdAt, "createdAt", "Created", "datetime"),
      col(schema.dreamCommands.updatedAt, "updatedAt", "Updated", "datetime"),
      col(schema.dreamCommands.enabled, "enabled", "Enabled", "boolean"),
    ],
  },
  {
    name: "guild_log_events",
    label: "Log events",
    description: "Persisted audit log events for Discord channels and the dashboard Logs page.",
    table: schema.guildLogEvents,
    guildId: schema.guildLogEvents.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "createdAt", dir: "desc" },
    columns: [
      col(schema.guildLogEvents.id, "id", "ID", "string", { searchable: true }),
      col(schema.guildLogEvents.category, "category", "Category", "string", { searchable: true }),
      col(schema.guildLogEvents.eventType, "eventType", "Event", "string", { searchable: true }),
      col(schema.guildLogEvents.title, "title", "Title", "string", { searchable: true }),
      col(schema.guildLogEvents.summary, "summary", "Summary", "string", { searchable: true }),
      col(schema.guildLogEvents.actorId, "actorId", "Actor ID", "string", { searchable: true }),
      col(schema.guildLogEvents.targetId, "targetId", "Target ID", "string", { searchable: true }),
      col(schema.guildLogEvents.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.guildLogEvents.caseId, "caseId", "Case ID", "number"),
      col(schema.guildLogEvents.createdAt, "createdAt", "Created", "datetime"),
      col(schema.guildLogEvents.payload, "payload", "Payload", "string", { redact: "preview" }),
    ],
  },
  {
    name: "log_messages",
    label: "Log messages",
    description: "Retained message content used by logging features.",
    table: schema.logMessages,
    guildId: schema.logMessages.guildId,
    keyFields: ["channelId", "messageId"],
    defaultOrder: { field: "updatedAt", dir: "desc" },
    columns: [
      col(schema.logMessages.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.logMessages.messageId, "messageId", "Message ID", "string", { searchable: true }),
      col(schema.logMessages.authorId, "authorId", "Author ID", "string", { searchable: true }),
      col(schema.logMessages.authorName, "authorName", "Author", "string", { searchable: true }),
      col(schema.logMessages.channelName, "channelName", "Channel", "string", { searchable: true }),
      col(schema.logMessages.content, "content", "Content", "string", {
        searchable: true,
        redact: "preview",
      }),
      col(schema.logMessages.updatedAt, "updatedAt", "Updated", "datetime"),
    ],
  },
  {
    name: "message_archives",
    label: "Message archives",
    description: "Archived message payloads (e.g. clean / purge archives).",
    table: schema.messageArchives,
    guildId: schema.messageArchives.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "createdAt", dir: "desc" },
    columns: [
      col(schema.messageArchives.id, "id", "ID", "string", { searchable: true }),
      col(schema.messageArchives.createdAt, "createdAt", "Created", "datetime"),
      col(schema.messageArchives.payload, "payload", "Payload", "json", { redact: "preview" }),
    ],
  },
  {
    name: "guild_message_counts",
    label: "Message counts",
    description: "Per-user lifetime message counts in this guild.",
    table: schema.guildMessageCounts,
    guildId: schema.guildMessageCounts.guildId,
    keyFields: ["userId"],
    defaultOrder: { field: "count", dir: "desc" },
    columns: [
      col(schema.guildMessageCounts.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.guildMessageCounts.count, "count", "Count", "number"),
    ],
  },
  {
    name: "guild_stats_daily",
    label: "Daily guild stats",
    description: "Per-day server activity totals.",
    table: schema.guildStatsDaily,
    guildId: schema.guildStatsDaily.guildId,
    keyFields: ["statDate"],
    defaultOrder: { field: "statDate", dir: "desc" },
    columns: [
      col(schema.guildStatsDaily.statDate, "statDate", "Date", "string", { searchable: true }),
      col(schema.guildStatsDaily.messages, "messages", "Messages", "number"),
      col(schema.guildStatsDaily.joins, "joins", "Joins", "number"),
      col(schema.guildStatsDaily.leaves, "leaves", "Leaves", "number"),
      col(schema.guildStatsDaily.edits, "edits", "Edits", "number"),
      col(schema.guildStatsDaily.deletes, "deletes", "Deletes", "number"),
      col(schema.guildStatsDaily.reactions, "reactions", "Reactions", "number"),
      col(schema.guildStatsDaily.attachments, "attachments", "Attachments", "number"),
    ],
  },
  {
    name: "guild_stats_user_daily",
    label: "Daily user stats",
    description: "Per-user daily message totals.",
    table: schema.guildStatsUserDaily,
    guildId: schema.guildStatsUserDaily.guildId,
    keyFields: ["userId", "statDate"],
    defaultOrder: { field: "statDate", dir: "desc" },
    columns: [
      col(schema.guildStatsUserDaily.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.guildStatsUserDaily.statDate, "statDate", "Date", "string", { searchable: true }),
      col(schema.guildStatsUserDaily.messages, "messages", "Messages", "number"),
    ],
  },
  {
    name: "guild_stats_channel_daily",
    label: "Daily channel stats",
    description: "Per-channel daily message totals.",
    table: schema.guildStatsChannelDaily,
    guildId: schema.guildStatsChannelDaily.guildId,
    keyFields: ["channelId", "statDate"],
    defaultOrder: { field: "statDate", dir: "desc" },
    columns: [
      col(schema.guildStatsChannelDaily.channelId, "channelId", "Channel ID", "string", {
        searchable: true,
      }),
      col(schema.guildStatsChannelDaily.statDate, "statDate", "Date", "string", { searchable: true }),
      col(schema.guildStatsChannelDaily.messages, "messages", "Messages", "number"),
    ],
  },
  {
    name: "starboard_posts",
    label: "Starboard posts",
    description: "Tracked starboard source and board messages.",
    table: schema.starboardPosts,
    guildId: schema.starboardPosts.guildId,
    keyFields: ["boardName", "sourceMessageId"],
    defaultOrder: { field: "createdAt", dir: "desc" },
    columns: [
      col(schema.starboardPosts.boardName, "boardName", "Board", "string", { searchable: true }),
      col(schema.starboardPosts.sourceMessageId, "sourceMessageId", "Source message", "string", {
        searchable: true,
      }),
      col(schema.starboardPosts.sourceChannelId, "sourceChannelId", "Source channel", "string", {
        searchable: true,
      }),
      col(schema.starboardPosts.starboardMessageId, "starboardMessageId", "Starboard message", "string", {
        searchable: true,
      }),
      col(schema.starboardPosts.starCount, "starCount", "Stars", "number"),
      col(schema.starboardPosts.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "censor_rules",
    label: "Censor rules",
    description: "Custom censor patterns and actions.",
    table: schema.censorRules,
    guildId: schema.censorRules.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.censorRules.id, "id", "ID", "number", { searchable: true }),
      col(schema.censorRules.pattern, "pattern", "Pattern", "string", { searchable: true }),
      col(schema.censorRules.regex, "regex", "Regex", "boolean"),
      col(schema.censorRules.action, "action", "Action", "string", { searchable: true }),
      col(schema.censorRules.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "reaction_role_mappings",
    label: "Reaction roles",
    description: "Emoji-to-role mappings on messages.",
    table: schema.reactionRoleMappings,
    guildId: schema.reactionRoleMappings.guildId,
    keyFields: ["messageId", "emoji"],
    columns: [
      col(schema.reactionRoleMappings.messageId, "messageId", "Message ID", "string", {
        searchable: true,
      }),
      col(schema.reactionRoleMappings.emoji, "emoji", "Emoji", "string", { searchable: true }),
      col(schema.reactionRoleMappings.roleId, "roleId", "Role ID", "string", { searchable: true }),
      col(schema.reactionRoleMappings.removeOnUnreact, "removeOnUnreact", "Remove on unreact", "boolean"),
    ],
  },
  {
    name: "role_button_panels",
    label: "Role buttons",
    description: "Button role panel bindings.",
    table: schema.roleButtonPanels,
    guildId: schema.roleButtonPanels.guildId,
    keyFields: ["messageId", "roleId"],
    columns: [
      col(schema.roleButtonPanels.messageId, "messageId", "Message ID", "string", { searchable: true }),
      col(schema.roleButtonPanels.roleId, "roleId", "Role ID", "string", { searchable: true }),
      col(schema.roleButtonPanels.label, "label", "Label", "string", { searchable: true }),
      col(schema.roleButtonPanels.style, "style", "Style", "string", { searchable: true }),
    ],
  },
  {
    name: "self_role_panels",
    label: "Self-role panels",
    description: "Self-assignable role panel configs.",
    table: schema.selfRolePanels,
    guildId: schema.selfRolePanels.guildId,
    keyFields: ["messageId"],
    columns: [
      col(schema.selfRolePanels.messageId, "messageId", "Message ID", "string", { searchable: true }),
      col(schema.selfRolePanels.config, "config", "Config", "json", { redact: "preview" }),
    ],
  },
  {
    name: "scheduled_posts",
    label: "Scheduled posts",
    description: "Queued and recurring posts.",
    table: schema.scheduledPosts,
    guildId: schema.scheduledPosts.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.scheduledPosts.id, "id", "ID", "number", { searchable: true }),
      col(schema.scheduledPosts.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.scheduledPosts.content, "content", "Content", "string", {
        searchable: true,
        redact: "preview",
      }),
      col(schema.scheduledPosts.cronExpr, "cronExpr", "Cron", "string", { searchable: true }),
      col(schema.scheduledPosts.nextRunAt, "nextRunAt", "Next run", "datetime"),
      col(schema.scheduledPosts.createdBy, "createdBy", "Created by", "string", { searchable: true }),
      col(schema.scheduledPosts.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "reminders",
    label: "Reminders",
    description: "Pending user reminders.",
    table: schema.reminders,
    guildId: schema.reminders.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "remindAt", dir: "asc" },
    columns: [
      col(schema.reminders.id, "id", "ID", "number", { searchable: true }),
      col(schema.reminders.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.reminders.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.reminders.message, "message", "Message", "string", {
        searchable: true,
        redact: "preview",
      }),
      col(schema.reminders.remindAt, "remindAt", "Remind at", "datetime"),
      col(schema.reminders.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "persisted_messages",
    label: "Persisted messages",
    description: "Pinned/persistent bot messages per channel.",
    table: schema.persistedMessages,
    guildId: schema.persistedMessages.guildId,
    keyFields: ["channelId"],
    columns: [
      col(schema.persistedMessages.channelId, "channelId", "Channel ID", "string", {
        searchable: true,
      }),
      col(schema.persistedMessages.messageId, "messageId", "Message ID", "string", {
        searchable: true,
      }),
      col(schema.persistedMessages.content, "content", "Content", "string", {
        searchable: true,
        redact: "preview",
      }),
    ],
  },
  {
    name: "channel_autodelete",
    label: "Channel autodelete",
    description: "Autodelete delay settings per channel.",
    table: schema.channelAutodelete,
    guildId: schema.channelAutodelete.guildId,
    keyFields: ["channelId"],
    columns: [
      col(schema.channelAutodelete.channelId, "channelId", "Channel ID", "string", {
        searchable: true,
      }),
      col(schema.channelAutodelete.delaySeconds, "delaySeconds", "Delay (seconds)", "number"),
    ],
  },
  {
    name: "autoreaction_state",
    label: "Autoreaction state",
    description: "Runtime counters for autoreaction rules.",
    table: schema.autoreactionState,
    guildId: schema.autoreactionState.guildId,
    keyFields: ["ruleId", "channelId"],
    columns: [
      col(schema.autoreactionState.ruleId, "ruleId", "Rule ID", "number", { searchable: true }),
      col(schema.autoreactionState.channelId, "channelId", "Channel ID", "string", {
        searchable: true,
      }),
      col(schema.autoreactionState.messageCount, "messageCount", "Message count", "number"),
      col(schema.autoreactionState.lastTriggeredAt, "lastTriggeredAt", "Last triggered", "datetime"),
    ],
  },
  {
    name: "autoreply_state",
    label: "Autoreply state",
    description: "Runtime counters for autoreply rules.",
    table: schema.autoreplyState,
    guildId: schema.autoreplyState.guildId,
    keyFields: ["ruleId", "channelId"],
    columns: [
      col(schema.autoreplyState.ruleId, "ruleId", "Rule ID", "number", { searchable: true }),
      col(schema.autoreplyState.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.autoreplyState.messageCount, "messageCount", "Message count", "number"),
      col(schema.autoreplyState.lastTriggeredAt, "lastTriggeredAt", "Last triggered", "datetime"),
    ],
  },
  {
    name: "custom_events",
    label: "Custom events",
    description: "Custom event hooks and responses.",
    table: schema.customEvents,
    guildId: schema.customEvents.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.customEvents.id, "id", "ID", "number", { searchable: true }),
      col(schema.customEvents.name, "name", "Name", "string", { searchable: true }),
      col(schema.customEvents.triggerType, "triggerType", "Trigger", "string", { searchable: true }),
      col(schema.customEvents.config, "config", "Config", "json", { redact: "preview" }),
      col(schema.customEvents.response, "response", "Response", "string", { redact: "preview" }),
      col(schema.customEvents.enabled, "enabled", "Enabled", "boolean"),
    ],
  },
  {
    name: "command_aliases",
    label: "Command aliases",
    description: "Custom command aliases for this server.",
    table: schema.commandAliases,
    guildId: schema.commandAliases.guildId,
    keyFields: ["name"],
    defaultOrder: { field: "name", dir: "asc" },
    columns: [
      col(schema.commandAliases.name, "name", "Alias", "string", { searchable: true }),
      col(schema.commandAliases.command, "command", "Command", "string", { searchable: true }),
      col(schema.commandAliases.options, "options", "Options", "json", { redact: "preview" }),
    ],
  },
  {
    name: "counters",
    label: "Counters",
    description: "Named counters and their Discord message bindings.",
    table: schema.counters,
    guildId: schema.counters.guildId,
    keyFields: ["name"],
    defaultOrder: { field: "name", dir: "asc" },
    columns: [
      col(schema.counters.name, "name", "Name", "string", { searchable: true }),
      col(schema.counters.channelId, "channelId", "Channel ID", "string", { searchable: true }),
      col(schema.counters.messageId, "messageId", "Message ID", "string", { searchable: true }),
      col(schema.counters.value, "value", "Value", "number"),
      col(schema.counters.counterType, "counterType", "Type", "string", { searchable: true }),
    ],
  },
  {
    name: "companion_channels",
    label: "Companion channels",
    description: "Companion / hub channel ownership records.",
    table: schema.companionChannels,
    guildId: schema.companionChannels.guildId,
    keyFields: ["ownerId"],
    columns: [
      col(schema.companionChannels.ownerId, "ownerId", "Owner ID", "string", { searchable: true }),
      col(schema.companionChannels.channelId, "channelId", "Channel ID", "string", {
        searchable: true,
      }),
    ],
  },
  {
    name: "managed_roles",
    label: "Managed roles",
    description: "Roles created/managed by the bot.",
    table: schema.managedRoles,
    guildId: schema.managedRoles.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.managedRoles.id, "id", "ID", "number", { searchable: true }),
      col(schema.managedRoles.name, "name", "Name", "string", { searchable: true }),
      col(schema.managedRoles.template, "template", "Template", "json", { redact: "preview" }),
      col(schema.managedRoles.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "bot_avatar_requests",
    label: "Bot avatar requests",
    description: "Pending and resolved guild bot avatar change requests.",
    table: schema.botAvatarRequests,
    guildId: schema.botAvatarRequests.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.botAvatarRequests.id, "id", "ID", "number", { searchable: true }),
      col(schema.botAvatarRequests.requesterId, "requesterId", "Requester", "string", {
        searchable: true,
      }),
      col(schema.botAvatarRequests.requestChannelId, "requestChannelId", "Request channel", "string", {
        searchable: true,
      }),
      col(schema.botAvatarRequests.requestMessageId, "requestMessageId", "Request message", "string", {
        searchable: true,
      }),
      col(schema.botAvatarRequests.reviewMessageId, "reviewMessageId", "Review message", "string", {
        searchable: true,
      }),
      col(schema.botAvatarRequests.avatarPng, "avatarPng", "Avatar PNG", "string", { redact: "omit" }),
      col(schema.botAvatarRequests.status, "status", "Status", "string", { searchable: true }),
      col(schema.botAvatarRequests.reviewerId, "reviewerId", "Reviewer", "string", { searchable: true }),
      col(schema.botAvatarRequests.createdAt, "createdAt", "Created", "datetime"),
      col(schema.botAvatarRequests.resolvedAt, "resolvedAt", "Resolved", "datetime"),
    ],
  },
  {
    name: "reviews",
    label: "Reviews",
    description: "Server reviews submitted via /review.",
    table: schema.reviews,
    guildId: schema.reviews.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "id", dir: "desc" },
    columns: [
      col(schema.reviews.id, "id", "ID", "number", { searchable: true }),
      col(schema.reviews.userId, "userId", "User", "string", { searchable: true }),
      col(schema.reviews.rating, "rating", "Rating", "number"),
      col(schema.reviews.content, "content", "Content", "string", { searchable: true }),
      col(schema.reviews.anonymous, "anonymous", "Anonymous", "boolean"),
      col(schema.reviews.channelId, "channelId", "Channel", "string", { searchable: true }),
      col(schema.reviews.messageId, "messageId", "Message", "string", { searchable: true }),
      col(schema.reviews.createdAt, "createdAt", "Created", "datetime"),
      col(schema.reviews.updatedAt, "updatedAt", "Updated", "datetime"),
      col(schema.reviews.deletedAt, "deletedAt", "Deleted", "datetime"),
    ],
  },
  {
    name: "suggestions",
    label: "Suggestions",
    description: "Community suggestions with review queue and voting.",
    table: schema.suggestions,
    guildId: schema.suggestions.guildId,
    keyFields: ["id"],
    defaultOrder: { field: "suggestionNumber", dir: "desc" },
    columns: [
      col(schema.suggestions.id, "id", "ID", "number", { searchable: true }),
      col(schema.suggestions.suggestionNumber, "suggestionNumber", "Number", "number", {
        searchable: true,
      }),
      col(schema.suggestions.authorId, "authorId", "Author", "string", { searchable: true }),
      col(schema.suggestions.content, "content", "Content", "string", { searchable: true }),
      col(schema.suggestions.status, "status", "Status", "string", { searchable: true }),
      col(schema.suggestions.displayStatus, "displayStatus", "Mark", "string", { searchable: true }),
      col(schema.suggestions.anonymous, "anonymous", "Anonymous", "boolean"),
      col(schema.suggestions.staffActorId, "staffActorId", "Staff", "string", { searchable: true }),
      col(schema.suggestions.denialReason, "denialReason", "Denial reason", "string", {
        searchable: true,
      }),
      col(schema.suggestions.createdAt, "createdAt", "Created", "datetime"),
      col(schema.suggestions.updatedAt, "updatedAt", "Updated", "datetime"),
      col(schema.suggestions.implementedAt, "implementedAt", "Implemented", "datetime"),
    ],
  },
  {
    name: "suggestion_blocks",
    label: "Suggestion blocks",
    description: "Users blocked from submitting suggestions.",
    table: schema.suggestionBlocks,
    guildId: schema.suggestionBlocks.guildId,
    keyFields: ["userId"],
    defaultOrder: { field: "createdAt", dir: "desc" },
    columns: [
      col(schema.suggestionBlocks.userId, "userId", "User", "string", { searchable: true }),
      col(schema.suggestionBlocks.reason, "reason", "Reason", "string", { searchable: true }),
      col(schema.suggestionBlocks.expiresAt, "expiresAt", "Expires", "datetime"),
      col(schema.suggestionBlocks.createdBy, "createdBy", "Created by", "string", { searchable: true }),
      col(schema.suggestionBlocks.createdAt, "createdAt", "Created", "datetime"),
    ],
  },
  {
    name: "mod_strikes",
    label: "Mod strikes",
    description: "Legacy strike counts (if populated).",
    table: schema.modStrikes,
    guildId: schema.modStrikes.guildId,
    keyFields: ["userId"],
    defaultOrder: { field: "count", dir: "desc" },
    columns: [
      col(schema.modStrikes.userId, "userId", "User ID", "string", { searchable: true }),
      col(schema.modStrikes.count, "count", "Count", "number"),
    ],
  },
];

const CATALOG_BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));

function getTable(tableName: string): TableDef | null {
  return CATALOG_BY_NAME.get(tableName) ?? null;
}

function serializeValue(
  value: unknown,
  meta: TableDef["columns"][number],
  mode: "list" | "detail",
): unknown {
  if (value == null) return null;
  if (meta.redact === "omit") {
    const bytes =
      typeof value === "string" ? Buffer.byteLength(value, "utf8") : String(value).length;
    return { omitted: true, bytes };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean" || typeof value === "number") return value;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (meta.redact === "preview" || (mode === "list" && text.length > PREVIEW_LEN)) {
    if (text.length > PREVIEW_LEN) {
      return `${text.slice(0, PREVIEW_LEN)}…`;
    }
  }
  if (mode === "detail" && meta.type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return text;
}

function serializeRow(
  row: Record<string, unknown>,
  def: TableDef,
  mode: "list" | "detail",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const meta of def.columns) {
    out[meta.name] = serializeValue(row[meta.name], meta, mode);
  }
  out.__rowKey = encodeRowKey(row, def);
  return out;
}

const ROW_KEY_SEP = "\u001f";

function encodeRowKey(row: Record<string, unknown>, def: TableDef): string {
  return def.keyFields.map((field) => String(row[field] ?? "")).join(ROW_KEY_SEP);
}

function decodeRowKey(raw: string, def: TableDef): Record<string, string> | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const parts = decoded.split(ROW_KEY_SEP);
  if (parts.length !== def.keyFields.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < def.keyFields.length; i++) {
    out[def.keyFields[i]!] = parts[i] ?? "";
  }
  return out;
}

function columnByName(def: TableDef, field: string): Column | null {
  return def.columns.find((c) => c.name === field)?.column ?? null;
}

function buildSearchFilter(def: TableDef, q: string): SQL | undefined {
  const trimmed = q.trim().slice(0, 120);
  if (!trimmed) return undefined;
  const pattern = `%${trimmed.replace(/[%_]/g, "\\$&")}%`;
  const searchable = def.columns.filter((c) => c.searchable);
  if (searchable.length === 0) return undefined;
  const clauses = searchable.map((c) =>
    c.type === "number" ? sql`cast(${c.column} as text) like ${pattern}` : like(c.column, pattern),
  );
  return or(...clauses);
}

export async function listGuildDbTables(guildId: string): Promise<{ tables: DbTableMeta[] }> {
  const db = getDb();
  const tables: DbTableMeta[] = [];

  for (const def of CATALOG) {
    const [row] = await db
      .select({ value: count() })
      .from(def.table)
      .where(eq(def.guildId, guildId));
    tables.push({
      name: def.name,
      label: def.label,
      description: def.description,
      primaryKey: def.keyFields,
      columns: def.columns.map(({ name, label, type, searchable }) => ({
        name,
        label,
        type,
        searchable: Boolean(searchable),
      })),
      rowCount: Number(row?.value ?? 0),
    });
  }

  tables.sort((a, b) => a.label.localeCompare(b.label));
  return { tables };
}

export async function queryGuildDbTable(
  guildId: string,
  tableName: string,
  opts: { q?: string; limit?: number; offset?: number; orderBy?: string; order?: string },
): Promise<
  | {
      ok: true;
      table: string;
      label: string;
      description: string;
      columns: DbColumnMeta[];
      primaryKey: string[];
      rows: Record<string, unknown>[];
      total: number;
      limit: number;
      offset: number;
    }
  | { ok: false; status: number; error: string }
> {
  const def = getTable(tableName);
  if (!def) return { ok: false, status: 404, error: "Unknown table." };

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const orderField =
    (opts.orderBy && columnByName(def, opts.orderBy) ? opts.orderBy : null) ??
    def.defaultOrder?.field ??
    def.keyFields[0]!;
  const orderDir =
    opts.order === "asc" || opts.order === "desc"
      ? opts.order
      : (def.defaultOrder?.dir ?? "desc");
  const orderCol = columnByName(def, orderField)!;

  const filters: SQL[] = [eq(def.guildId, guildId)];
  const search = buildSearchFilter(def, opts.q ?? "");
  if (search) filters.push(search);
  const where = and(...filters)!;

  const db = getDb();
  const [totalRow] = await db.select({ value: count() }).from(def.table).where(where);
  const rows = await db
    .select()
    .from(def.table)
    .where(where)
    .orderBy(orderDir === "asc" ? asc(orderCol) : desc(orderCol))
    .limit(limit)
    .offset(offset);

  return {
    ok: true,
    table: def.name,
    label: def.label,
    description: def.description,
    columns: def.columns.map(({ name, label, type, searchable }) => ({
      name,
      label,
      type,
      searchable: Boolean(searchable),
    })),
    primaryKey: def.keyFields,
    rows: rows.map((row) => serializeRow(row as Record<string, unknown>, def, "list")),
    total: Number(totalRow?.value ?? 0),
    limit,
    offset,
  };
}

export async function getGuildDbRow(
  guildId: string,
  tableName: string,
  rowKey: string,
): Promise<
  | {
      ok: true;
      table: string;
      label: string;
      columns: DbColumnMeta[];
      primaryKey: string[];
      row: Record<string, unknown>;
    }
  | { ok: false; status: number; error: string }
> {
  const def = getTable(tableName);
  if (!def) return { ok: false, status: 404, error: "Unknown table." };

  const decoded = decodeRowKey(rowKey, def);
  if (!decoded) return { ok: false, status: 400, error: "Invalid row key." };

  const filters: SQL[] = [eq(def.guildId, guildId)];
  for (const field of def.keyFields) {
    const column = columnByName(def, field);
    if (!column) return { ok: false, status: 500, error: "Invalid table catalog." };
    const raw = decoded[field] ?? "";
    const meta = def.columns.find((c) => c.name === field);
    const value = meta?.type === "number" ? Number(raw) : raw;
    if (meta?.type === "number" && !Number.isFinite(value as number)) {
      return { ok: false, status: 400, error: "Invalid row key." };
    }
    filters.push(eq(column, value as never));
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(def.table)
    .where(and(...filters))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "Row not found." };

  return {
    ok: true,
    table: def.name,
    label: def.label,
    columns: def.columns.map(({ name, label, type, searchable }) => ({
      name,
      label,
      type,
      searchable: Boolean(searchable),
    })),
    primaryKey: def.keyFields,
    row: serializeRow(row as Record<string, unknown>, def, "detail"),
  };
}
