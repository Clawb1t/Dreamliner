import type { EconomyServerConfig } from "../../../config/schemas/economy.js";

/** Fixed global currency — same across every server. */
export const GLOBAL_CURRENCY_NAME = "Coins";
export const GLOBAL_CURRENCY_DENOMINATOR = "$";
export const GLOBAL_CURRENCY_EMOJI = "<:icons_coin:1544417186951598130>";
export const GLOBAL_MESSAGE_AMOUNT = 0.15;
export const GLOBAL_MESSAGE_COOLDOWN_SECONDS = 60;
export const GLOBAL_DAILY_AMOUNT = 5;

/**
 * Fixed server-currency earn rates — same across every server, not admin-configurable (see
 * economy.ts's schema comment for why).
 */
export const SERVER_MESSAGE_AMOUNT = 0.1;
export const SERVER_MESSAGE_COOLDOWN_SECONDS = 5;
export const SERVER_DAILY_AMOUNT = 5;

/**
 * Fixed server-currency -> global-coin conversion rate for /exchange, e.g. 100 server currency
 * becomes 10 global coins at 0.1. Used to be derived from a per-server simulated "stock price"
 * (see git history) — removed as needlessly complicated. Not admin-configurable, for the same
 * anti-abuse reason as the rest of this file's constants: a server owner could otherwise mint
 * unlimited global coins by setting their own rate.
 */
export const SERVER_TO_GLOBAL_EXCHANGE_RATE = 0.1;

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

/** A coin amount without the trailing currency name — for pack prices, card sale prices, etc. */
export function formatCoinAmount(amount: number): string {
  return `${GLOBAL_CURRENCY_EMOJI} \`${GLOBAL_CURRENCY_DENOMINATOR}${formatAmount(amount)}\``;
}

/** A server → global exchange rate, e.g. "1.00x". */
export function formatExchangeRate(rate: number): string {
  return `${rate.toFixed(2)}x`;
}
