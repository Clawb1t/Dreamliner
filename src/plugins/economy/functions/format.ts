import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { discordTimestamp } from "../../../core/datetime.js";
import { EconomyError, type AccountBalances, type EconomyShortfall } from "./money.js";

export function formatCurrency(
  amount: number,
  config: EconomyConfig,
  opts?: { currencyKey?: string; singular?: boolean },
): string {
  const key = opts?.currencyKey ?? "coins";
  const abs = Math.abs(amount);
  const isSecondary = key === "gems" || key === "secondary";
  const symbol = isSecondary ? config.currency.secondary_symbol : config.currency.symbol;
  const name =
    abs === 1 || opts?.singular
      ? isSecondary
        ? config.currency.secondary_name_singular
        : config.currency.name_singular
      : isSecondary
        ? config.currency.secondary_name
        : config.currency.name;
  const signed = amount < 0 ? `-${abs.toLocaleString()}` : abs.toLocaleString();
  return `${symbol} ${signed} ${name}`;
}

export function formatBalances(
  balances: AccountBalances,
  config: EconomyConfig,
  currencyKey = "coins",
): string {
  return [
    `**Pocket**\n${formatCurrency(balances.pocket, config, { currencyKey })}`,
    `**Bank**\n${formatCurrency(balances.bank, config, { currencyKey })}`,
    balances.frozen > 0
      ? `**Frozen**\n${formatCurrency(balances.frozen, config, { currencyKey })}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const SHORT_BY_CODE: Record<EconomyError["code"], string> = {
  paused: "Economy is paused.",
  frozen: "Account is frozen.",
  insufficient: "Insufficient funds or items.",
  invalid: "Invalid request.",
  not_found: "Not found.",
  conflict: "That changed while you were working. Please try again.",
  limit: "Limit reached.",
};

function formatShortfall(shortfall: EconomyShortfall, config?: EconomyConfig): string {
  const missing = Math.max(0, shortfall.required - shortfall.available);
  if (shortfall.kind === "funds" && config) {
    const currencyKey = shortfall.currencyKey ?? "coins";
    const wallet =
      shortfall.wallet === "bank" ? "bank" : shortfall.wallet === "frozen" ? "frozen balance" : "pocket";
    return [
      `You need more money in your ${wallet}.`,
      `**Need:** ${formatCurrency(shortfall.required, config, { currencyKey })}`,
      `**Have:** ${formatCurrency(shortfall.available, config, { currencyKey })}`,
      `**Short:** ${formatCurrency(missing, config, { currencyKey })}`,
    ].join("\n");
  }

  const label = shortfall.itemEmoji
    ? `${shortfall.itemEmoji} ${shortfall.itemName ?? "items"}`
    : (shortfall.itemName ?? "items");
  const unit = shortfall.kind === "stock" ? "in stock" : "owned";
  return [
    shortfall.kind === "stock" ? `${label} is low on stock.` : `You do not have enough ${label}.`,
    `**Need:** **${shortfall.required.toLocaleString()}**`,
    `**Have:** **${shortfall.available.toLocaleString()}** ${unit}`,
    `**Short:** **${missing.toLocaleString()}**`,
  ].join("\n");
}

export function shortEconomyError(err: unknown, config?: EconomyConfig): string {
  if (err instanceof EconomyError) {
    const body = err.shortfall
      ? formatShortfall(err.shortfall, config)
      : err.message || SHORT_BY_CODE[err.code] || "Economy error.";
    if (err.retryAt) return `${body}\n**Ready:** ${discordTimestamp(err.retryAt)}`;
    return body;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function economyErrorCode(err: unknown): EconomyError["code"] | "unknown" {
  if (err instanceof EconomyError) return err.code;
  return "unknown";
}

/** Parse an autocomplete choice value that stores a numeric row id. */
export function parseAutocompleteId(raw: string | null | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new EconomyError(`Pick a ${label} from the autocomplete list.`, "invalid");
  }
  return n;
}
