import type { EconomyServerConfig } from "../../../config/schemas/economy.js";

/** Fixed global currency — same across every server. */
export const GLOBAL_CURRENCY_NAME = "Coins";
export const GLOBAL_CURRENCY_DENOMINATOR = "$";
export const GLOBAL_CURRENCY_EMOJI = "<:coin:1543696697685844048>";
export const GLOBAL_MESSAGE_AMOUNT = 0.15;
export const GLOBAL_MESSAGE_COOLDOWN_SECONDS = 60;
export const GLOBAL_DAILY_AMOUNT = 5;

export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

export function formatGlobal(amount: number): string {
  return `${GLOBAL_CURRENCY_EMOJI} \`${GLOBAL_CURRENCY_DENOMINATOR}${formatAmount(amount)}\` ${GLOBAL_CURRENCY_NAME}`;
}

export function formatServer(amount: number, server: EconomyServerConfig): string {
  const name = amount === 1 ? server.currency_name_singular : server.currency_name;
  const emoji = server.currency_emoji.trim();
  const prefix = emoji ? `${emoji} ` : "";
  return `${prefix}\`${server.currency_denominator}${formatAmount(amount)}\` ${name}`;
}
