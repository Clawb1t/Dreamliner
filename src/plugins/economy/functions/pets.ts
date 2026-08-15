import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyPetSpecies, economyPets, economyProfiles } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  EconomyError,
  ensureProfile,
  getPrimaryCurrencyKey,
  grantStartingBalance,
  isGuildPaused,
  mutateMoney,
} from "./money.js";
import { assertCooldown, setCooldown } from "./inventory.js";

function now() {
  return new Date();
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function listSpecies(guildId: string, enabledOnly = false) {
  const rows = getDb().select().from(economyPetSpecies).where(eq(economyPetSpecies.guildId, guildId)).all();
  return enabledOnly ? rows.filter((s) => s.enabled) : rows;
}

export function getSpeciesByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyPetSpecies)
    .where(and(eq(economyPetSpecies.guildId, guildId), eq(economyPetSpecies.key, key)))
    .get();
}

export function getSpeciesById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyPetSpecies)
    .where(and(eq(economyPetSpecies.guildId, guildId), eq(economyPetSpecies.id, id)))
    .get();
}

export function upsertSpecies(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    emoji?: string;
    rarity?: string;
    baseAtk?: number;
    baseDef?: number;
    baseHp?: number;
    baseSpeed?: number;
    adoptCost?: number;
    currencyKey?: string;
    enabled?: boolean;
  },
) {
  const existing = getSpeciesByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyPetSpecies)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        emoji: input.emoji ?? existing.emoji,
        rarity: input.rarity ?? existing.rarity,
        baseAtk: input.baseAtk ?? existing.baseAtk,
        baseDef: input.baseDef ?? existing.baseDef,
        baseHp: input.baseHp ?? existing.baseHp,
        baseSpeed: input.baseSpeed ?? existing.baseSpeed,
        adoptCost: input.adoptCost ?? existing.adoptCost,
        currencyKey: input.currencyKey ?? existing.currencyKey,
        enabled: input.enabled ?? existing.enabled,
      })
      .where(eq(economyPetSpecies.id, existing.id))
      .run();
    return getSpeciesById(guildId, existing.id)!;
  }
  getDb()
    .insert(economyPetSpecies)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      emoji: input.emoji ?? "🐾",
      rarity: input.rarity ?? "common",
      baseAtk: input.baseAtk ?? 10,
      baseDef: input.baseDef ?? 10,
      baseHp: input.baseHp ?? 50,
      baseSpeed: input.baseSpeed ?? 10,
      adoptCost: input.adoptCost ?? 500,
      currencyKey: input.currencyKey ?? "coins",
      enabled: input.enabled ?? true,
      createdAt: now(),
    })
    .run();
  return getSpeciesByKey(guildId, input.key)!;
}

export function deleteSpecies(guildId: string, id: number) {
  getDb()
    .delete(economyPetSpecies)
    .where(and(eq(economyPetSpecies.guildId, guildId), eq(economyPetSpecies.id, id)))
    .run();
}

export function listOwnedPets(guildId: string, userId: string) {
  return getDb()
    .select()
    .from(economyPets)
    .where(and(eq(economyPets.guildId, guildId), eq(economyPets.userId, userId)))
    .all();
}

export function getPet(guildId: string, petId: number) {
  return getDb()
    .select()
    .from(economyPets)
    .where(and(eq(economyPets.guildId, guildId), eq(economyPets.id, petId)))
    .get();
}

