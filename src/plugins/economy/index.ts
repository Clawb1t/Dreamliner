import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { economyCommands } from "./commands.js";
import { grantMessageRewards } from "./functions/activity.js";
import { loadEconomyConfig } from "./functions/config.js";
import { startHangarJobs } from "./hangar/jobs.js";
import type { Message, GuildMember } from "discord.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("economy");

export { handlePlanesAutocomplete } from "./commands.js";
export { handleHangarButton, handleHangarModal, isHangarComponent } from "./hangar/discord/components.js";

export const economyPlugin = definePlugin({
  name: "economy",
  configSchema: zEconomyConfig,
  slashCommands: economyCommands,
  onLoad: async () => {
    startHangarJobs();
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as Message;
        if (!msg.guild || msg.author.bot || !msg.member) return;
        try {
          const config = await loadEconomyConfig(msg.guild.id);
          if (!config) return;
          grantMessageRewards(msg.member as GuildMember, msg, config);
        } catch (err) {
          log.error("Economy activity reward failed:", err);
        }
      },
    },
  ],
});
