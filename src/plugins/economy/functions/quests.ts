import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  economyAchievementProgress,
  economyAchievements,
  economyQuestProgress,
  economyQuests,
} from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { EconomyError, isGuildPaused, mutateMoney } from "./money.js";
import { addInventory } from "./inventory.js";
import { calendarDay } from "./rewards.js";

function now() {
  return new Date();
}

function periodKeyForQuest(questType: string, timezone: string): string {
  if (questType === "daily") return calendarDay(timezone || "UTC");
  if (questType === "weekly") {
    const day = calendarDay(timezone || "UTC");
    const utc = new Date(`${day}T00:00:00Z`);
    const onejan = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((utc.getTime() - onejan.getTime()) / 86400000 + onejan.getUTCDay() + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return ""; // permanent / achievement-style quests
}

export function listQuests(guildId: string, enabledOnly = false) {
  const rows = getDb().select().from(economyQuests).where(eq(economyQuests.guildId, guildId)).all();
  return enabledOnly ? rows.filter((q) => q.enabled) : rows;
}

export function getQuestByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyQuests)
    .where(and(eq(economyQuests.guildId, guildId), eq(economyQuests.key, key)))
    .get();
}

export function getQuestById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyQuests)
    .where(and(eq(economyQuests.guildId, guildId), eq(economyQuests.id, id)))
    .get();
}

export function upsertQuest(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    questType?: string;
    objectiveType: string;
    objectiveTarget?: number;
    rewardCurrencyKey?: string;
    rewardAmount?: number;
    rewardItemId?: number | null;
    rewardItemQty?: number;
    enabled?: boolean;
  },
) {
  const existing = getQuestByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyQuests)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        questType: input.questType ?? existing.questType,
        objectiveType: input.objectiveType,
        objectiveTarget: input.objectiveTarget ?? existing.objectiveTarget,
        rewardCurrencyKey: input.rewardCurrencyKey ?? existing.rewardCurrencyKey,
        rewardAmount: input.rewardAmount ?? existing.rewardAmount,
        rewardItemId: input.rewardItemId === undefined ? existing.rewardItemId : input.rewardItemId,
        rewardItemQty: input.rewardItemQty ?? existing.rewardItemQty,
        enabled: input.enabled ?? existing.enabled,
      })
      .where(eq(economyQuests.id, existing.id))
      .run();
    return getQuestById(guildId, existing.id)!;
  }
  getDb()
    .insert(economyQuests)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      questType: input.questType ?? "daily",
      objectiveType: input.objectiveType,
      objectiveTarget: input.objectiveTarget ?? 1,
      rewardCurrencyKey: input.rewardCurrencyKey ?? "coins",
      rewardAmount: input.rewardAmount ?? 100,
      rewardItemId: input.rewardItemId ?? null,
      rewardItemQty: input.rewardItemQty ?? 0,
      enabled: input.enabled ?? true,
      createdAt: now(),
    })
    .run();
  return getQuestByKey(guildId, input.key)!;
}

export function deleteQuest(guildId: string, id: number) {
  getDb()
    .delete(economyQuests)
    .where(and(eq(economyQuests.guildId, guildId), eq(economyQuests.id, id)))
    .run();
}

export function listAchievements(guildId: string, enabledOnly = false) {
  const rows = getDb().select().from(economyAchievements).where(eq(economyAchievements.guildId, guildId)).all();
  return enabledOnly ? rows.filter((a) => a.enabled) : rows;
}

export function getAchievementByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyAchievements)
    .where(and(eq(economyAchievements.guildId, guildId), eq(economyAchievements.key, key)))
    .get();
}

export function upsertAchievement(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    objectiveType: string;
    objectiveTarget?: number;
    rewardCurrencyKey?: string;
    rewardAmount?: number;
    enabled?: boolean;
  },
) {
  const existing = getAchievementByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyAchievements)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        objectiveType: input.objectiveType,
        objectiveTarget: input.objectiveTarget ?? existing.objectiveTarget,
        rewardCurrencyKey: input.rewardCurrencyKey ?? existing.rewardCurrencyKey,
        rewardAmount: input.rewardAmount ?? existing.rewardAmount,
        enabled: input.enabled ?? existing.enabled,
      })
      .where(eq(economyAchievements.id, existing.id))
      .run();
    return getAchievementByKey(guildId, input.key)!;
  }
  getDb()
    .insert(economyAchievements)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      objectiveType: input.objectiveType,
      objectiveTarget: input.objectiveTarget ?? 1,
      rewardCurrencyKey: input.rewardCurrencyKey ?? "coins",
      rewardAmount: input.rewardAmount ?? 0,
      enabled: input.enabled ?? true,
      createdAt: now(),
    })
    .run();
  return getAchievementByKey(guildId, input.key)!;
}

