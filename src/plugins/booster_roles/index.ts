import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zBoosterRolesConfig } from "../../config/schemas/boosterRoles.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { boosterRolesCommands } from "./commands.js";
import { activeTiers, loadBoosterRolesConfig } from "./functions/config.js";
import { syncBoosterRoles } from "./functions/apply.js";
import { sweepBoosterRoles } from "./functions/sweep.js";

export const boosterRolesPlugin = definePlugin({
  name: "booster_roles",
  configSchema: zBoosterRolesConfig,
  slashCommands: boosterRolesCommands,
  onLoad: async () => {
    // Tier eligibility changes purely with elapsed time, so re-check every currently boosting
    // member on an interval — nothing in Discord's gateway tells us a duration threshold passed.
    registerIntervalTask({
      id: "booster-roles:sweep",
      intervalMs: 15 * 60_000,
      run: sweepBoosterRoles,
    });
  },
  events: [
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const oldM = oldMember as import("discord.js").GuildMember | import("discord.js").PartialGuildMember;
        const newM = newMember as import("discord.js").GuildMember;
        if (!newM.guild) return;
        if (oldM.premiumSince?.getTime() === newM.premiumSince?.getTime()) return;

        const guildConfig = await configManager.getEffectiveConfig(newM.guild.id);
        if (!pluginEnabled(guildConfig, "booster_roles")) return;

        const config = loadBoosterRolesConfig(guildConfig);
        if (activeTiers(config).length === 0) return;

        await syncBoosterRoles(newM, config).catch(() => null);
      },
    },
  ],
});
