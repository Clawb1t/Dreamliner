import type { Guild } from "discord.js";
import {
  backfillBoostCounts,
  getBoostCountingStatus,
  type BackfillResult,
  type BoostCountingStatus,
} from "../plugins/booster_roles/functions/boostCounts.js";
import { syncBoosterRoles } from "../plugins/booster_roles/functions/apply.js";
import { activeTiers, loadBoosterRolesConfig } from "../plugins/booster_roles/functions/config.js";
import { configManager } from "../config/manager.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("booster_roles");

/** One backfill at a time per guild, and not more often than this. */
const BACKFILL_COOLDOWN_MS = 10 * 60_000;
const running = new Set<string>();
const lastRun = new Map<string, number>();
const lastResult = new Map<string, BackfillResult>();

export type WebBoostCounting = BoostCountingStatus & {
  running: boolean;
  /** The last backfill's outcome since the bot started (errors aren't stored anywhere else). */
  lastResult: BackfillResult | null;
};

export async function getWebBoostCounting(guild: Guild): Promise<WebBoostCounting> {
  return {
    ...(await getBoostCountingStatus(guild)),
    running: running.has(guild.id),
    lastResult: lastResult.get(guild.id) ?? null,
  };
}

export type WebBackfillStart = { started: true } | { started: false; error: "busy" | "cooldown"; retryAfterMs?: number };

/** Starts counting past boosts in the background (it can read thousands of messages), then
 *  re-syncs every booster's tier roles with the new counts. Poll getWebBoostCounting for the end. */
export function startWebBoostBackfill(guild: Guild): WebBackfillStart {
  if (running.has(guild.id)) return { started: false, error: "busy" };
  const wait = (lastRun.get(guild.id) ?? 0) + BACKFILL_COOLDOWN_MS - Date.now();
  if (wait > 0) return { started: false, error: "cooldown", retryAfterMs: wait };

  running.add(guild.id);
  lastRun.set(guild.id, Date.now());
  void (async () => {
    try {
      const result = await backfillBoostCounts(guild);
      lastResult.set(guild.id, result);
      if (!result.ok) return;
      const config = loadBoosterRolesConfig(await configManager.getEffectiveConfig(guild.id));
      if (activeTiers(config).length === 0) return;
      for (const member of guild.members.cache.values()) {
        if (member.premiumSince) await syncBoosterRoles(member, config).catch(() => null);
      }
    } catch (error) {
      log.error(`[booster_roles] Boost backfill failed for ${guild.id}:`, error);
    } finally {
      running.delete(guild.id);
    }
  })();
  return { started: true };
}
