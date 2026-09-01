import type { ConfigManager } from "../config/manager.js";
import { zEconomyConfig, type EconomyConfig } from "../config/schemas/economy.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getEconomyConfig } from "../plugins/economy/functions/config.js";
import { GLOBAL_CURRENCY_NAME, GLOBAL_DAILY_AMOUNT, GLOBAL_MESSAGE_AMOUNT } from "../plugins/economy/functions/format.js";
import { ensureGlobalAccount, ensureServerAccount, round2 } from "../plugins/economy/functions/money.js";
import { getDb } from "../db/client.js";
import { economyGlobalAccounts } from "../db/schema.js";
import { eq } from "drizzle-orm";

export type BridgeResult<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value);
}

async function assertPluginEnabled(
  configManager: ConfigManager,
  guildId: string,
): Promise<BridgeResult<{ config: EconomyConfig }>> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    return { ok: false, error: "The economy plugin is disabled for this server.", status: 403 };
  }
  return { ok: true, config: getEconomyConfig(guildConfig) };
}

function isValidUserId(id: string): boolean {
  return /^\d{5,32}$/.test(id);
}

export async function getEconomyOverview(
  configManager: ConfigManager,
  guildId: string,
): Promise<
  BridgeResult<{
    global: { name: string; messageAmount: number; dailyAmount: number };
    server: EconomyConfig["server"];
  }>
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  return {
    ok: true,
    global: {
      name: GLOBAL_CURRENCY_NAME,
      messageAmount: GLOBAL_MESSAGE_AMOUNT,
      dailyAmount: GLOBAL_DAILY_AMOUNT,
    },
    server: plugin.config.server,
  };
}

export async function getEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
): Promise<
  BridgeResult<{
    userId: string;
    global: { balance: number; lastMessageAt: string | null; lastDailyAt: string | null; dailyStreak: number };
    server: { balance: number; lastMessageAt: string | null; lastDailyAt: string | null; dailyStreak: number };
  }>
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = userId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };

  const global = ensureGlobalAccount(target);
  const server = ensureServerAccount(guildId, target);
  return {
    ok: true,
    userId: target,
    global: {
      balance: global.balance,
      lastMessageAt: toIso(global.lastMessageAt),
      lastDailyAt: toIso(global.lastDailyAt),
      dailyStreak: global.dailyStreak,
    },
    server: {
      balance: server.balance,
      lastMessageAt: toIso(server.lastMessageAt),
      lastDailyAt: toIso(server.lastDailyAt),
      dailyStreak: server.dailyStreak,
    },
  };
}

/**
 * Adjusts a member's **global** coin balance only — server admins can no longer adjust a
 * member's server-currency balance from the dashboard. Server currency now only moves through
 * normal play (messages, `/daily`) and `/exchange`, which converts it into global coins at a
 * rate tied to that server's own stock price; an admin override would let a server bypass that
 * exchange rate entirely and mint global coins for free.
 */
export async function adjustEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  targetUserId: string,
  input: { mode: "add" | "take" | "set"; amount: number },
): Promise<BridgeResult<{ balance: number }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = targetUserId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };
  if (!Number.isFinite(input.amount)) return { ok: false, error: "amount must be a number.", status: 400 };
  if (input.mode !== "add" && input.mode !== "take" && input.mode !== "set") {
    return { ok: false, error: "mode must be add, take, or set.", status: 400 };
  }

  const account = ensureGlobalAccount(target);
  const balance = round2(
    input.mode === "set" ? input.amount : input.mode === "take" ? account.balance - Math.abs(input.amount) : account.balance + input.amount,
  );
  if (balance < 0) return { ok: false, error: "Balance cannot go negative.", status: 400 };
  getDb().update(economyGlobalAccounts).set({ balance, updatedAt: new Date() }).where(eq(economyGlobalAccounts.userId, target)).run();
  return { ok: true, balance };
}

export async function updateEconomySettings(
  configManager: ConfigManager,
  guildId: string,
  actorId: string,
  patch: Partial<EconomyConfig["server"]>,
): Promise<BridgeResult<{ server: EconomyConfig["server"] }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  // Whitelisted explicitly (rather than spreading the whole patch) so a stray field from an
  // older dashboard build — e.g. a since-removed rate like multiplier — is silently ignored
  // instead of tripping the strict schema below.
  const { currency_name, currency_name_singular, currency_denominator, currency_emoji, message_rewards_enabled } = patch;
  const allowedPatch = {
    ...(currency_name !== undefined && { currency_name }),
    ...(currency_name_singular !== undefined && { currency_name_singular }),
    ...(currency_denominator !== undefined && { currency_denominator }),
    ...(currency_emoji !== undefined && { currency_emoji }),
    ...(message_rewards_enabled !== undefined && { message_rewards_enabled }),
  };

  const merged = zEconomyConfig.shape.server.parse({ ...plugin.config.server, ...allowedPatch });
  const result = await configManager.patchPluginConfig(guildId, "economy", { server: merged }, actorId);
  if (!result.success) return { ok: false, error: result.errors.join("\n"), status: 400 };
  return { ok: true, server: merged };
}

export { toIso };