export function deleteAchievement(guildId: string, id: number) {
  getDb()
    .delete(economyAchievements)
    .where(and(eq(economyAchievements.guildId, guildId), eq(economyAchievements.id, id)))
    .run();
}

function getOrCreateQuestProgress(
  guildId: string,
  userId: string,
  questId: number,
  periodKey: string,
) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyQuestProgress)
    .where(
      and(
        eq(economyQuestProgress.guildId, guildId),
        eq(economyQuestProgress.userId, userId),
        eq(economyQuestProgress.questId, questId),
        eq(economyQuestProgress.periodKey, periodKey),
      ),
    )
    .get();
  if (existing) return existing;
  db.insert(economyQuestProgress)
    .values({
      guildId,
      userId,
      questId,
      progress: 0,
      claimed: false,
      periodKey,
      updatedAt: now(),
    })
    .run();
  return db
    .select()
    .from(economyQuestProgress)
    .where(
      and(
        eq(economyQuestProgress.guildId, guildId),
        eq(economyQuestProgress.userId, userId),
        eq(economyQuestProgress.questId, questId),
        eq(economyQuestProgress.periodKey, periodKey),
      ),
    )
    .get()!;
}

export function listQuestProgress(guildId: string, userId: string, config: EconomyConfig) {
  const tz = config.rewards.timezone || "UTC";
  const quests = listQuests(guildId, true);
  return quests.map((quest) => {
    const periodKey = periodKeyForQuest(quest.questType, tz);
    const progress = getOrCreateQuestProgress(guildId, userId, quest.id, periodKey);
    return { quest, progress, periodKey };
  });
}

export function bumpProgress(
  guildId: string,
  userId: string,
  objectiveType: string,
  amount: number,
  config: EconomyConfig,
) {
  if (amount <= 0) return { questsUpdated: 0, achievementsUpdated: 0 };
  if (!config.modules.quests) return { questsUpdated: 0, achievementsUpdated: 0 };

  const tz = config.rewards.timezone || "UTC";
  let questsUpdated = 0;
  let achievementsUpdated = 0;
  const db = getDb();

  for (const quest of listQuests(guildId, true)) {
    if (quest.objectiveType !== objectiveType) continue;
    const periodKey = periodKeyForQuest(quest.questType, tz);
    const row = getOrCreateQuestProgress(guildId, userId, quest.id, periodKey);
    if (row.claimed) continue;
    const next = Math.min(row.progress + amount, quest.objectiveTarget);
    if (next === row.progress) continue;
    db.update(economyQuestProgress)
      .set({ progress: next, updatedAt: now() })
      .where(
        and(
          eq(economyQuestProgress.guildId, guildId),
          eq(economyQuestProgress.userId, userId),
          eq(economyQuestProgress.questId, quest.id),
          eq(economyQuestProgress.periodKey, periodKey),
        ),
      )
      .run();
    questsUpdated += 1;
  }

  for (const ach of listAchievements(guildId, true)) {
    if (ach.objectiveType !== objectiveType) continue;
    const existing = db
      .select()
      .from(economyAchievementProgress)
      .where(
        and(
          eq(economyAchievementProgress.guildId, guildId),
          eq(economyAchievementProgress.userId, userId),
          eq(economyAchievementProgress.achievementId, ach.id),
        ),
      )
      .get();
    if (existing?.completedAt) continue;
    const prev = existing?.progress ?? 0;
    const next = Math.min(prev + amount, ach.objectiveTarget);
    const completed = next >= ach.objectiveTarget;
    if (existing) {
      db.update(economyAchievementProgress)
        .set({
          progress: next,
          completedAt: completed ? now() : existing.completedAt,
        })
        .where(
          and(
            eq(economyAchievementProgress.guildId, guildId),
            eq(economyAchievementProgress.userId, userId),
            eq(economyAchievementProgress.achievementId, ach.id),
          ),
        )
        .run();
    } else {
      db.insert(economyAchievementProgress)
        .values({
          guildId,
          userId,
          achievementId: ach.id,
          progress: next,
          completedAt: completed ? now() : null,
        })
        .run();
    }
    if (completed && ach.rewardAmount > 0) {
      mutateMoney(
        {
          guildId,
          userId,
          currencyKey: ach.rewardCurrencyKey,
          deltaPocket: ach.rewardAmount,
          reason: "achievement_reward",
          refType: "achievement",
          refId: ach.key,
          idempotencyKey: `ach:${guildId}:${userId}:${ach.id}`,
        },
        { config },
      );
    }
    achievementsUpdated += 1;
  }

  return { questsUpdated, achievementsUpdated };
}

