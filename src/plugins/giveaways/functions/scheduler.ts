import type { Client } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import { finishGiveaway, processExpiredClaims, spawnNextOccurrence, startGiveaway } from "./lifecycle.js";
import * as store from "./store.js";

export { finishGiveaway, refreshGiveawayMessage, startGiveaway } from "./lifecycle.js";

const log = getLogger("giveaways");

/** A giveaway left "ending" this long (the bot stopped mid-end) is finished again. Draws are idempotent. */
const STUCK_ENDING_MS = 2 * 60_000;

let running = false;

/** Posts every scheduled giveaway whose start has arrived. */
export async function processScheduledStarts(client: Client): Promise<void> {
  for (const giveaway of await store.getGiveawaysDueToStart(new Date())) {
    try {
      const guild = await client.guilds.fetch(giveaway.guildId).catch(() => null);
      if (!guild) continue;
      await startGiveaway(guild, giveaway);
    } catch (error) {
      log.error(`Failed to start giveaway #${giveaway.id}:`, error);
    }
  }
}

export async function processExpiredClaimWindows(client: Client): Promise<void> {
  for (const giveaway of await store.getGiveawaysWithExpiredClaims(new Date())) {
    try {
      await processExpiredClaims(client, giveaway);
    } catch (error) {
      log.error(`Failed to process the claim window for giveaway #${giveaway.id}:`, error);
    }
  }
}

/**
 * One scheduler pass: starts, ends (including any that came due while the bot was offline),
 * recovers giveaways stuck mid-end, expires claim windows and schedules missing recurring copies.
 * Runs every 30s and once on boot. Passes never overlap.
 */
export async function processDueGiveaways(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    await processScheduledStarts(client);

    for (const row of await store.getDueGiveaways(new Date())) {
      const claimed = await store.claimGiveawayForEnding(row.id);
      if (!claimed) continue;
      try {
        await finishGiveaway(client, claimed);
      } catch (error) {
        log.error(`Failed to end giveaway #${row.id}:`, error);
      }
    }

    for (const stuck of await store.getStuckEnding(new Date(Date.now() - STUCK_ENDING_MS))) {
      try {
        log.warn(`Giveaway #${stuck.id} was left mid-end; finishing it.`);
        await finishGiveaway(client, stuck);
      } catch (error) {
        log.error(`Failed to recover giveaway #${stuck.id}:`, error);
      }
    }

    await processExpiredClaimWindows(client);

    for (const ended of await store.getRecurringWithoutNext()) {
      await spawnNextOccurrence(ended).catch((error) => log.error(`Failed to schedule the next occurrence of giveaway #${ended.id}:`, error));
    }
  } finally {
    running = false;
  }
}