export function adoptPet(opts: {
  guildId: string;
  userId: string;
  speciesKey: string;
  name?: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.pets) throw new EconomyError("Pets are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  grantStartingBalance(opts.guildId, opts.userId, opts.config);

  const species = getSpeciesByKey(opts.guildId, opts.speciesKey);
  if (!species || !species.enabled) throw new EconomyError("Species not found.", "not_found");

  const owned = listOwnedPets(opts.guildId, opts.userId);
  if (owned.length >= opts.config.pets.max_pets) {
    throw new EconomyError(`You can own at most ${opts.config.pets.max_pets} pets.`, "limit");
  }

  const currencyKey = species.currencyKey || getPrimaryCurrencyKey(opts.guildId, opts.config);
  const db = getDb();
  return db.transaction(() => {
    if (species.adoptCost > 0) {
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: opts.userId,
          currencyKey,
          deltaPocket: -species.adoptCost,
          reason: "pet_adopt",
          refType: "species",
          refId: species.key,
        },
        { config: opts.config },
      );
    }
    db.insert(economyPets)
      .values({
        guildId: opts.guildId,
        userId: opts.userId,
        speciesId: species.id,
        name: opts.name?.trim() || species.name,
        xp: 0,
        level: 1,
        hunger: 100,
        energy: 100,
        happiness: 100,
        atk: species.baseAtk,
        def: species.baseDef,
        hp: species.baseHp,
        speed: species.baseSpeed,
        lastTickAt: now(),
        createdAt: now(),
      })
      .run();
    const pet = listOwnedPets(opts.guildId, opts.userId).at(-1)!;
    const profile = ensureProfile(opts.guildId, opts.userId);
    if (!profile.activePetId) {
      db.update(economyProfiles)
        .set({ activePetId: pet.id, updatedAt: now() })
        .where(and(eq(economyProfiles.guildId, opts.guildId), eq(economyProfiles.userId, opts.userId)))
        .run();
    }
    return { pet, species, cost: species.adoptCost, currencyKey };
  });
}

export function setActivePet(guildId: string, userId: string, petId: number | null) {
  ensureProfile(guildId, userId);
  if (petId !== null) {
    const pet = getPet(guildId, petId);
    if (!pet || pet.userId !== userId) throw new EconomyError("Pet not found.", "not_found");
  }
  getDb()
    .update(economyProfiles)
    .set({ activePetId: petId, updatedAt: now() })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
}

/** Apply hunger/energy decay since lastTickAt. Call before care actions. */
export function lazyTickPet(petId: number, guildId: string, config: EconomyConfig) {
  const pet = getPet(guildId, petId);
  if (!pet) throw new EconomyError("Pet not found.", "not_found");
  const elapsedMs = Math.max(0, Date.now() - pet.lastTickAt.getTime());
  const hours = elapsedMs / 3_600_000;
  if (hours < 0.01) return pet;

  const hungerLoss = Math.floor(hours * config.pets.hunger_decay_per_hour);
  const energyLoss = Math.floor(hours * config.pets.energy_decay_per_hour);
  if (hungerLoss <= 0 && energyLoss <= 0) {
    getDb()
      .update(economyPets)
      .set({ lastTickAt: now() })
      .where(eq(economyPets.id, pet.id))
      .run();
    return { ...pet, lastTickAt: now() };
  }

  const hunger = clamp(pet.hunger - hungerLoss, 0, 100);
  const energy = clamp(pet.energy - energyLoss, 0, 100);
  const happiness = clamp(pet.happiness - Math.floor((hungerLoss + energyLoss) / 4), 0, 100);
  getDb()
    .update(economyPets)
    .set({ hunger, energy, happiness, lastTickAt: now() })
    .where(eq(economyPets.id, pet.id))
    .run();
  return { ...pet, hunger, energy, happiness, lastTickAt: now() };
}

export function lazyTickPets(guildId: string, userId: string, config: EconomyConfig) {
  return listOwnedPets(guildId, userId).map((p) => lazyTickPet(p.id, guildId, config));
}

function requireOwnedPet(guildId: string, userId: string, petId: number, config: EconomyConfig) {
  if (!config.modules.pets) throw new EconomyError("Pets are disabled.", "invalid");
  let pet = lazyTickPet(petId, guildId, config);
  if (pet.userId !== userId) throw new EconomyError("Pet not found.", "not_found");
  return pet;
}

function persistPet(
  petId: number,
  patch: Partial<{
    name: string;
    xp: number;
    level: number;
    hunger: number;
    energy: number;
    happiness: number;
    atk: number;
    def: number;
    hp: number;
    speed: number;
  }>,
) {
  getDb()
    .update(economyPets)
    .set({ ...patch, lastTickAt: now() })
    .where(eq(economyPets.id, petId))
    .run();
  return getDb().select().from(economyPets).where(eq(economyPets.id, petId)).get()!;
}

