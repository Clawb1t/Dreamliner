import type { Client } from "discord.js";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../../db/client.js";

/**
 * The stats a progression badge can track. Every metric is global per user (a badge sits on the
 * user's profile, not in one server). Values are whole numbers; a tier is reached at value >= its
 * threshold.
 */

export type BadgeMetric = {
  id: string;
  label: string;
  /** Plural unit for automatic tier names, e.g. "messages" in "1,000+ messages". */
  unit: string;
  description: string;
  /** Values for a batch of users (missing = 0). */
  values(client: Client, userIds: string[]): Promise<Map<string, number>>;
  /** How many users reach each threshold, for the dashboard. Absent when it can't be counted. */
  countAtLeast?(client: Client, thresholds: number[]): Promise<number[]>;
};

type Row = { user_id: string; value: number };

/** A metric backed by a per-user SQL aggregate. `source` gets a condition on the user id column
 *  so a batch lookup only touches those users' rows (every source column is indexed). */
function sqlMetric(meta: Omit<BadgeMetric, "values" | "countAtLeast">, source: (userFilter: SQL) => SQL): BadgeMetric {
  return {
    ...meta,
    async values(_client, userIds) {
      const values = new Map<string, number>();
      if (userIds.length === 0) return values;
      const list = sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const rows = getDb().all<Row>(source(sql`IN (${list})`));
      for (const row of rows) values.set(String(row.user_id), Math.floor(Number(row.value) || 0));
      return values;
    },
    async countAtLeast(_client, thresholds) {
      if (thresholds.length === 0) return [];
      const columns = sql.join(
        thresholds.map((threshold, index) => sql`COALESCE(SUM(value >= ${threshold}), 0) AS ${sql.raw(`c${index}`)}`),
        sql`, `,
      );
      const row = getDb().get<Record<string, number>>(sql`SELECT ${columns} FROM (${source(sql`IS NOT NULL`)})`);
      return thresholds.map((_, index) => Number(row?.[`c${index}`] ?? 0));
    },
  };
}

const messages = sqlMetric(
  { id: "messages", label: "Messages sent", unit: "messages", description: "Lifetime messages across every server" },
  (f) => sql`SELECT user_id, count AS value FROM user_message_counts WHERE user_id ${f}`,
);

const voiceMinutes = sqlMetric(
  { id: "voice_minutes", label: "Voice minutes", unit: "voice minutes", description: "Lifetime minutes in voice channels" },
  // Older rows only have whole minutes; newer ones have exact seconds.
  (f) => sql`SELECT user_id, CAST(SUM(MAX(seconds / 60.0, minutes)) AS INTEGER) AS value
    FROM guild_stats_user_voice_daily WHERE user_id ${f} GROUP BY user_id`,
);

const serversActive = sqlMetric(
  { id: "servers_active", label: "Servers active in", unit: "servers", description: "Servers they've sent messages in" },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM guild_message_counts WHERE count > 0 AND user_id ${f} GROUP BY user_id`,
);

const votes = sqlMetric(
  { id: "topgg_votes", label: "Top.gg votes", unit: "votes", description: "Times they've voted for Dreamliner" },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM store_votes WHERE user_id ${f} GROUP BY user_id`,
);

const suggestions = sqlMetric(
  { id: "suggestions", label: "Suggestions made", unit: "suggestions", description: "Suggestions posted in any server" },
  (f) => sql`SELECT author_id AS user_id, COUNT(*) AS value FROM suggestions WHERE author_id ${f} GROUP BY author_id`,
);

const reviews = sqlMetric(
  { id: "reviews", label: "Reviews written", unit: "reviews", description: "Server reviews they've written" },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM reviews WHERE deleted_at IS NULL AND user_id ${f} GROUP BY user_id`,
);

const planeCards = sqlMetric(
  { id: "plane_cards", label: "Plane cards collected", unit: "cards", description: "Different plane cards in their collection" },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM plane_card_inventory WHERE quantity > 0 AND user_id ${f} GROUP BY user_id`,
);

const dailyStreak = sqlMetric(
  { id: "daily_streak", label: "Daily streak", unit: "day streak", description: "Their current economy /daily streak" },
  (f) => sql`SELECT user_id, daily_streak AS value FROM economy_global_accounts WHERE user_id ${f}`,
);

const DISCORD_EPOCH = 1_420_070_400_000n;

/** Account creation time from a Discord snowflake. */
export function snowflakeCreatedAt(userId: string): number | null {
  try {
    return Number((BigInt(userId) >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

const accountAge: BadgeMetric = {
  id: "account_age_days",
  label: "Discord account age",
  unit: "days on Discord",
  description: "Days since their Discord account was created",
  async values(_client, userIds) {
    const values = new Map<string, number>();
    for (const userId of userIds) {
      const createdAt = snowflakeCreatedAt(userId);
      if (createdAt != null) values.set(userId, Math.max(0, Math.floor((Date.now() - createdAt) / 86_400_000)));
    }
    return values;
  },
};

/** Servers each user owns that have active Dreamliner One. */
async function oneServersByOwner(client: Client): Promise<Map<string, number>> {
  const { listActiveOneGuildsSince } = await import("../../bridge/dreamlinerOne.js");
  const counts = new Map<string, number>();
  for (const guildId of (await listActiveOneGuildsSince()).keys()) {
    const ownerId = client.guilds.cache.get(guildId)?.ownerId;
    if (ownerId) counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
  }
  return counts;
}

const oneServers: BadgeMetric = {
  id: "one_servers",
  label: "Dreamliner One servers owned",
  unit: "One servers",
  description: "Servers they own with active Dreamliner One",
  async values(client, userIds) {
    const all = await oneServersByOwner(client);
    return new Map(userIds.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
  },
  async countAtLeast(client, thresholds) {
    const all = [...(await oneServersByOwner(client)).values()];
    return thresholds.map((threshold) => all.filter((value) => value >= threshold).length);
  },
};

/** No stat: the badge is only ever assigned by hand. */
export const MANUAL_METRIC_ID = "manual";
const manual: BadgeMetric = {
  id: MANUAL_METRIC_ID,
  label: "Assigned only",
  unit: "",
  description: "Not earned automatically; assign each tier by hand",
  async values() {
    return new Map();
  },
};

export const METRICS: BadgeMetric[] = [
  messages,
  voiceMinutes,
  serversActive,
  votes,
  suggestions,
  reviews,
  planeCards,
  dailyStreak,
  accountAge,
  oneServers,
  manual,
];

export function getMetric(id: string): BadgeMetric | null {
  return METRICS.find((metric) => metric.id === id) ?? null;
}
