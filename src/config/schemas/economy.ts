import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

const nonNegNumber = (help: string, fallback: number, max = 1_000_000) =>
  z.number().min(0).max(max).default(fallback).describe(help);

/** Server-specific currency: name, denominator, and manager-tunable earn rates. */
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
  message_amount: nonNegNumber("Server currency earned per rewarded message.", 0.1, 10_000),
  message_cooldown_seconds: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(60)
    .describe("Cooldown between message rewards for a member."),
  multiplier: z
    .number()
    .min(0)
    .max(100)
    .default(1)
    .describe("Multiplier applied to all server currency earned (message rewards and daily claims)."),
  daily_amount: nonNegNumber("Server currency granted on /daily claim.", 5, 1_000_000),
});

export const zEconomyConfig = z.strictObject({
  server: zEconomyServerConfig.default({}),

  can_balance: boolPerm("view balances"),
  can_daily: boolPerm("claim the daily reward"),
  can_stock_trade: boolPerm("buy and sell stocks on the Dreamliner Exchange"),
  can_admin_manage: boolPerm("change server economy settings (name, denominator, multiplier, rates)"),
});

export const zEconomyPluginSection = zPluginSection(zEconomyConfig.shape);

export type EconomyServerConfig = z.infer<typeof zEconomyServerConfig>;
export type EconomyConfig = z.infer<typeof zEconomyConfig>;
