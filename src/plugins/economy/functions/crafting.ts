import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyCraftQueue, economyRecipes } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { EconomyError, ensureProfile, isGuildPaused } from "./money.js";
import { addInventory, removeInventory } from "./inventory.js";

function now() {
  return new Date();
}

export type RecipeInput = { itemId: number; qty: number };

function parseInputs(json: string): RecipeInput[] {
  try {
    const v = JSON.parse(json || "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .map((row) => {
        const r = row as { itemId?: unknown; qty?: unknown; item_id?: unknown };
        const itemId = Number(r.itemId ?? r.item_id);
        const qty = Number(r.qty ?? 1);
        if (!Number.isInteger(itemId) || !Number.isInteger(qty) || itemId <= 0 || qty <= 0) return null;
        return { itemId, qty };
      })
      .filter((x): x is RecipeInput => x !== null);
  } catch {
    return [];
  }
}

export function listRecipes(guildId: string, enabledOnly = false) {
  const rows = getDb().select().from(economyRecipes).where(eq(economyRecipes.guildId, guildId)).all();
  return enabledOnly ? rows.filter((r) => r.enabled) : rows;
}

export function getRecipeByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyRecipes)
    .where(and(eq(economyRecipes.guildId, guildId), eq(economyRecipes.key, key)))
    .get();
}

export function getRecipeById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyRecipes)
    .where(and(eq(economyRecipes.guildId, guildId), eq(economyRecipes.id, id)))
    .get();
}

export function upsertRecipe(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    outputItemId: number;
    outputQty?: number;
    inputs: RecipeInput[];
    durationSeconds?: number;
    requiredLevel?: number;
    enabled?: boolean;
  },
) {
  const inputsJson = JSON.stringify(input.inputs);
  const existing = getRecipeByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyRecipes)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        outputItemId: input.outputItemId,
        outputQty: input.outputQty ?? existing.outputQty,
        inputsJson,
        durationSeconds: input.durationSeconds ?? existing.durationSeconds,
        requiredLevel: input.requiredLevel ?? existing.requiredLevel,
        enabled: input.enabled ?? existing.enabled,
      })
      .where(eq(economyRecipes.id, existing.id))
      .run();
    return getRecipeById(guildId, existing.id)!;
  }
  getDb()
    .insert(economyRecipes)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      outputItemId: input.outputItemId,
      outputQty: input.outputQty ?? 1,
      inputsJson,
      durationSeconds: input.durationSeconds ?? 60,
      requiredLevel: input.requiredLevel ?? 1,
      enabled: input.enabled ?? true,
      createdAt: now(),
    })
    .run();
  return getRecipeByKey(guildId, input.key)!;
}

export function deleteRecipe(guildId: string, id: number) {
  getDb()
    .delete(economyRecipes)
    .where(and(eq(economyRecipes.guildId, guildId), eq(economyRecipes.id, id)))
    .run();
}

export function listQueue(guildId: string, userId: string, includeFinished = false) {
  const rows = getDb()
    .select()
    .from(economyCraftQueue)
    .where(and(eq(economyCraftQueue.guildId, guildId), eq(economyCraftQueue.userId, userId)))
    .all();
  if (includeFinished) return rows;
  return rows.filter((r) => !r.collected && !r.cancelled);
}

export function getCraftEntry(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyCraftQueue)
    .where(and(eq(economyCraftQueue.guildId, guildId), eq(economyCraftQueue.id, id)))
    .get();
}

