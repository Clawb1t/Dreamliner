import type { GuildConfig } from "../../config/schemas/guild.js";

/** Trims to a real value, or undefined if blank/missing — `??` alone treats `""` as "set". */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
