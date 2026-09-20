import type { GuildConfig } from "../../config/schemas/guild.js";
import type { LogEventType } from "./events.js";

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
