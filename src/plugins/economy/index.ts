import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { economyDefaultOverrides } from "./defaultOverrides.js";
import { economyCommands } from "./commands.js";
import { processEconomySweep } from "./functions/scheduler.js";
import { tryGrantMessageReward } from "./functions/activity.js";
import { loadEconomyConfig } from "./functions/config.js";
import type { Message, GuildMember } from "discord.js";

export const economyPlugin = definePlugin({
  name: "economy",
  configSchema: zEconomyConfig,
  defaultOverrides: economyDefaultOverrides,
  slashCommands: economyCommands,
  onLoad: async ({ client }) => {
    setInterval(() => {
      processEconomySweep(client).catch((err) => {
        console.error("Economy sweep failed:", err);
      });
    }, 60_000);
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as Message;
        if (!msg.guild || msg.author.bot || !msg.member) return;
        const config = await loadEconomyConfig(msg.guild.id);
        if (!config?.modules.activity_rewards) return;
        try {
          tryGrantMessageReward(msg.member as GuildMember, msg, config);
        } catch (err) {
          // Anti-farm skips throw EconomyError — ignore expected skips.
          if (err && typeof err === "object" && "code" in err) return;
          console.error("Economy activity reward failed:", err);
        }
      },
    },
  ],
});
