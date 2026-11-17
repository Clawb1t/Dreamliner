import { registerIntervalTask } from "../../../core/scheduler.js";
import { getLogger } from "../../../core/logger.js";
import { expireListings } from "./market.js";
import { refreshStaleScores } from "./score.js";
import { expireTrades } from "./trades.js";

const log = getLogger("economy");

/**
 * Background upkeep for the Hangar. Flights need no timer: they settle on claim from the stored
 * landing time, so a restart can't lose one. Trades and listings are expired here (which releases
 * their card locks); expiry is also enforced at accept/buy time, so a late sweep is harmless.
 */
export function startHangarJobs(): void {
  try {
    const refreshed = refreshStaleScores();
    if (refreshed) log.info(`Hangar: recomputed ${refreshed} stale Fleet Value scores.`);
  } catch (error) {
    log.error("Hangar score refresh failed:", error);
  }
  registerIntervalTask({
    id: "hangar-expiry",
    intervalMs: 5 * 60 * 1000,
    run: async () => {
      const trades = expireTrades();
      const listings = expireListings();
      if (trades || listings) log.info(`Hangar: expired ${trades} trades and ${listings} listings.`);
    },
  });
}
