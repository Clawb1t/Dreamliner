import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economySeasonScores, economySeasons } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { EconomyError, isGuildPaused, mutateMoney } from "./money.js";
import { addInventory } from "./inventory.js";

function now() {
  return new Date();
}

export type SeasonReward = {
  minRank?: number;
  maxRank?: number;
  minScore?: number;
  currencyKey?: string;
  amount?: number;
  itemId?: number;
  itemQty?: number;
};

function parseRewards(json: string): SeasonReward[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? (v as SeasonReward[]) : [];
  } catch {
    return [];
  }
}

export function listSeasons(guildId: string) {
  return getDb().select().from(economySeasons).where(eq(economySeasons.guildId, guildId)).all();
}

export function getSeasonByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economySeasons)
    .where(and(eq(economySeasons.guildId, guildId), eq(economySeasons.key, key)))
    .get();
}

export function getSeasonById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economySeasons)
    .where(and(eq(economySeasons.guildId, guildId), eq(economySeasons.id, id)))
    .get();
}

export function upsertSeason(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    startsAt: Date;
    endsAt: Date;
    softReset?: boolean;
    status?: string;
    rewards?: SeasonReward[];
  },
) {
  const rewardsJson = JSON.stringify(input.rewards ?? []);
  const existing = getSeasonByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economySeasons)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        softReset: input.softReset ?? existing.softReset,
        status: input.status ?? existing.status,
        rewardsJson: input.rewards ? rewardsJson : existing.rewardsJson,
      })
      .where(eq(economySeasons.id, existing.id))
      .run();
    return getSeasonById(guildId, existing.id)!;
  }
  getDb()
    .insert(economySeasons)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      softReset: input.softReset ?? false,
      status: input.status ?? "scheduled",
      rewardsJson,
      createdAt: now(),
    })
    .run();
  return getSeasonByKey(guildId, input.key)!;
}

export function deleteSeason(guildId: string, id: number) {
  getDb()
    .delete(economySeasonScores)
    .where(and(eq(economySeasonScores.guildId, guildId), eq(economySeasonScores.seasonId, id)))
    .run();
  getDb()
    .delete(economySeasons)
    .where(and(eq(economySeasons.guildId, guildId), eq(economySeasons.id, id)))
    .run();
}

export function getActiveSeason(guildId: string) {
  const nowMs = Date.now();
  const seasons = listSeasons(guildId);
  return (
    seasons.find(
      (s) =>
        (s.status === "active" || s.status === "scheduled") &&
        s.startsAt.getTime() <= nowMs &&
        s.endsAt.getTime() > nowMs,
    ) ?? null
  );
}

export function addSeasonScore(opts: {
  guildId: string;
  userId: string;
  amount: number;
  seasonId?: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.seasons) return null;
  if (opts.amount <= 0) return null;
  const season = opts.seasonId
    ? getSeasonById(opts.guildId, opts.seasonId)
    : getActiveSeason(opts.guildId);
  if (!season) return null;
  if (season.status === "ended" || season.status === "archived") return null;

  const db = getDb();
  const existing = db
    .select()
    .from(economySeasonScores)
    .where(
      and(
        eq(economySeasonScores.guildId, opts.guildId),
        eq(economySeasonScores.seasonId, season.id),
        eq(economySeasonScores.userId, opts.userId),
      ),
    )
    .get();
  if (existing) {
    db.update(economySeasonScores)
      .set({ score: existing.score + opts.amount, updatedAt: now() })
      .where(
        and(
          eq(economySeasonScores.guildId, opts.guildId),
          eq(economySeasonScores.seasonId, season.id),
          eq(economySeasonScores.userId, opts.userId),
        ),
      )
      .run();
    return { season, score: existing.score + opts.amount };
  }
  db.insert(economySeasonScores)
    .values({
      guildId: opts.guildId,
      seasonId: season.id,
      userId: opts.userId,
      score: opts.amount,
      claimed: false,
      updatedAt: now(),
    })
    .run();
  return { season, score: opts.amount };
}

export function getSeasonLeaderboard(guildId: string, seasonId: number, limit = 25) {
  return getDb()
    .select()
    .from(economySeasonScores)
    .where(and(eq(economySeasonScores.guildId, guildId), eq(economySeasonScores.seasonId, seasonId)))
    .orderBy(desc(economySeasonScores.score))
    .limit(Math.min(Math.max(limit, 1), 100))
    .all();
}

export function getUserSeasonScore(guildId: string, seasonId: number, userId: string) {
  return getDb()
    .select()
    .from(economySeasonScores)
    .where(
      and(
        eq(economySeasonScores.guildId, guildId),
        eq(economySeasonScores.seasonId, seasonId),
        eq(economySeasonScores.userId, userId),
      ),
    )
    .get();
}

