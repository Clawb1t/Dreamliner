import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { activeTiers, loadBoosterRolesConfig } from "./config.js";
import { syncBoosterRoles } from "./apply.js";

/**
 * Re-sync every currently boosting member in every guild with `booster_roles` enabled. Needed
 * because tier eligibility changes purely with elapsed time — no Discord event fires the moment
 * a booster crosses a duration threshold, unlike starting/stopping a boost (handled by the
 * `GuildMemberUpdate` listener in index.ts).
 */
export async function sweepBoosterRoles(client: Client): Promise<void> {
  for (const [, guild] of client.guilds.cache) {
    const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
    if (!guildConfig || !pluginEnabled(guildConfig, "booster_roles")) continue;

    const config = loadBoosterRolesConfig(guildConfig);
    if (activeTiers(config).length === 0) continue;

    const members = await guild.members.fetch().catch(() => null);
    if (!members) continue;

    for (const member of members.values()) {
      if (!member.premiumSince) continue;
      await syncBoosterRoles(member, config).catch(() => null);
    }
  }
}
