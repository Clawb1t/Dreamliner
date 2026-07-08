import type { GuildConfig } from "../../config/schemas/guild.js";

export function getModerationLogChannelId(
  guildConfig: GuildConfig,
  caseLogOverride?: string | null,
): string | undefined {
  return caseLogOverride ?? guildConfig.moderation_log_channel_id ?? guildConfig.log_channel_id;
}

export function getServerLogChannelId(guildConfig: GuildConfig): string | undefined {
  return guildConfig.server_log_channel_id;
}
