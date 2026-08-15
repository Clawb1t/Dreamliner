import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { ConfigManager } from "../config/manager.js";
import type { EconomyConfig } from "../config/schemas/economy.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getDb } from "../db/client.js";
import {
  economyAccounts,
  economyAchievements,
  economyCurrencies,
  economyDailyStats,
  economyGuildState,
  economyProfiles,
  economyShopListings,
  economyShops,
  economyTransactions,
} from "../db/schema.js";
import * as crafting from "../plugins/economy/functions/crafting.js";
import { getEconomyConfig, isEconomyEnabled } from "../plugins/economy/functions/config.js";
import * as inventory from "../plugins/economy/functions/inventory.js";
import * as jobs from "../plugins/economy/functions/jobs.js";
import * as markets from "../plugins/economy/functions/markets.js";
import {
  adminAdjust,
  EconomyError,
  ensureGuildCurrencies,
  ensureProfile,
  getAccount,
  isGuildPaused,
  listTransactions,
  setAccountFrozen,
  setGuildPaused,
} from "../plugins/economy/functions/money.js";
import * as pets from "../plugins/economy/functions/pets.js";
import * as quests from "../plugins/economy/functions/quests.js";
import * as seasons from "../plugins/economy/functions/seasons.js";

export type BridgeResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; status: number };

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value);
}

function serializeRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else out[key] = value;
  }
  return out;
}

async function assertPluginEnabled(
  configManager: ConfigManager,
  guildId: string,
): Promise<BridgeResult<{ config: EconomyConfig }>> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "economy") || !isEconomyEnabled(guildConfig)) {
    return {
      ok: false,
      error: "The economy plugin is disabled for this server.",
      status: 403,
    };
  }
  return { ok: true, config: getEconomyConfig(guildConfig) };
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function requireString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asBool(value: unknown, fallback?: boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === undefined) return fallback;
  return undefined;
}

function asInt(value: unknown, fallback?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return fallback;
}

function asNullableInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return asInt(value);
}

function moneySupply(guildId: string): Record<string, { pocket: number; bank: number; frozen: number; total: number }> {
  const rows = getDb()
    .select({
      currencyKey: economyAccounts.currencyKey,
      pocket: sql<number>`coalesce(sum(${economyAccounts.pocket}), 0)`,
      bank: sql<number>`coalesce(sum(${economyAccounts.bank}), 0)`,
      frozen: sql<number>`coalesce(sum(${economyAccounts.frozen}), 0)`,
    })
    .from(economyAccounts)
    .where(eq(economyAccounts.guildId, guildId))
    .groupBy(economyAccounts.currencyKey)
    .all();

  const out: Record<string, { pocket: number; bank: number; frozen: number; total: number }> = {};
  for (const row of rows) {
    const pocket = Number(row.pocket) || 0;
    const bank = Number(row.bank) || 0;
    const frozen = Number(row.frozen) || 0;
    out[row.currencyKey] = { pocket, bank, frozen, total: pocket + bank + frozen };
  }
  return out;
}

function recentAdminAdjustCount(guildId: string, days = 7): number {
  const since = new Date(Date.now() - days * 86_400_000);
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(economyTransactions)
    .where(
      and(
        eq(economyTransactions.guildId, guildId),
        gte(economyTransactions.createdAt, since),
        sql`(${economyTransactions.reason} like 'admin_%' or ${economyTransactions.actorId} is not null)`,
      ),
    )
    .get();
  return Number(row?.count) || 0;
}

