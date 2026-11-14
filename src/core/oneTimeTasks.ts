import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildConfigs, oneTimeTasks } from "../db/schema.js";
import { configManager } from "../config/manager.js";
import { getLogger } from "./logger.js";

const log = getLogger("core");

/** Runs `task` once ever (per database): it's recorded in one_time_tasks only after it succeeds. */
export async function runOnce(id: string, task: () => Promise<void>): Promise<void> {
  const db = getDb();
  const done = await db.select().from(oneTimeTasks).where(eq(oneTimeTasks.id, id)).get();
  if (done) return;
  try {
    await task();
    await db.insert(oneTimeTasks).values({ id, doneAt: new Date() }).onConflictDoNothing();
    log.info(`One-time task "${id}" finished.`);
  } catch (error) {
    log.error(`One-time task "${id}" failed; it will try again next start:`, error);
  }
}

/** Stats became on by default (2026-11-14): switch it on for every server that has a saved config. */
export async function enableStatsEverywhere(): Promise<void> {
  const rows = await getDb().select({ guildId: guildConfigs.guildId }).from(guildConfigs).all();
  let changed = 0;
  for (const { guildId } of rows) {
    const config = await configManager.getEffectiveConfig(guildId).catch(() => null);
    if (!config || config.plugins.stats?.enabled === true) continue;
    const result = await configManager.setPluginEnabled(guildId, "stats", true, "system:stats-default");
    if (result.success) changed++;
    else log.warn(`Couldn't turn Stats on for guild ${guildId}: ${result.errors.join("; ")}`);
  }
  log.info(`Stats is now on in ${changed} more server(s) (${rows.length} checked).`);
}
