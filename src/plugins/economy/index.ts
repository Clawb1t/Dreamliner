import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { economyCommands } from "./commands.js";
import { grantMessageRewards } from "./functions/activity.js";
import { loadEconomyConfig } from "./functions/config.js";
import { recordStockActivity, tickStockPrices } from "./functions/stocks.js";
import type { Message, GuildMember } from "discord.js";

export { handlePlanesAutocomplete } from "./commands.js";
export {
  handlePlaneStatsButtonInteraction,
  PLANE_STATS_PREFIX,
  handlePlanePackButtonInteraction,
  PLANE_PACK_PREFIX,
  handlePlaneInventoryButtonInteraction,
  PLANE_INVENTORY_PREFIX,
  handlePlaneSellButtonInteraction,
  PLANE_SELL_PREFIX,
} from "./functions/cardButtons.js";

/** Stock prices are checked once a minute against that minute's message activity, see stocks.ts. */
const STOCK_TICK_INTERVAL_MS = 60_000;
const STOCK_TICK_INITIAL_DELAY_MS = 15_000;

export const economyPlugin = definePlugin({
  name: "economy",
  configSchema: zEconomyConfig,
  slashCommands: economyCommands,
  onLoad: async ({ client }) => {
    const tick = () => {
      tickStockPrices(client).catch((err) => {
        console.error("Stock price tick failed:", err);
      });
    };
    setTimeout(tick, STOCK_TICK_INITIAL_DELAY_MS);
    setInterval(tick, STOCK_TICK_INTERVAL_MS);
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
          recordStockActivity(msg.guild.id, msg.guild.name, msg.guild.iconURL({ size: 64 }));
        } catch (err) {
          console.error("Economy activity reward failed:", err);
        }
      },
    },
  ],
});