export async function getEconomyOverview(
  configManager: ConfigManager,
  guildId: string,
): Promise<
  BridgeResult<{
    enabled: true;
    paused: boolean;
    seeded: boolean;
    currencies: Record<string, unknown>[];
    moneySupply: ReturnType<typeof moneySupply>;
    recentAdminAdjusts: number;
    modules: EconomyConfig["modules"];
    counts: {
      items: number;
      shops: number;
      listings: number;
      jobs: number;
      species: number;
      recipes: number;
      quests: number;
      achievements: number;
      seasons: number;
    };
  }>
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const { config } = plugin;

  ensureGuildCurrencies(guildId, config);
  const state = getDb()
    .select()
    .from(economyGuildState)
    .where(eq(economyGuildState.guildId, guildId))
    .get();
  const currencies = getDb()
    .select()
    .from(economyCurrencies)
    .where(eq(economyCurrencies.guildId, guildId))
    .all()
    .map((row) => serializeRow(row as unknown as Record<string, unknown>));

  return {
    ok: true,
    enabled: true,
    paused: isGuildPaused(guildId, config),
    seeded: Boolean(state?.seeded),
    currencies,
    moneySupply: moneySupply(guildId),
    recentAdminAdjusts: recentAdminAdjustCount(guildId),
    modules: config.modules,
    counts: {
      items: inventory.listItems(guildId).length,
      shops: inventory.listShops(guildId).length,
      listings: inventory.listShopListings(guildId).length,
      jobs: jobs.listJobs(guildId).length,
      species: pets.listSpecies(guildId).length,
      recipes: crafting.listRecipes(guildId).length,
      quests: quests.listQuests(guildId).length,
      achievements: quests.listAchievements(guildId).length,
      seasons: seasons.listSeasons(guildId).length,
    },
  };
}

export async function getEconomyAnalytics(
  configManager: ConfigManager,
  guildId: string,
  days = 14,
): Promise<BridgeResult<{ days: number; stats: Record<string, unknown>[] }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const n = Math.min(Math.max(Math.trunc(days) || 14, 1), 90);
  const since = new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const stats = getDb()
    .select()
    .from(economyDailyStats)
    .where(and(eq(economyDailyStats.guildId, guildId), gte(economyDailyStats.day, since)))
    .orderBy(desc(economyDailyStats.day))
    .all()
    .map((row) => serializeRow(row as unknown as Record<string, unknown>));
  return { ok: true, days: n, stats };
}

export async function getEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
): Promise<
  BridgeResult<{
    userId: string;
    profile: Record<string, unknown>;
    balances: Record<string, { pocket: number; bank: number; frozen: number; total: number }>;
    transactions: Record<string, unknown>[];
  }>
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = userId.trim();
  if (!/^\d{5,32}$/.test(target)) {
    return { ok: false, error: "Invalid userId.", status: 400 };
  }

  ensureGuildCurrencies(guildId, plugin.config);
  const profile = ensureProfile(guildId, target);
  const currencies = getDb()
    .select()
    .from(economyCurrencies)
    .where(eq(economyCurrencies.guildId, guildId))
    .all();
  const balances: Record<string, { pocket: number; bank: number; frozen: number; total: number }> = {};
  for (const currency of currencies) {
    const a = getAccount(guildId, target, currency.key);
    balances[currency.key] = {
      pocket: a.pocket,
      bank: a.bank,
      frozen: a.frozen,
      total: a.pocket + a.bank + a.frozen,
    };
  }

  return {
    ok: true,
    userId: target,
    profile: serializeRow(profile as unknown as Record<string, unknown>),
    balances,
    transactions: listTransactions(guildId, target, 25).map((row) =>
      serializeRow(row as unknown as Record<string, unknown>),
    ),
  };
}

export async function adjustEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  targetUserId: string,
  input: {
    actorId: string;
    currencyKey?: string;
    mode?: "add" | "take" | "set";
    pocketDelta?: number;
    bankDelta?: number;
    reason?: string;
  },
): Promise<BridgeResult<{ balances: { pocket: number; bank: number; frozen: number }; currencyKey: string }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = targetUserId.trim();
  if (!/^\d{5,32}$/.test(target)) {
    return { ok: false, error: "Invalid userId.", status: 400 };
  }
  const currencyKey = (input.currencyKey ?? "coins").trim() || "coins";
  const mode = input.mode ?? "add";
  if (mode !== "add" && mode !== "take" && mode !== "set") {
    return { ok: false, error: "mode must be add, take, or set.", status: 400 };
  }
  try {
    const balances = adminAdjust({
      guildId,
      userId: target,
      currencyKey,
      pocketDelta: input.pocketDelta ?? 0,
      bankDelta: input.bankDelta ?? 0,
      mode,
      actorId: input.actorId,
      config: plugin.config,
      reason: input.reason,
    });
    return { ok: true, balances, currencyKey };
  } catch (err) {
    return mapEconomyError(err);
  }
}

