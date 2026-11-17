import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/**
 * Server-specific currency: name and denominator only. Earn rates (message amount, message
 * cooldown, multiplier, daily amount) and the /exchange rate into global coins are deliberately
 * NOT configurable here — they're fixed bot-wide constants (see format.ts's SERVER_* constants
 * and SERVER_TO_GLOBAL_EXCHANGE_RATE). This closes off the one lever a server could
 * previously pull to mint unlimited server currency and, since /exchange converts it into global
 * coins, unlimited global coins with it. (This server used to also list itself as a tradeable
 * "stock" on a whole simulated exchange, with the exchange rate and /daily payout derived from
 * that stock's price — removed as needlessly complicated; /exchange now just uses a fixed rate.)
 */
export const zEconomyServerConfig = z.strictObject({
  currency_name: z.string().min(1).max(32).default("Coins").describe("Server currency display name (plural)."),
  currency_name_singular: z
    .string()
    .min(1)
    .max(32)
    .default("Coin")
    .describe("Server currency display name (singular)."),
  currency_denominator: z
    .string()
    .max(8)
    .default("$")
    .describe("Prefix shown in front of server currency amounts, e.g. $ in `$0.15`."),
  currency_emoji: z
    .string()
    .max(64)
    .default("")
    .describe(
      "Optional emoji shown next to server currency amounts. A Unicode emoji or a custom emoji like " +
        "<:coin:123> or <a:coin:123> for animated. Empty for none.",
    ),
  message_rewards_enabled: z.boolean().default(true).describe("Pay server currency for sending messages."),
});

export const zEconomyConfig = z.strictObject({
  server: zEconomyServerConfig.default({}),

  can_balance: boolPerm("view balances"),
  can_daily: boolPerm("claim the daily reward"),
  can_exchange: boolPerm("exchange server currency for global coins"),

  // The Hangar (/planes, plane and airline cards). The card catalog, packs and market are global
  // (bot-wide), not per-server, and managed only on the dashboard's superuser pages. These flags
  // only decide who can use each part of /planes in this server.
  can_view: boolPerm("view hangars, cards, ranks, sets and leaderboards, and set their showcase"),
  can_buy_pack: boolPerm("buy and open plane card packs"),
  can_give: boolPerm("give a plane card to another member"),
  can_sell: boolPerm("use the old sell button (no longer used: cards are salvaged for Parts with can_salvage instead)"),
  can_boarding: boolPerm("claim the free daily boarding pass"),
  can_salvage: boolPerm("salvage plane cards for Parts"),
  can_craft: boolPerm("craft plane cards with Parts"),
  can_repaint: boolPerm("repaint a plane card's livery for coins"),
  can_upgrade: boolPerm("level plane cards up with Parts"),
  can_fly: boolPerm("send plane cards on flights"),
  can_trade: boolPerm("trade plane cards with other members"),
  can_market: boolPerm("list and buy plane cards on the market"),
});

export const zEconomyPluginSection = zPluginSection(zEconomyConfig.shape, false);

export type EconomyServerConfig = z.infer<typeof zEconomyServerConfig>;
export type EconomyConfig = z.infer<typeof zEconomyConfig>;