function rankForUser(guildId: string, seasonId: number, userId: string): number {
  const board = getSeasonLeaderboard(guildId, seasonId, 1000);
  const idx = board.findIndex((r) => r.userId === userId);
  return idx >= 0 ? idx + 1 : board.length + 1;
}

export function claimSeasonRewards(opts: {
  guildId: string;
  userId: string;
  seasonId: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.seasons) throw new EconomyError("Seasons are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const season = getSeasonById(opts.guildId, opts.seasonId);
  if (!season) throw new EconomyError("Season not found.", "not_found");
  if (season.endsAt.getTime() > Date.now() && season.status !== "ended") {
    throw new EconomyError("Season has not ended yet.", "limit");
  }

  const scoreRow = getUserSeasonScore(opts.guildId, opts.seasonId, opts.userId);
  if (!scoreRow) throw new EconomyError("No season score.", "not_found");
  if (scoreRow.claimed) throw new EconomyError("Already claimed.", "conflict");

  const rank = rankForUser(opts.guildId, opts.seasonId, opts.userId);
  const rewards = parseRewards(season.rewardsJson).filter((r) => {
    if (r.minScore != null && scoreRow.score < r.minScore) return false;
    if (r.minRank != null && rank < r.minRank) return false;
    if (r.maxRank != null && rank > r.maxRank) return false;
    return true;
  });

  const db = getDb();
  return db.transaction(() => {
    const granted: SeasonReward[] = [];
    for (const reward of rewards) {
      if (reward.amount && reward.amount > 0) {
        mutateMoney(
          {
            guildId: opts.guildId,
            userId: opts.userId,
            currencyKey: reward.currencyKey ?? "coins",
            deltaPocket: reward.amount,
            reason: "season_reward",
            refType: "season",
            refId: season.key,
            idempotencyKey: `season:${opts.guildId}:${season.id}:${opts.userId}:${reward.currencyKey ?? "coins"}:${reward.amount}`,
          },
          { config: opts.config },
        );
        granted.push(reward);
      }
      if (reward.itemId && (reward.itemQty ?? 0) > 0) {
        addInventory(opts.guildId, opts.userId, reward.itemId, reward.itemQty!, opts.config);
        granted.push(reward);
      }
    }
    db.update(economySeasonScores)
      .set({ claimed: true, updatedAt: now() })
      .where(
        and(
          eq(economySeasonScores.guildId, opts.guildId),
          eq(economySeasonScores.seasonId, season.id),
          eq(economySeasonScores.userId, opts.userId),
        ),
      )
      .run();
    return { season, rank, score: scoreRow.score, granted };
  });
}

/**
 * Soft-reset helper: mark season ended/archived and zero live scores into an archive season key.
 * Does not wipe transaction history or balances.
 */
export function softResetSeason(opts: {
  guildId: string;
  seasonId: number;
  archiveKeySuffix?: string;
}) {
  const season = getSeasonById(opts.guildId, opts.seasonId);
  if (!season) throw new EconomyError("Season not found.", "not_found");

  const scores = getDb()
    .select()
    .from(economySeasonScores)
    .where(and(eq(economySeasonScores.guildId, opts.guildId), eq(economySeasonScores.seasonId, season.id)))
    .all();

  const archiveKey = `${season.key}${opts.archiveKeySuffix ?? "_archive"}`;
  let archive = getSeasonByKey(opts.guildId, archiveKey);
  if (!archive) {
    archive = upsertSeason(opts.guildId, {
      key: archiveKey,
      name: `${season.name} (Archive)`,
      description: season.description,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      softReset: true,
      status: "archived",
      rewards: parseRewards(season.rewardsJson),
    });
  }

  const db = getDb();
  db.transaction(() => {
    for (const row of scores) {
      const existing = getUserSeasonScore(opts.guildId, archive!.id, row.userId);
      if (existing) {
        db.update(economySeasonScores)
          .set({ score: existing.score + row.score, updatedAt: now() })
          .where(
            and(
              eq(economySeasonScores.guildId, opts.guildId),
              eq(economySeasonScores.seasonId, archive!.id),
              eq(economySeasonScores.userId, row.userId),
            ),
          )
          .run();
      } else {
        db.insert(economySeasonScores)
          .values({
            guildId: opts.guildId,
            seasonId: archive!.id,
            userId: row.userId,
            score: row.score,
            claimed: row.claimed,
            updatedAt: now(),
          })
          .run();
      }
    }
    db.delete(economySeasonScores)
      .where(and(eq(economySeasonScores.guildId, opts.guildId), eq(economySeasonScores.seasonId, season.id)))
      .run();
    db.update(economySeasons)
      .set({ status: "ended", softReset: true })
      .where(eq(economySeasons.id, season.id))
      .run();
  });

  return { season: getSeasonById(opts.guildId, season.id)!, archive, archivedScores: scores.length };
}