function addPetXp(pet: { id: number; xp: number; level: number; atk: number; def: number; hp: number; speed: number }, amount: number) {
  let xp = pet.xp + amount;
  let level = pet.level;
  let atk = pet.atk;
  let def = pet.def;
  let hp = pet.hp;
  let speed = pet.speed;
  let need = 40 + level * 20;
  while (xp >= need && level < 100) {
    xp -= need;
    level += 1;
    atk += 1;
    def += 1;
    hp += 2;
    speed += 1;
    need = 40 + level * 20;
  }
  return persistPet(pet.id, { xp, level, atk, def, hp, speed });
}

export function feedPet(opts: {
  guildId: string;
  userId: string;
  petId: number;
  config: EconomyConfig;
}) {
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  const pet = requireOwnedPet(opts.guildId, opts.userId, opts.petId, opts.config);
  assertCooldown(opts.guildId, opts.userId, `pet_feed:${opts.petId}`);
  const cost = opts.config.pets.feed_cost;
  const currencyKey = getPrimaryCurrencyKey(opts.guildId, opts.config);
  if (cost > 0) {
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey,
        deltaPocket: -cost,
        reason: "pet_feed",
        refType: "pet",
        refId: String(pet.id),
      },
      { config: opts.config },
    );
  }
  const updated = persistPet(pet.id, {
    hunger: clamp(pet.hunger + 35, 0, 100),
    happiness: clamp(pet.happiness + 5, 0, 100),
  });
  setCooldown(opts.guildId, opts.userId, `pet_feed:${opts.petId}`, new Date(Date.now() + 60_000));
  return { pet: updated, cost, currencyKey };
}

export function playWithPet(opts: {
  guildId: string;
  userId: string;
  petId: number;
  config: EconomyConfig;
}) {
  const pet = requireOwnedPet(opts.guildId, opts.userId, opts.petId, opts.config);
  assertCooldown(opts.guildId, opts.userId, `pet_play:${opts.petId}`);
  const energyCost = opts.config.pets.play_energy_cost;
  if (pet.energy < energyCost) throw new EconomyError("Your pet is too tired.", "limit");
  if (pet.hunger < 10) throw new EconomyError("Your pet is too hungry to play.", "limit");
  const updated = persistPet(pet.id, {
    energy: clamp(pet.energy - energyCost, 0, 100),
    happiness: clamp(pet.happiness + 20, 0, 100),
    hunger: clamp(pet.hunger - 5, 0, 100),
  });
  setCooldown(opts.guildId, opts.userId, `pet_play:${opts.petId}`, new Date(Date.now() + 120_000));
  return { pet: addPetXp(updated, 5) };
}

export function trainPet(opts: {
  guildId: string;
  userId: string;
  petId: number;
  config: EconomyConfig;
}) {
  const pet = requireOwnedPet(opts.guildId, opts.userId, opts.petId, opts.config);
  assertCooldown(opts.guildId, opts.userId, `pet_train:${opts.petId}`);
  if (pet.energy < 20) throw new EconomyError("Your pet needs more energy to train.", "limit");
  const updated = persistPet(pet.id, {
    energy: clamp(pet.energy - 20, 0, 100),
    hunger: clamp(pet.hunger - 8, 0, 100),
    happiness: clamp(pet.happiness - 2, 0, 100),
  });
  setCooldown(opts.guildId, opts.userId, `pet_train:${opts.petId}`, new Date(Date.now() + 300_000));
  return { pet: addPetXp(updated, 15) };
}

export function adventurePet(opts: {
  guildId: string;
  userId: string;
  petId: number;
  config: EconomyConfig;
}) {
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  const pet = requireOwnedPet(opts.guildId, opts.userId, opts.petId, opts.config);
  assertCooldown(opts.guildId, opts.userId, `pet_adventure:${opts.petId}`);
  if (pet.energy < 30 || pet.hunger < 20) {
    throw new EconomyError("Your pet is not ready for an adventure.", "limit");
  }
  const success = Math.random() < 0.65 + pet.level * 0.01;
  const reward = success ? 20 + Math.floor(Math.random() * (30 + pet.level * 5)) : 0;
  const currencyKey = getPrimaryCurrencyKey(opts.guildId, opts.config);
  const updated = persistPet(pet.id, {
    energy: clamp(pet.energy - 30, 0, 100),
    hunger: clamp(pet.hunger - 15, 0, 100),
    happiness: clamp(pet.happiness + (success ? 10 : -5), 0, 100),
  });
  if (reward > 0) {
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey,
        deltaPocket: reward,
        reason: "pet_adventure",
        refType: "pet",
        refId: String(pet.id),
      },
      { config: opts.config },
    );
  }
  setCooldown(opts.guildId, opts.userId, `pet_adventure:${opts.petId}`, new Date(Date.now() + 900_000));
  return {
    pet: addPetXp(updated, success ? 20 : 5),
    success,
    reward,
    currencyKey,
  };
}

