import type { GuildConfig } from "../../config/schemas/guild.js";
import { isLogEventType, type LogEventType } from "./events.js";

/** The specific "case_<type>" events (case_mute, case_ban, ...) used to all be one generic
 *  "case_create" toggle. A guild that explicitly disabled "case_create" before these existed
 *  should keep silencing every case type until they touch one of the new keys directly, so
 *  each one falls back to case_create's own setting when it has no explicit value of its own. */
const LOG_EVENT_LEGACY_FALLBACK: Partial<Record<LogEventType, LogEventType>> = {
  case_warn: "case_create",
  case_note: "case_create",
  case_mute: "case_create",
  case_tempmute: "case_create",
  case_unmute: "case_create",
  case_kick: "case_create",
  case_ban: "case_create",
  case_tempban: "case_create",
  case_unban: "case_create",
  case_softban: "case_create",
};

/** Missing keys default to enabled so existing configs stay fully logged. */
export function isLogEventEnabled(guildConfig: GuildConfig, eventType: LogEventType): boolean {
  const events = guildConfig.logging?.events;
  if (!events || typeof events !== "object") return true;
  const value = events[eventType];
  if (value !== undefined) return value !== false;
  const legacyKey = LOG_EVENT_LEGACY_FALLBACK[eventType];
  const legacyValue = legacyKey ? events[legacyKey] : undefined;
  if (legacyValue !== undefined) return legacyValue !== false;
  return true;
}

export function isAnyMessageLogEnabled(guildConfig: GuildConfig): boolean {
  return (
    isLogEventEnabled(guildConfig, "message_edit") ||
    isLogEventEnabled(guildConfig, "message_delete") ||
    isLogEventEnabled(guildConfig, "message_pin") ||
    isLogEventEnabled(guildConfig, "message_bulk_delete")
  );
}

export function parseEventTypeParam(raw: string | null): LogEventType | null {
  if (!raw) return null;
  return isLogEventType(raw) ? raw : null;
}
