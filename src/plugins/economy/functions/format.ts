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
 * economy.ts's schema comment for why). `SERVER_DAILY_BASE_AMOUNT` is only the base: the actual
 * `/daily` payout scales with that server's stock price, see stocks.ts's `getServerDailyAmount`.
 */
export const SERVER_MESSAGE_AMOUNT = 0.1;
export const SERVER_MESSAGE_COOLDOWN_SECONDS = 5;
export const SERVER_DAILY_BASE_AMOUNT = 5;

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

/** A price/coin amount without the trailing currency name — for stock prices, market values, P/L, etc. */
export function formatCoinAmount(amount: number): string {
  return `${GLOBAL_CURRENCY_EMOJI} \`${GLOBAL_CURRENCY_DENOMINATOR}${formatAmount(amount)}\``;
}

/** Signed change amount/percent, e.g. "+$0.42 (+4.2%)" or "-$0.10 (-1.0%)". */
export function formatStockChange(changeAmount: number, changePct: number): string {
  const sign = changeAmount > 0 ? "+" : changeAmount < 0 ? "" : "±";
  const pctSign = changePct > 0 ? "+" : "";
  return `${sign}$${formatAmount(changeAmount)} (${pctSign}${changePct.toFixed(2)}%)`;
}

/** A server → global exchange rate, e.g. "1.00x". */
export function formatExchangeRate(rate: number): string {
  return `${rate.toFixed(2)}x`;
}

/** Up/down/flat custom emoji for a signed change amount — shared by every stock-related embed. */
export function stockChangeArrow(changeAmount: number): string {
  return changeAmount > 0
    ? "<:icons_uparrow:1544417597527953460>"
    : changeAmount < 0
      ? "<:icons_downarrow:1544417541873471488>"
      : "<:icons_hyphen:1544417304203362406>";
}
