import type { GuildConfig } from "../../config/schemas/guild.js";
import { LOG_EVENT_META, type LogEventType } from "./events.js";

/** Trims to a real value, or undefined if blank/missing — `??` alone treats `""` as "set". */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A per-event channel override, set from the dashboard's Logging page. Takes priority over
 *  everything else (a plugin's own log channel, then the moderation/server default) when set. */
export function getEventChannelOverride(guildConfig: GuildConfig, eventType: LogEventType): string | undefined {
  return nonEmpty(guildConfig.logging?.channels?.[eventType]);
}

export function getModerationLogChannelId(
  guildConfig: GuildConfig,
  caseLogOverride?: string | null,
): string | undefined {
  return (
    nonEmpty(caseLogOverride) ??
    nonEmpty(guildConfig.moderation_log_channel_id) ??
    nonEmpty(guildConfig.log_channel_id)
  );
}

export function getServerLogChannelId(guildConfig: GuildConfig): string | undefined {
  return nonEmpty(guildConfig.server_log_channel_id);
}

/** Where a log for `eventType` is delivered, in priority order: the per-event override, then the
 *  plugin's own log channel (when the caller passes one), then the moderation/server default. */
export function resolveLogChannelId(
  guildConfig: GuildConfig,
  eventType: LogEventType,
  pluginChannelId?: string | null,
): string | undefined {
  return (
    getEventChannelOverride(guildConfig, eventType) ??
    (LOG_EVENT_META[eventType].category === "moderation"
      ? getModerationLogChannelId(guildConfig, pluginChannelId)
      : (nonEmpty(pluginChannelId) ?? getServerLogChannelId(guildConfig)))
  );
}