export async function freezeEconomyAccount(
  configManager: ConfigManager,
  guildId: string,
  targetUserId: string,
  input: { frozen: boolean; reason?: string },
): Promise<BridgeResult<{ profile: Record<string, unknown> }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = targetUserId.trim();
  if (!/^\d{5,32}$/.test(target)) {
    return { ok: false, error: "Invalid userId.", status: 400 };
  }
  setAccountFrozen(guildId, target, input.frozen, input.reason);
  const profile = getDb()
    .select()
    .from(economyProfiles)
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, target)))
    .get()!;
  return { ok: true, profile: serializeRow(profile as unknown as Record<string, unknown>) };
}

export async function listEconomyTransactions(
  configManager: ConfigManager,
  guildId: string,
  userId: string,
  limit = 25,
): Promise<BridgeResult<{ transactions: Record<string, unknown>[] }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const target = userId.trim();
  if (!/^\d{5,32}$/.test(target)) {
    return { ok: false, error: "Invalid userId.", status: 400 };
  }
  return {
    ok: true,
    transactions: listTransactions(guildId, target, limit).map((row) =>
      serializeRow(row as unknown as Record<string, unknown>),
    ),
  };
}

function mapEconomyError(err: unknown): { ok: false; error: string; status: number } {
  if (err instanceof EconomyError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "paused" ? 423 : 400;
    return { ok: false, error: err.message, status };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : "Economy action failed.",
    status: 500,
  };
}

export async function runEconomyAction(
  configManager: ConfigManager,
  guildId: string,
  action: string,
): Promise<BridgeResult<{ action: string; result: Record<string, unknown> }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const { config } = plugin;

  try {
    switch (action) {
      case "pause":
        setGuildPaused(guildId, true);
        return { ok: true, action, result: { paused: true } };
      case "resume":
        setGuildPaused(guildId, false);
        return { ok: true, action, result: { paused: false } };
      case "seed": {
        ensureGuildCurrencies(guildId, config);
        inventory.seedDefaultCatalog(guildId);
        quests.seedDefaultQuests(guildId);
        jobs.seedDefaultJobs(guildId);
        pets.seedDefaultSpecies(guildId);
        return {
          ok: true,
          action,
          result: {
            items: inventory.listItems(guildId).length,
            shops: inventory.listShops(guildId).length,
            jobs: jobs.listJobs(guildId).length,
            species: pets.listSpecies(guildId).length,
            quests: quests.listQuests(guildId).length,
          },
        };
      }
      case "restock": {
        const count = inventory.restockDueListings(guildId);
        return { ok: true, action, result: { restocked: count } };
      }
      case "settle": {
        const settled = markets.settleExpiredAuctions(guildId, config);
        return { ok: true, action, result: { settled } };
      }
      default:
        return {
          ok: false,
          error: 'action must be one of: pause, resume, seed, restock, settle.',
          status: 400,
        };
    }
  } catch (err) {
    return mapEconomyError(err);
  }
}

// ── Catalog helpers ──────────────────────────────────────────────────────────

type CatalogKind =
  | "items"
  | "shops"
  | "listings"
  | "jobs"
  | "species"
  | "recipes"
  | "quests"
  | "achievements"
  | "seasons";

function getShopById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyShops)
    .where(and(eq(economyShops.guildId, guildId), eq(economyShops.id, id)))
    .get();
}

function getListingById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyShopListings)
    .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.id, id)))
    .get();
}

function getAchievementById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyAchievements)
    .where(and(eq(economyAchievements.guildId, guildId), eq(economyAchievements.id, id)))
    .get();
}

export async function listEconomyCatalog(
  configManager: ConfigManager,
  guildId: string,
  kind: CatalogKind,
  shopId?: number,
): Promise<BridgeResult<{ items: Record<string, unknown>[] }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  let rows: unknown[] = [];
  switch (kind) {
    case "items":
      rows = inventory.listItems(guildId);
      break;
    case "shops":
      rows = inventory.listShops(guildId);
      break;
    case "listings":
      rows = inventory.listShopListings(guildId, shopId);
      break;
    case "jobs":
      rows = jobs.listJobs(guildId);
      break;
    case "species":
      rows = pets.listSpecies(guildId);
      break;
    case "recipes":
      rows = crafting.listRecipes(guildId);
      break;
    case "quests":
      rows = quests.listQuests(guildId);
      break;
    case "achievements":
      rows = quests.listAchievements(guildId);
      break;
    case "seasons":
      rows = seasons.listSeasons(guildId);
      break;
  }
  return {
    ok: true,
    items: rows.map((row) => serializeRow(row as Record<string, unknown>)),
  };
}

