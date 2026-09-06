/**
 * How long a server's message *content* (not counts/timestamps) stays
 * retained before being scrubbed. This is a server-wide config setting
 * (`content_retention_days` on the guild config), not a personal privacy
 * toggle, set from the dashboard's Server page alongside everything else.
 */
export const GUILD_CONTENT_RETENTION_OPTIONS = [1, 7, 14, 30] as const;
export type GuildContentRetentionDays = (typeof GUILD_CONTENT_RETENTION_OPTIONS)[number];
export const DEFAULT_GUILD_CONTENT_RETENTION_DAYS: GuildContentRetentionDays = 30;

export const REDACTED_CONTENT_PLACEHOLDER = "[content no longer retained]";

/** Reads the effective config's `content_retention_days` (config manager already caches this
 * in memory, so no extra caching layer is needed here). */
export async function getGuildContentRetentionDays(guildId: string): Promise<number> {
  const { configManager } = await import("../config/manager.js");
  const config = await configManager.getEffectiveConfig(guildId);
  return config.content_retention_days ?? DEFAULT_GUILD_CONTENT_RETENTION_DAYS;
}

export function isContentExpired(referenceDate: Date, retentionDays: number): boolean {
  if (retentionDays <= 0) return true;
  const ageMs = Date.now() - referenceDate.getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}
