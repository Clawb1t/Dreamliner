import type { ConfigManager } from "../config/manager.js";
import { zEconomyConfig, type EconomyConfig } from "../config/schemas/economy.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getEconomyConfig } from "../plugins/economy/functions/config.js";
import { GLOBAL_CURRENCY_NAME, GLOBAL_DAILY_AMOUNT, GLOBAL_MESSAGE_AMOUNT } from "../plugins/economy/functions/format.js";
import { ensureGlobalAccount, ensureServerAccount, round2 } from "../plugins/economy/functions/money.js";
import { getDb } from "../db/client.js";
import { economyGlobalAccounts, economyServerAccounts } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

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

export async function adjustEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  targetUserId: string,
  input: { scope: "global" | "server"; mode: "add" | "take" | "set"; amount: number },
): Promise<BridgeResult<{ scope: "global" | "server"; balance: number }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = targetUserId.trim();
  if (!isValidUserId(target)) return { ok: false, error: "Invalid userId.", status: 400 };
  if (!Number.isFinite(input.amount)) return { ok: false, error: "amount must be a number.", status: 400 };
  if (input.scope !== "global" && input.scope !== "server") {
    return { ok: false, error: "scope must be global or server.", status: 400 };
  }
  if (input.mode !== "add" && input.mode !== "take" && input.mode !== "set") {
    return { ok: false, error: "mode must be add, take, or set.", status: 400 };
  }

  const db = getDb();
  if (input.scope === "global") {
    const account = ensureGlobalAccount(target);
    const balance = round2(
      input.mode === "set" ? input.amount : input.mode === "take" ? account.balance - Math.abs(input.amount) : account.balance + input.amount,
    );
    if (balance < 0) return { ok: false, error: "Balance cannot go negative.", status: 400 };
    db.update(economyGlobalAccounts).set({ balance, updatedAt: new Date() }).where(eq(economyGlobalAccounts.userId, target)).run();
    return { ok: true, scope: "global", balance };
  }

  const account = ensureServerAccount(guildId, target);
  const balance = round2(
    input.mode === "set" ? input.amount : input.mode === "take" ? account.balance - Math.abs(input.amount) : account.balance + input.amount,
  );
  if (balance < 0) return { ok: false, error: "Balance cannot go negative.", status: 400 };
  db.update(economyServerAccounts)
    .set({ balance, updatedAt: new Date() })
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, target)))
    .run();
  return { ok: true, scope: "server", balance };
}

export async function updateEconomySettings(
  configManager: ConfigManager,
  guildId: string,
  actorId: string,
  patch: Partial<EconomyConfig["server"]>,
): Promise<BridgeResult<{ server: EconomyConfig["server"] }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const merged = zEconomyConfig.shape.server.parse({ ...plugin.config.server, ...patch });
  const result = await configManager.patchPluginConfig(guildId, "economy", { server: merged }, actorId);
  if (!result.success) return { ok: false, error: result.errors.join("\n"), status: 400 };
  return { ok: true, server: merged };
}

export { toIso };
