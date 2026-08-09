import type { GuildConfig } from "../../config/schemas/guild.js";
import { isLogEventType, type LogEventType } from "./events.js";

/** Missing keys default to enabled so existing configs stay fully logged. */
export function isLogEventEnabled(guildConfig: GuildConfig, eventType: LogEventType): boolean {
  const events = guildConfig.logging?.events;
  if (!events || typeof events !== "object") return true;
  const value = events[eventType];
  if (value === undefined) return true;
  return value !== false;
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