export function startCraft(opts: {
  guildId: string;
  userId: string;
  recipeKey: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.crafting) throw new EconomyError("Crafting is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const recipe = getRecipeByKey(opts.guildId, opts.recipeKey);
  if (!recipe || !recipe.enabled) throw new EconomyError("Recipe not found.", "not_found");

  const profile = ensureProfile(opts.guildId, opts.userId);
  if (profile.level < recipe.requiredLevel) {
    throw new EconomyError(`Requires economy level ${recipe.requiredLevel}.`, "limit");
  }

  const active = listQueue(opts.guildId, opts.userId);
  if (active.length >= 5) throw new EconomyError("Craft queue is full (max 5).", "limit");

  const inputs = parseInputs(recipe.inputsJson);
  if (inputs.length === 0) throw new EconomyError("Recipe has no inputs.", "invalid");

  const db = getDb();
  return db.transaction(() => {
    for (const input of inputs) {
      removeInventory(opts.guildId, opts.userId, input.itemId, input.qty);
    }
    const startedAt = now();
    const completesAt = new Date(startedAt.getTime() + Math.max(1, recipe.durationSeconds) * 1000);
    db.insert(economyCraftQueue)
      .values({
        guildId: opts.guildId,
        userId: opts.userId,
        recipeId: recipe.id,
        startedAt,
        completesAt,
        collected: false,
        cancelled: false,
      })
      .run();
    const entry = listQueue(opts.guildId, opts.userId, true).at(-1)!;
    return { entry, recipe };
  });
}

export function collectCraft(opts: {
  guildId: string;
  userId: string;
  craftId: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.crafting) throw new EconomyError("Crafting is disabled.", "invalid");
  const entry = getCraftEntry(opts.guildId, opts.craftId);
  if (!entry || entry.userId !== opts.userId) throw new EconomyError("Craft not found.", "not_found");
  if (entry.cancelled) throw new EconomyError("Craft was cancelled.", "invalid");
  if (entry.collected) throw new EconomyError("Already collected.", "conflict");
  if (entry.completesAt.getTime() > Date.now()) {
    const secs = Math.ceil((entry.completesAt.getTime() - Date.now()) / 1000);
    throw new EconomyError(`Still crafting. ${secs}s remaining.`, "limit");
  }

  const recipe = getRecipeById(opts.guildId, entry.recipeId);
  if (!recipe) throw new EconomyError("Recipe missing.", "not_found");

  const db = getDb();
  return db.transaction(() => {
    addInventory(opts.guildId, opts.userId, recipe.outputItemId, recipe.outputQty, opts.config);
    db.update(economyCraftQueue)
      .set({ collected: true })
      .where(eq(economyCraftQueue.id, entry.id))
      .run();
    return { entry: { ...entry, collected: true }, recipe };
  });
}

export function cancelCraft(opts: {
  guildId: string;
  userId: string;
  craftId: number;
  config: EconomyConfig;
  refundInputs?: boolean;
}) {
  if (!opts.config.modules.crafting) throw new EconomyError("Crafting is disabled.", "invalid");
  const entry = getCraftEntry(opts.guildId, opts.craftId);
  if (!entry || entry.userId !== opts.userId) throw new EconomyError("Craft not found.", "not_found");
  if (entry.collected) throw new EconomyError("Already collected.", "conflict");
  if (entry.cancelled) throw new EconomyError("Already cancelled.", "conflict");
  if (entry.completesAt.getTime() <= Date.now()) {
    throw new EconomyError("Craft finished. Collect it instead.", "invalid");
  }

  const recipe = getRecipeById(opts.guildId, entry.recipeId);
  const db = getDb();
  return db.transaction(() => {
    if (opts.refundInputs !== false && recipe) {
      for (const input of parseInputs(recipe.inputsJson)) {
        addInventory(opts.guildId, opts.userId, input.itemId, input.qty, opts.config);
      }
    }
    db.update(economyCraftQueue)
      .set({ cancelled: true })
      .where(eq(economyCraftQueue.id, entry.id))
      .run();
    return { entry: { ...entry, cancelled: true }, recipe };
  });
}

export function listReadyCrafts(guildId: string) {
  return getDb()
    .select()
    .from(economyCraftQueue)
    .where(and(eq(economyCraftQueue.guildId, guildId), eq(economyCraftQueue.collected, false), eq(economyCraftQueue.cancelled, false)))
    .all()
    .filter((r) => r.completesAt.getTime() <= Date.now());
}
