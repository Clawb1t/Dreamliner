import type { ImpersonationConfig } from "../../../config/schemas/impersonation.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("impersonation");

/** Protected roles plus extra role ids, deduplicated, original order first. */
export function mergeProtectedRoles(protectedRoles: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...protectedRoles, ...extra])];
}

/**
 * When `protect_team_ranks` is on and Team Control is enabled, returns the config with every
 * Team Control rank role merged into `protected_roles`, so everyone with a staff rank counts as
 * a protected identity (and is never flagged themselves). Read at check time, so rank changes
 * apply immediately. Any failure falls back to the config as-is.
 */
export async function withTeamRankProtection(guildId: string, config: ImpersonationConfig): Promise<ImpersonationConfig> {
  if (!config.protect_team_ranks) return config;
  try {
    const { loadActiveTeamControl } = await import("../../team_control/functions/config.js");
    const active = await loadActiveTeamControl(guildId);
    if (!active) return config;
    const { rankRoleIds } = await import("../../team_control/functions/ranks.js");
    const rankRoles = rankRoleIds(active.config.ranks ?? []);
    if (!rankRoles.length) return config;
    return { ...config, protected_roles: mergeProtectedRoles(config.protected_roles, rankRoles) };
  } catch (err) {
    log.error("Team Control rank lookup failed:", err);
    return config;
  }
}