export function renamePet(guildId: string, userId: string, petId: number, name: string, config: EconomyConfig) {
  const pet = requireOwnedPet(guildId, userId, petId, config);
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) throw new EconomyError("Name cannot be empty.", "invalid");
  return persistPet(pet.id, { name: trimmed });
}

export function releasePet(guildId: string, userId: string, petId: number, config: EconomyConfig) {
  const pet = requireOwnedPet(guildId, userId, petId, config);
  const profile = ensureProfile(guildId, userId);
  getDb().delete(economyPets).where(eq(economyPets.id, pet.id)).run();
  if (profile.activePetId === pet.id) {
    const remaining = listOwnedPets(guildId, userId);
    getDb()
      .update(economyProfiles)
      .set({ activePetId: remaining[0]?.id ?? null, updatedAt: now() })
      .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
      .run();
  }
  return pet;
}

function powerScore(pet: { atk: number; def: number; hp: number; speed: number; level: number; happiness: number }) {
  return pet.atk * 2 + pet.def * 1.5 + pet.hp + pet.speed * 1.2 + pet.level * 5 + pet.happiness * 0.2;
}

/** Friendly non-wager battle — no currency changes. */
export function battlePets(opts: {
  guildId: string;
  challengerUserId: string;
  challengerPetId: number;
  opponentPetId: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.pets) throw new EconomyError("Pets are disabled.", "invalid");
  if (!opts.config.pets.battles_enabled) throw new EconomyError("Pet battles are disabled.", "invalid");

  const a = requireOwnedPet(opts.guildId, opts.challengerUserId, opts.challengerPetId, opts.config);
  const bRaw = lazyTickPet(opts.opponentPetId, opts.guildId, opts.config);
  if (!bRaw) throw new EconomyError("Opponent pet not found.", "not_found");
  if (bRaw.id === a.id) throw new EconomyError("A pet cannot battle itself.", "invalid");

  if (a.energy < 15) throw new EconomyError("Your pet is too tired to battle.", "limit");
  if (bRaw.energy < 15) throw new EconomyError("Opponent pet is too tired.", "limit");

  const scoreA = powerScore(a) * (0.85 + Math.random() * 0.3);
  const scoreB = powerScore(bRaw) * (0.85 + Math.random() * 0.3);
  const challengerWon = scoreA >= scoreB;

  const aAfter = persistPet(a.id, {
    energy: clamp(a.energy - 15, 0, 100),
    happiness: clamp(a.happiness + (challengerWon ? 8 : -3), 0, 100),
  });
  const bAfter = persistPet(bRaw.id, {
    energy: clamp(bRaw.energy - 15, 0, 100),
    happiness: clamp(bRaw.happiness + (challengerWon ? -3 : 8), 0, 100),
  });

  return {
    winnerPetId: challengerWon ? a.id : bRaw.id,
    loserPetId: challengerWon ? bRaw.id : a.id,
    challengerWon,
    challenger: addPetXp(aAfter, challengerWon ? 12 : 4),
    opponent: addPetXp(bAfter, challengerWon ? 4 : 12),
    scoreA: Math.round(scoreA),
    scoreB: Math.round(scoreB),
  };
}

export function seedDefaultSpecies(guildId: string) {
  if (listSpecies(guildId).length > 0) return;
  upsertSpecies(guildId, {
    key: "pup",
    name: "Village Pup",
    description: "A loyal starter companion.",
    emoji: "🐶",
    rarity: "common",
    baseAtk: 8,
    baseDef: 10,
    baseHp: 40,
    baseSpeed: 12,
    adoptCost: 250,
  });
  upsertSpecies(guildId, {
    key: "kit",
    name: "Forest Kit",
    description: "Quick and curious.",
    emoji: "🦊",
    rarity: "uncommon",
    baseAtk: 12,
    baseDef: 8,
    baseHp: 35,
    baseSpeed: 16,
    adoptCost: 500,
  });
}
