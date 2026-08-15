import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { EconomyError, type AccountBalances } from "./money.js";

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
    `Pocket: ${formatCurrency(balances.pocket, config, { currencyKey })}`,
    `Bank: ${formatCurrency(balances.bank, config, { currencyKey })}`,
    balances.frozen > 0 ? `Frozen: ${formatCurrency(balances.frozen, config, { currencyKey })}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const SHORT_BY_CODE: Record<EconomyError["code"], string> = {
  paused: "Economy is paused.",
  frozen: "Account is frozen.",
  insufficient: "Insufficient funds or items.",
  invalid: "Invalid request.",
  not_found: "Not found.",
  conflict: "Conflict — try again.",
  limit: "Limit reached.",
};

export function shortEconomyError(err: unknown): string {
  if (err instanceof EconomyError) {
    return err.message || SHORT_BY_CODE[err.code] || "Economy error.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function economyErrorCode(err: unknown): EconomyError["code"] | "unknown" {
  if (err instanceof EconomyError) return err.code;
  return "unknown";
}
