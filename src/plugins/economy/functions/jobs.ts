import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyJobs, economyProfiles } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  EconomyError,
  ensureProfile,
  getPrimaryCurrencyKey,
  grantStartingBalance,
  isGuildPaused,
  mutateMoney,
} from "./money.js";
import { assertCooldown, getInventoryQty, getItemById, setCooldown } from "./inventory.js";

function now() {
  return new Date();
}

function parseFlavor(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pickFlavor(flavorJson: string, failed: boolean): string {
  const lines = parseFlavor(flavorJson);
  if (lines.length === 0) {
    return failed ? "The shift did not go well." : "You completed your shift.";
  }
  return lines[Math.floor(Math.random() * lines.length)]!;
}

export function listJobs(guildId: string, enabledOnly = false) {
  const rows = getDb().select().from(economyJobs).where(eq(economyJobs.guildId, guildId)).all();
  return enabledOnly ? rows.filter((j) => j.enabled) : rows;
}

export function getJobByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyJobs)
    .where(and(eq(economyJobs.guildId, guildId), eq(economyJobs.key, key)))
    .get();
}

export function getJobById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyJobs)
    .where(and(eq(economyJobs.guildId, guildId), eq(economyJobs.id, id)))
    .get();
}

export function upsertJob(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    emoji?: string;
    payMin?: number;
    payMax?: number;
    currencyKey?: string;
    cooldownSeconds?: number;
    requiredLevel?: number;
    requiredItemId?: number | null;
    failChanceBps?: number;
    failFine?: number;
    careerXp?: number;
    enabled?: boolean;
    flavorJson?: string;
  },
) {
  const existing = getJobByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyJobs)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        emoji: input.emoji ?? existing.emoji,
        payMin: input.payMin ?? existing.payMin,
        payMax: input.payMax ?? existing.payMax,
        currencyKey: input.currencyKey ?? existing.currencyKey,
        cooldownSeconds: input.cooldownSeconds ?? existing.cooldownSeconds,
        requiredLevel: input.requiredLevel ?? existing.requiredLevel,
        requiredItemId: input.requiredItemId === undefined ? existing.requiredItemId : input.requiredItemId,
        failChanceBps: input.failChanceBps ?? existing.failChanceBps,
        failFine: input.failFine ?? existing.failFine,
        careerXp: input.careerXp ?? existing.careerXp,
        enabled: input.enabled ?? existing.enabled,
        flavorJson: input.flavorJson ?? existing.flavorJson,
      })
      .where(eq(economyJobs.id, existing.id))
      .run();
    return getJobById(guildId, existing.id)!;
  }
  getDb()
    .insert(economyJobs)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      emoji: input.emoji ?? "💼",
      payMin: input.payMin ?? 50,
      payMax: input.payMax ?? 150,
      currencyKey: input.currencyKey ?? "coins",
      cooldownSeconds: input.cooldownSeconds ?? 3600,
      requiredLevel: input.requiredLevel ?? 1,
      requiredItemId: input.requiredItemId ?? null,
      failChanceBps: input.failChanceBps ?? 0,
      failFine: input.failFine ?? 0,
      careerXp: input.careerXp ?? 10,
      enabled: input.enabled ?? true,
      flavorJson: input.flavorJson ?? "[]",
      createdAt: now(),
    })
    .run();
  return getJobByKey(guildId, input.key)!;
}

export function deleteJob(guildId: string, id: number) {
  getDb()
    .delete(economyJobs)
    .where(and(eq(economyJobs.guildId, guildId), eq(economyJobs.id, id)))
    .run();
}

export function chooseJob(guildId: string, userId: string, jobKey: string, config: EconomyConfig) {
  if (!config.modules.jobs) throw new EconomyError("Jobs are disabled.", "invalid");
  const job = getJobByKey(guildId, jobKey);
  if (!job || !job.enabled) throw new EconomyError("Job not found.", "not_found");
  const profile = ensureProfile(guildId, userId);
  if (profile.level < job.requiredLevel) {
    throw new EconomyError(`Requires economy level ${job.requiredLevel}.`, "limit");
  }
  if (job.requiredItemId) {
    const have = getInventoryQty(guildId, userId, job.requiredItemId);
    if (have < 1) {
      const item = getItemById(guildId, job.requiredItemId);
      throw new EconomyError(
        item ? `You need a ${item.name} for this job.` : "You lack the required item for this job.",
        "insufficient",
        {
          kind: "items",
          itemName: item?.name,
          itemEmoji: item?.emoji,
          required: 1,
          available: have,
        },
      );
    }
  }
  getDb()
    .update(economyProfiles)
    .set({ jobKey: job.key, updatedAt: now() })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
  return job;
}

