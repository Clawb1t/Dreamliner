import type { GuildConfig } from "../config/schemas/guild.js";

/** Whether command replies should only be visible to the invoking user. */
export function resolveEphemeral(guildConfig: GuildConfig): boolean {
  return guildConfig.ephemeral_responses;
}