export async function getEconomyCatalogOne(
  configManager: ConfigManager,
  guildId: string,
  kind: CatalogKind,
  id: number,
): Promise<BridgeResult<{ item: Record<string, unknown> }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  let row: unknown = null;
  switch (kind) {
    case "items":
      row = inventory.getItemById(guildId, id);
      break;
    case "shops":
      row = getShopById(guildId, id);
      break;
    case "listings":
      row = getListingById(guildId, id);
      break;
    case "jobs":
      row = jobs.getJobById(guildId, id);
      break;
    case "species":
      row = pets.getSpeciesById(guildId, id);
      break;
    case "recipes":
      row = crafting.getRecipeById(guildId, id);
      break;
    case "quests":
      row = quests.getQuestById(guildId, id);
      break;
    case "achievements":
      row = getAchievementById(guildId, id);
      break;
    case "seasons":
      row = seasons.getSeasonById(guildId, id);
      break;
  }
  if (!row) return { ok: false, error: "Not found.", status: 404 };
  return { ok: true, item: serializeRow(row as Record<string, unknown>) };
}

export async function createEconomyCatalog(
  configManager: ConfigManager,
  guildId: string,
  kind: CatalogKind,
  body: Record<string, unknown>,
): Promise<BridgeResult<{ item: Record<string, unknown> }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  try {
    const item = upsertCatalog(guildId, kind, body, null);
    return { ok: true, item: serializeRow(item as Record<string, unknown>) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("VALIDATION:")) {
      return { ok: false, error: err.message.slice("VALIDATION:".length).trim(), status: 400 };
    }
    return mapEconomyError(err);
  }
}

export async function updateEconomyCatalog(
  configManager: ConfigManager,
  guildId: string,
  kind: CatalogKind,
  id: number,
  body: Record<string, unknown>,
): Promise<BridgeResult<{ item: Record<string, unknown> }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const existing = await getEconomyCatalogOne(configManager, guildId, kind, id);
  if (!existing.ok) return existing;

  try {
    const item = upsertCatalog(guildId, kind, body, existing.item);
    return { ok: true, item: serializeRow(item as Record<string, unknown>) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("VALIDATION:")) {
      return { ok: false, error: err.message.slice("VALIDATION:".length).trim(), status: 400 };
    }
    return mapEconomyError(err);
  }
}

export async function deleteEconomyCatalog(
  configManager: ConfigManager,
  guildId: string,
  kind: CatalogKind,
  id: number,
): Promise<BridgeResult<{ deleted: true }>> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const existing = await getEconomyCatalogOne(configManager, guildId, kind, id);
  if (!existing.ok) return existing;

  switch (kind) {
    case "items":
      inventory.deleteItem(guildId, id);
      break;
    case "shops":
      inventory.deleteShop(guildId, id);
      break;
    case "listings":
      inventory.deleteListing(guildId, id);
      break;
    case "jobs":
      jobs.deleteJob(guildId, id);
      break;
    case "species":
      pets.deleteSpecies(guildId, id);
      break;
    case "recipes":
      crafting.deleteRecipe(guildId, id);
      break;
    case "quests":
      quests.deleteQuest(guildId, id);
      break;
    case "achievements":
      quests.deleteAchievement(guildId, id);
      break;
    case "seasons":
      seasons.deleteSeason(guildId, id);
      break;
  }
  return { ok: true, deleted: true };
}

