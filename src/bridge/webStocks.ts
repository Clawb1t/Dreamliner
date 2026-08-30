import {
  buyStock,
  getExchangeSeries,
  getPortfolio,
  getStock,
  getStockHistory,
  listStocks,
  listTransactions,
  sellStock,
  StockError,
  type StockRange,
} from "../plugins/economy/functions/stocks.js";
import { getGlobalBalance } from "../plugins/economy/functions/money.js";
import { configManager } from "../config/manager.js";

export type BridgeResult<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

function isValidUserId(id: string): boolean {
  return /^\d{5,32}$/.test(id);
}

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

function isValidRange(raw: string | null): StockRange {
  return raw === "7d" || raw === "30d" ? raw : "24h";
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type SerializableStock = ReturnType<typeof getStock> extends infer T
  ? NonNullable<T> & { changeAmount?: number; changePct?: number }
  : never;

function serializeStock(stock: SerializableStock) {
  return {
    guildId: stock.guildId,
    symbol: stock.symbol,
    guildName: stock.guildName,
    guildIcon: stock.guildIcon,
    price: stock.price,
    activityScore: stock.activityScore,
    changeAmount: stock.changeAmount ?? 0,
    changePct: stock.changePct ?? 0,
    listedAt: toIso(stock.listedAt),
    updatedAt: toIso(stock.updatedAt),
  };
}

export async function getExchangeOverview(rangeRaw: string | null, topLimit = 10) {
  const range = isValidRange(rangeRaw);
  const stocks = listStocks();
  const series = getExchangeSeries(
    stocks.slice(0, topLimit).map((s) => s.guildId),
    range,
  );
  // Every listing (not just the top 10) gets its server's own accent — used for the ticker
  // tape and the listings rows too, not just the chart. The website resolves this further
  // into the avatar's dominant color where it can; this is just the fallback.
  const stocksWithAccent = await Promise.all(
    stocks.map(async (s) => ({
      ...serializeStock(s),
      accentColor: colorIntToHex((await configManager.getEffectiveConfig(s.guildId)).server_accent_color),
    })),
  );
  return {
    ok: true as const,
    range,
    stocks: stocksWithAccent,
    top: stocksWithAccent.slice(0, topLimit),
    series,
  };
}

export async function getStockDetail(guildId: string, rangeRaw: string | null): Promise<BridgeResult<{
  stock: ReturnType<typeof serializeStock> & { accentColor: string };
  history: Array<{ price: number; recordedAt: string }>;
}>> {
  const stocks = listStocks();
  const found = stocks.find((s) => s.guildId === guildId);
  if (!found) return { ok: false, error: "That server isn't listed on the exchange.", status: 404 };
  const range = isValidRange(rangeRaw);
  const history = getStockHistory(guildId, range).map((row) => ({
    price: row.price,
    recordedAt: toIso(row.recordedAt),
  }));
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return {
    ok: true,
    stock: { ...serializeStock(found), accentColor: colorIntToHex(guildConfig.server_accent_color) },
    history,
  };
}

export function getUserGlobalBalance(userId: string): BridgeResult<{ balance: number }> {
  const target = userId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };
  return { ok: true, balance: getGlobalBalance(target) };
}

export function getUserPortfolio(userId: string) {
  const target = userId.trim();
  if (!isValidUserId(target)) return { ok: false as const, error: "Invalid userId.", status: 400 };
  const portfolio = getPortfolio(target);
  const transactions = listTransactions(target, 25).map((row) => ({
    id: row.id,
    guildId: row.guildId,
    type: row.type,
    shares: row.shares,
    price: row.price,
    amount: row.amount,
    createdAt: toIso(row.createdAt),
  }));
  return {
    ok: true as const,
    balance: portfolio.balance,
    totalValue: portfolio.totalValue,
    positions: portfolio.positions.map((p) => ({
      guildId: p.guildId,
      shares: p.shares,
      costBasis: p.costBasis,
      marketValue: p.marketValue,
      pl: p.pl,
      plPct: p.plPct,
      stock: serializeStock(p.stock),
    })),
    transactions,
  };
}

function mapStockError(err: unknown): { ok: false; error: string; status: number } {
  if (err instanceof StockError) {
    const status = err.code === "not_found" ? 404 : err.code === "insufficient" ? 400 : 400;
    return { ok: false, error: err.message, status };
  }
  return { ok: false, error: err instanceof Error ? err.message : "Trade failed.", status: 500 };
}

export function buyStockForUser(
  userId: string,
  guildId: string,
  coins: number,
): BridgeResult<{ shares: number; price: number; balance: number }> {
  const target = userId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };
  if (!Number.isFinite(coins) || coins <= 0) return { ok: false, error: "amount must be a positive number.", status: 400 };
  try {
    const result = buyStock(target, guildId, coins);
    return { ok: true, ...result };
  } catch (err) {
    return mapStockError(err);
  }
}

export function sellStockForUser(
  userId: string,
  guildId: string,
  shares: number,
): BridgeResult<{ shares: number; price: number; proceeds: number; balance: number }> {
  const target = userId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: "shares must be a positive number.", status: 400 };
  try {
    const result = sellStock(target, guildId, shares);
    return { ok: true, ...result };
  } catch (err) {
    return mapStockError(err);
  }
}

export { getStock };