export function resignJob(guildId: string, userId: string) {
  ensureProfile(guildId, userId);
  getDb()
    .update(economyProfiles)
    .set({ jobKey: null, updatedAt: now() })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
}

function addJobXp(guildId: string, userId: string, amount: number) {
  if (amount <= 0) return ensureProfile(guildId, userId);
  const profile = ensureProfile(guildId, userId);
  let jobXp = profile.jobXp + amount;
  let jobLevel = profile.jobLevel;
  let need = 50 + jobLevel * 25;
  while (jobXp >= need && jobLevel < 10_000) {
    jobXp -= need;
    jobLevel += 1;
    need = 50 + jobLevel * 25;
  }
  getDb()
    .update(economyProfiles)
    .set({ jobXp, jobLevel, updatedAt: now() })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
  return { ...profile, jobXp, jobLevel };
}

export function doJobWork(opts: {
  guildId: string;
  userId: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.jobs) throw new EconomyError("Jobs are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  grantStartingBalance(opts.guildId, opts.userId, opts.config);

  const profile = ensureProfile(opts.guildId, opts.userId);
  if (!profile.jobKey) throw new EconomyError("You do not have a job. Choose one first.", "invalid");
  const job = getJobByKey(opts.guildId, profile.jobKey);
  if (!job || !job.enabled) throw new EconomyError("Your job is no longer available.", "not_found");

  const cdKey = `job:${job.key}`;
  assertCooldown(opts.guildId, opts.userId, cdKey);

  const failed = job.failChanceBps > 0 && Math.random() * 10_000 < job.failChanceBps;
  const flavor = pickFlavor(job.flavorJson, failed);
  const currencyKey = job.currencyKey || getPrimaryCurrencyKey(opts.guildId, opts.config);

  let paid = 0;
  if (failed) {
    if (job.failFine > 0) {
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: opts.userId,
          currencyKey,
          deltaPocket: -job.failFine,
          reason: "job_fail_fine",
          refType: "job",
          refId: job.key,
          meta: { flavor },
        },
        { config: opts.config },
      );
      paid = -job.failFine;
    }
  } else {
    const min = job.payMin;
    const max = Math.max(min, job.payMax);
    const levelBonus = Math.floor((profile.jobLevel - 1) * 2);
    paid = min + Math.floor(Math.random() * (max - min + 1)) + levelBonus;
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey,
        deltaPocket: paid,
        reason: "job_work",
        refType: "job",
        refId: job.key,
        meta: { flavor, jobLevel: profile.jobLevel },
      },
      { config: opts.config },
    );
    addJobXp(opts.guildId, opts.userId, job.careerXp);
  }

  setCooldown(
    opts.guildId,
    opts.userId,
    cdKey,
    new Date(Date.now() + Math.max(1, job.cooldownSeconds) * 1000),
  );

  return {
    job,
    failed,
    paid,
    currencyKey,
    flavor,
    profile: ensureProfile(opts.guildId, opts.userId),
  };
}

export function seedDefaultJobs(guildId: string) {
  if (listJobs(guildId).length > 0) return;
  upsertJob(guildId, {
    key: "cashier",
    name: "Cashier",
    description: "Ring up customers at the general store.",
    emoji: "🧾",
    payMin: 40,
    payMax: 90,
    cooldownSeconds: 1800,
    requiredLevel: 1,
    careerXp: 8,
    flavorJson: JSON.stringify([
      "You scanned a mountain of snacks.",
      "A customer paid entirely in pennies.",
      "You survived the lunch rush.",
    ]),
  });
  upsertJob(guildId, {
    key: "fisher",
    name: "Fisher",
    description: "Cast a line and hope for the best.",
    emoji: "🎣",
    payMin: 60,
    payMax: 140,
    cooldownSeconds: 3600,
    requiredLevel: 2,
    careerXp: 12,
    failChanceBps: 800,
    failFine: 10,
    flavorJson: JSON.stringify([
      "You reeled in a shiny catch.",
      "The line snapped at the worst moment.",
      "A seagull stole your bait.",
    ]),
  });
}