export function claimQuest(opts: {
  guildId: string;
  userId: string;
  questKey: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.quests) throw new EconomyError("Quests are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const quest = getQuestByKey(opts.guildId, opts.questKey);
  if (!quest || !quest.enabled) throw new EconomyError("Quest not found.", "not_found");

  const tz = opts.config.rewards.timezone || "UTC";
  const periodKey = periodKeyForQuest(quest.questType, tz);
  const row = getOrCreateQuestProgress(opts.guildId, opts.userId, quest.id, periodKey);
  if (row.claimed) throw new EconomyError("Already claimed.", "conflict");
  if (row.progress < quest.objectiveTarget) {
    throw new EconomyError(`Progress ${row.progress}/${quest.objectiveTarget}.`, "limit");
  }

  const db = getDb();
  return db.transaction(() => {
    if (quest.rewardAmount > 0) {
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: opts.userId,
          currencyKey: quest.rewardCurrencyKey,
          deltaPocket: quest.rewardAmount,
          reason: "quest_reward",
          refType: "quest",
          refId: quest.key,
          idempotencyKey: `quest:${opts.guildId}:${opts.userId}:${quest.id}:${periodKey}`,
        },
        { config: opts.config },
      );
    }
    if (quest.rewardItemId && quest.rewardItemQty > 0) {
      addInventory(opts.guildId, opts.userId, quest.rewardItemId, quest.rewardItemQty, opts.config);
    }
    db.update(economyQuestProgress)
      .set({ claimed: true, updatedAt: now() })
      .where(
        and(
          eq(economyQuestProgress.guildId, opts.guildId),
          eq(economyQuestProgress.userId, opts.userId),
          eq(economyQuestProgress.questId, quest.id),
          eq(economyQuestProgress.periodKey, periodKey),
        ),
      )
      .run();
    return { quest, periodKey, rewardAmount: quest.rewardAmount };
  });
}

export function seedDefaultQuests(guildId: string) {
  if (listQuests(guildId).length > 0) return;
  upsertQuest(guildId, {
    key: "daily_work",
    name: "Daily Grind",
    description: "Complete work or a job shift 3 times today.",
    questType: "daily",
    objectiveType: "work",
    objectiveTarget: 3,
    rewardAmount: 150,
  });
  upsertQuest(guildId, {
    key: "daily_messages",
    name: "Chatty",
    description: "Send 20 rewarded messages today.",
    questType: "daily",
    objectiveType: "message",
    objectiveTarget: 20,
    rewardAmount: 100,
  });
  upsertQuest(guildId, {
    key: "daily_shop",
    name: "Shopper",
    description: "Buy something from a shop today.",
    questType: "daily",
    objectiveType: "shop_buy",
    objectiveTarget: 1,
    rewardAmount: 75,
  });
  upsertAchievement(guildId, {
    key: "first_pet",
    name: "Pet Parent",
    description: "Adopt your first pet.",
    objectiveType: "pet_adopt",
    objectiveTarget: 1,
    rewardAmount: 200,
  });
  upsertAchievement(guildId, {
    key: "craft_10",
    name: "Artisan",
    description: "Collect 10 crafted items.",
    objectiveType: "craft_collect",
    objectiveTarget: 10,
    rewardAmount: 500,
  });
}
