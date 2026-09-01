import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/**
 * Server-specific currency: name and denominator only. Earn rates (message amount, message
 * cooldown, multiplier, daily amount) are deliberately NOT configurable here anymore — they're
 * fixed bot-wide constants (see format.ts's SERVER_* constants), with the daily reward scaling
 * automatically with that server's own Dreamliner Exchange stock price instead of an
 * admin-settable number. This closes off the one lever a server could previously pull to mint
 * unlimited server currency and, since /exchange converts it into global coins, unlimited global
 * coins with it.
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
  can_stock_trade: boolPerm("buy and sell stocks on the Dreamliner Exchange"),
  can_exchange: boolPerm("exchange server currency for global coins"),
  can_admin_manage: boolPerm("change server economy settings (name, denominator, and whether message rewards are on)"),

  // Trading cards (/planes — planes and airlines). The card catalog and packs are global
  // (bot-wide), not per-server — managed only via the dashboard's superuser catalog page, never
  // through this per-guild config (see functions/settings.ts).
  can_view: boolPerm("view the plane card catalog, card details, and inventories"),
  can_buy_pack: boolPerm("buy and open plane card packs"),
  can_give: boolPerm("give a plane card (1 at a time) to another member"),
  can_sell: boolPerm("sell a plane card for global coins"),
});

export const zEconomyPluginSection = zPluginSection(zEconomyConfig.shape);

export type EconomyServerConfig = z.infer<typeof zEconomyServerConfig>;
export type EconomyConfig = z.infer<typeof zEconomyConfig>;
