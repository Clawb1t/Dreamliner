import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { isBoosting } from "../../../core/boosterStatus.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { activeTiers, loadBoosterRolesConfig } from "./config.js";
import { syncBoosterRoles } from "./apply.js";

/**
 * Re-sync every currently boosting member in every guild with `booster_roles` enabled. Needed
 * because tier eligibility changes purely with elapsed time — no Discord event fires the moment
 * a booster crosses a duration threshold, unlike starting/stopping a boost (handled by the
 * `GuildMemberUpdate` listener in index.ts).
 */
/** How often the sweep re-downloads a server's whole member list as a safety net. */
const FULL_FETCH_EVERY_MS = 6 * 60 * 60_000;
/** Per guild: when its member list was last fully fetched. One entry per guild the bot is in. */
const lastFullFetch = new Map<string, number>();

export async function sweepBoosterRoles(client: Client): Promise<void> {
  for (const id of lastFullFetch.keys()) if (!client.guilds.cache.has(id)) lastFullFetch.delete(id);
  for (const [, guild] of client.guilds.cache) {
    const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
    if (!guildConfig || !pluginEnabled(guildConfig, "booster_roles")) continue;

    const config = loadBoosterRolesConfig(guildConfig);
    if (activeTiers(config).length === 0) continue;

    // Boosters stay in the member cache (see core/clientCache.ts) and new boosts arrive as member
    // updates, so the cache is enough between occasional full re-downloads of the member list.
    const now = Date.now();
    let members = guild.members.cache;
    if (now - (lastFullFetch.get(guild.id) ?? 0) >= FULL_FETCH_EVERY_MS) {
      const fetched = await guild.members.fetch().catch(() => null);
      if (!fetched) continue;
      lastFullFetch.set(guild.id, now);
      members = fetched;
    }

    for (const member of members.values()) {
      if (!isBoosting(member)) continue;
      await syncBoosterRoles(member, config).catch(() => null);
    }
  }
}