function upsertCatalog(
  guildId: string,
  kind: CatalogKind,
  body: Record<string, unknown>,
  existing: Record<string, unknown> | null,
): unknown {
  const key =
    requireString(body, "key") ??
    (typeof existing?.key === "string" ? existing.key : null);

  switch (kind) {
    case "items": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      return inventory.upsertItem(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        emoji: requireString(body, "emoji") ?? undefined,
        itemType: requireString(body, "itemType") ?? requireString(body, "item_type") ?? undefined,
        stackable: asBool(body.stackable),
        tradeable: asBool(body.tradeable),
        sellValue: asInt(body.sellValue ?? body.sell_value),
        currencyKey: requireString(body, "currencyKey") ?? requireString(body, "currency_key") ?? undefined,
        effectJson:
          typeof body.effectJson === "string"
            ? body.effectJson
            : typeof body.effect_json === "string"
              ? body.effect_json
              : body.effect != null
                ? JSON.stringify(body.effect)
                : undefined,
        lootJson:
          typeof body.lootJson === "string"
            ? body.lootJson
            : typeof body.loot_json === "string"
              ? body.loot_json
              : body.loot != null
                ? JSON.stringify(body.loot)
                : undefined,
        roleId:
          body.roleId === null || body.role_id === null
            ? null
            : requireString(body, "roleId") ?? requireString(body, "role_id") ?? undefined,
        petSpeciesKey:
          body.petSpeciesKey === null || body.pet_species_key === null
            ? null
            : requireString(body, "petSpeciesKey") ??
              requireString(body, "pet_species_key") ??
              undefined,
      });
    }
    case "shops": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      return inventory.upsertShop(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        enabled: asBool(body.enabled),
        channelId:
          body.channelId === null || body.channel_id === null
            ? null
            : requireString(body, "channelId") ?? requireString(body, "channel_id") ?? undefined,
      });
    }
    case "listings": {
      const shopId = asInt(body.shopId ?? body.shop_id) ?? asInt(existing?.shopId);
      const itemId = asInt(body.itemId ?? body.item_id) ?? asInt(existing?.itemId);
      const price = asInt(body.price) ?? asInt(existing?.price);
      if (!shopId || !itemId || price === undefined) {
        throw new Error("VALIDATION: shopId, itemId, and price are required.");
      }
      return inventory.upsertListing(guildId, {
        id: existing ? asInt(existing.id) : undefined,
        shopId,
        itemId,
        price,
        currencyKey: requireString(body, "currencyKey") ?? requireString(body, "currency_key") ?? undefined,
        stock: asNullableInt(body.stock),
        maxPerUser: asNullableInt(body.maxPerUser ?? body.max_per_user),
        restockAmount: asNullableInt(body.restockAmount ?? body.restock_amount),
        restockIntervalSeconds: asNullableInt(
          body.restockIntervalSeconds ?? body.restock_interval_seconds,
        ),
        enabled: asBool(body.enabled),
        sortOrder: asInt(body.sortOrder ?? body.sort_order),
      });
    }
    case "jobs": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      return jobs.upsertJob(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        emoji: requireString(body, "emoji") ?? undefined,
        payMin: asInt(body.payMin ?? body.pay_min),
        payMax: asInt(body.payMax ?? body.pay_max),
        currencyKey: requireString(body, "currencyKey") ?? requireString(body, "currency_key") ?? undefined,
        cooldownSeconds: asInt(body.cooldownSeconds ?? body.cooldown_seconds),
        requiredLevel: asInt(body.requiredLevel ?? body.required_level),
        requiredItemId: asNullableInt(body.requiredItemId ?? body.required_item_id),
        failChanceBps: asInt(body.failChanceBps ?? body.fail_chance_bps),
        failFine: asInt(body.failFine ?? body.fail_fine),
        careerXp: asInt(body.careerXp ?? body.career_xp),
        enabled: asBool(body.enabled),
        flavorJson:
          typeof body.flavorJson === "string"
            ? body.flavorJson
            : typeof body.flavor_json === "string"
              ? body.flavor_json
              : Array.isArray(body.flavor)
                ? JSON.stringify(body.flavor)
                : undefined,
      });
    }
    case "species": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      return pets.upsertSpecies(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        emoji: requireString(body, "emoji") ?? undefined,
        rarity: requireString(body, "rarity") ?? undefined,
        baseAtk: asInt(body.baseAtk ?? body.base_atk),
        baseDef: asInt(body.baseDef ?? body.base_def),
        baseHp: asInt(body.baseHp ?? body.base_hp),
        baseSpeed: asInt(body.baseSpeed ?? body.base_speed),
        adoptCost: asInt(body.adoptCost ?? body.adopt_cost),
        currencyKey: requireString(body, "currencyKey") ?? requireString(body, "currency_key") ?? undefined,
        enabled: asBool(body.enabled),
      });
    }
    case "recipes": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      const outputItemId =
        asInt(body.outputItemId ?? body.output_item_id) ?? asInt(existing?.outputItemId);
      if (!outputItemId) throw new Error("VALIDATION: outputItemId is required.");
      let inputs = body.inputs;
      if (typeof inputs === "string") {
        try {
          inputs = JSON.parse(inputs);
        } catch {
          throw new Error("VALIDATION: inputs must be valid JSON.");
        }
      }
      if (!Array.isArray(inputs) && existing?.inputsJson) {
        try {
          inputs = JSON.parse(String(existing.inputsJson));
        } catch {
          inputs = [];
        }
      }
      if (!Array.isArray(inputs)) throw new Error("VALIDATION: inputs must be an array.");
      return crafting.upsertRecipe(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        outputItemId,
        outputQty: asInt(body.outputQty ?? body.output_qty),
        inputs: inputs as crafting.RecipeInput[],
        durationSeconds: asInt(body.durationSeconds ?? body.duration_seconds),
        requiredLevel: asInt(body.requiredLevel ?? body.required_level),
        enabled: asBool(body.enabled),
      });
    }
    case "quests": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      const objectiveType =
        requireString(body, "objectiveType") ??
        requireString(body, "objective_type") ??
        (typeof existing?.objectiveType === "string" ? existing.objectiveType : null);
      if (!objectiveType) throw new Error("VALIDATION: objectiveType is required.");
      return quests.upsertQuest(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        questType: requireString(body, "questType") ?? requireString(body, "quest_type") ?? undefined,
        objectiveType,
        objectiveTarget: asInt(body.objectiveTarget ?? body.objective_target),
        rewardCurrencyKey:
          requireString(body, "rewardCurrencyKey") ??
          requireString(body, "reward_currency_key") ??
          undefined,
        rewardAmount: asInt(body.rewardAmount ?? body.reward_amount),
        rewardItemId: asNullableInt(body.rewardItemId ?? body.reward_item_id),
        rewardItemQty: asInt(body.rewardItemQty ?? body.reward_item_qty),
        enabled: asBool(body.enabled),
      });
    }
    case "achievements": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      const objectiveType =
        requireString(body, "objectiveType") ??
        requireString(body, "objective_type") ??
        (typeof existing?.objectiveType === "string" ? existing.objectiveType : null);
      if (!objectiveType) throw new Error("VALIDATION: objectiveType is required.");
      return quests.upsertAchievement(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        objectiveType,
        objectiveTarget: asInt(body.objectiveTarget ?? body.objective_target),
        rewardCurrencyKey:
          requireString(body, "rewardCurrencyKey") ??
          requireString(body, "reward_currency_key") ??
          undefined,
        rewardAmount: asInt(body.rewardAmount ?? body.reward_amount),
        enabled: asBool(body.enabled),
      });
    }
    case "seasons": {
      if (!key) throw new Error("VALIDATION: key is required.");
      const name =
        requireString(body, "name") ??
        (typeof existing?.name === "string" ? existing.name : null);
      if (!name) throw new Error("VALIDATION: name is required.");
      const startsRaw = body.startsAt ?? body.starts_at ?? existing?.startsAt;
      const endsRaw = body.endsAt ?? body.ends_at ?? existing?.endsAt;
      const startsAt = startsRaw ? new Date(String(startsRaw)) : null;
      const endsAt = endsRaw ? new Date(String(endsRaw)) : null;
      if (!startsAt || !Number.isFinite(startsAt.getTime())) {
        throw new Error("VALIDATION: startsAt is required.");
      }
      if (!endsAt || !Number.isFinite(endsAt.getTime())) {
        throw new Error("VALIDATION: endsAt is required.");
      }
      let rewards = body.rewards;
      if (typeof rewards === "string") {
        try {
          rewards = JSON.parse(rewards);
        } catch {
          throw new Error("VALIDATION: rewards must be valid JSON.");
        }
      }
      return seasons.upsertSeason(guildId, {
        key,
        name,
        description: requireString(body, "description") ?? undefined,
        startsAt,
        endsAt,
        softReset: asBool(body.softReset ?? body.soft_reset),
        status: requireString(body, "status") ?? undefined,
        rewards: Array.isArray(rewards) ? (rewards as seasons.SeasonReward[]) : undefined,
      });
    }
  }
}

export function parseCatalogKind(raw: string): CatalogKind | null {
  switch (raw) {
    case "items":
    case "shops":
    case "listings":
    case "jobs":
    case "species":
    case "pets":
    case "recipes":
    case "quests":
    case "achievements":
    case "seasons":
      return raw === "pets" ? "species" : (raw as CatalogKind);
    default:
      return null;
  }
}

export { toIso, parseId };
