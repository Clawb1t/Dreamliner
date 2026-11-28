import type { Client } from "discord.js";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import type { GlyphId } from "./glyphs.js";

/**
 * The stats a progression badge can track. Every metric is global per user (a badge sits on the
 * user's profile, not in one server). Values are whole numbers; a tier is reached at value >= its
 * threshold.
 *
 * Each metric also carries its copy for the badge window (`levelUp`), the icon used for generated
 * tier art, and a suggested tier ladder the superuser dashboard offers as a prefill when a badge
 * is made for it. Nothing here creates badges: they're only ever made on the dashboard.
 */

export type SuggestedTier = { threshold: number; name: string };

export type BadgeMetric = {
  id: string;
  label: string;
  /** Plural unit for automatic tier names, e.g. "messages" in "1,000+ messages". */
  unit: string;
  /** Singular unit, e.g. "message" in "1 more message". */
  unitOne: string;
  description: string;
  /** One calm sentence on how to move up, shown in the badge window. */
  levelUp: string;
  /** Group in the dashboard's stat picker. */
  category: MetricCategory;
  /** Icon for generated tier art (glyphs.ts). */
  icon: GlyphId;
  /** A starting ladder for a new badge on this stat (editable; never saved on its own). */
  suggestedTiers: SuggestedTier[];
  /** Values for a batch of users (missing = 0). */
  values(client: Client, userIds: string[]): Promise<Map<string, number>>;
  /** How many users reach each threshold, for the dashboard and rarity. Absent when it can't be
   *  counted cheaply. */
  countAtLeast?(client: Client, thresholds: number[]): Promise<number[]>;
};

export type MetricCategory = "activity" | "community" | "hangar" | "fun" | "support" | "account" | "other";

type MetricMeta = Omit<BadgeMetric, "values" | "countAtLeast">;
type Row = { user_id: string; value: number };

function userList(userIds: string[]): SQL {
  return sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** A metric backed by a per-user SQL aggregate. `source` gets a condition on the user id column
 *  so a batch lookup only touches those users' rows (every source column is indexed). */
function sqlMetric(meta: MetricMeta, source: (userFilter: SQL) => SQL): BadgeMetric {
  return {
    ...meta,
    async values(_client, userIds) {
      const values = new Map<string, number>();
      if (userIds.length === 0) return values;
      const rows = getDb().all<Row>(source(sql`IN (${userList(userIds)})`));
      for (const row of rows) {
        const id = String(row.user_id);
        values.set(id, (values.get(id) ?? 0) + Math.floor(Number(row.value) || 0));
      }
      return values;
    },
    async countAtLeast(_client, thresholds) {
      if (thresholds.length === 0) return [];
      const columns = sql.join(
        thresholds.map((threshold, index) => sql`COALESCE(SUM(value >= ${threshold}), 0) AS ${sql.raw(`c${index}`)}`),
        sql`, `,
      );
      // Sources may return several rows per user (a UNION), so they're summed per user first.
      const row = getDb().get<Record<string, number>>(
        sql`SELECT ${columns} FROM (SELECT user_id, SUM(value) AS value FROM (${source(sql`IS NOT NULL`)}) GROUP BY user_id)`,
      );
      return thresholds.map((_, index) => Number(row?.[`c${index}`] ?? 0));
    },
  };
}

const ladder = (...tiers: Array<[number, string]>): SuggestedTier[] => tiers.map(([threshold, name]) => ({ threshold, name }));

// --- Activity --------------------------------------------------------------------------------

const messages = sqlMetric(
  {
    id: "messages",
    label: "Messages sent",
    unit: "messages",
    unitOne: "message",
    description: "Lifetime messages across every server",
    levelUp: "Send messages in any server with Dreamliner.",
    category: "activity",
    icon: "message",
    suggestedTiers: ladder([100, "Hello"], [1_000, "Regular"], [5_000, "Conversationalist"], [10_000, "Chatterbox"], [25_000, "Storyteller"], [50_000, "Voice of the room"], [100_000, "Legend"]),
  },
  (f) => sql`SELECT user_id, count AS value FROM user_message_counts WHERE user_id ${f}`,
);

const voiceMinutes = sqlMetric(
  {
    id: "voice_minutes",
    label: "Voice minutes",
    unit: "voice minutes",
    unitOne: "voice minute",
    description: "Lifetime minutes in voice channels",
    levelUp: "Spend time in voice channels in any server with Dreamliner.",
    category: "activity",
    icon: "mic",
    suggestedTiers: ladder([60, "Tuned in"], [600, "On the air"], [3_000, "Frequent caller"], [6_000, "Night owl"], [30_000, "Broadcaster"], [60_000, "Voice veteran"]),
  },
  // Older rows only have whole minutes; newer ones have exact seconds.
  (f) => sql`SELECT user_id, CAST(SUM(MAX(seconds / 60.0, minutes)) AS INTEGER) AS value
    FROM guild_stats_user_voice_daily WHERE user_id ${f} GROUP BY user_id`,
);

const voiceHours = sqlMetric(
  {
    id: "voice_hours",
    label: "Voice hours",
    unit: "hours in voice",
    unitOne: "hour in voice",
    description: "Lifetime hours in voice channels",
    levelUp: "Spend time in voice channels in any server with Dreamliner.",
    category: "activity",
    icon: "mic",
    suggestedTiers: ladder([1, "Tuned in"], [10, "On the air"], [50, "Frequent caller"], [100, "Night owl"], [250, "Broadcaster"], [500, "Voice veteran"], [1_000, "Mainstay"]),
  },
  (f) => sql`SELECT user_id, CAST(SUM(MAX(seconds / 60.0, minutes)) / 60 AS INTEGER) AS value
    FROM guild_stats_user_voice_daily WHERE user_id ${f} GROUP BY user_id`,
);

const activeDays = sqlMetric(
  {
    id: "active_days",
    label: "Active days",
    unit: "active days",
    unitOne: "active day",
    description: "Days they've sent at least one message anywhere",
    levelUp: "Send a message on a new day. Any server with Dreamliner counts.",
    category: "activity",
    icon: "calendar",
    suggestedTiers: ladder([7, "First week"], [30, "Settled in"], [100, "Familiar face"], [250, "Regular"], [500, "Fixture"], [1_000, "Part of the furniture"]),
  },
  (f) => sql`SELECT user_id, COUNT(DISTINCT stat_date) AS value
    FROM guild_stats_user_daily WHERE messages > 0 AND user_id ${f} GROUP BY user_id`,
);

/** The longest run of consecutive UTC dates in a sorted list of YYYY-MM-DD strings. */
export function longestDailyRun(sortedDates: readonly string[]): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const date of sortedDates) {
    const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
    if (!Number.isFinite(day)) continue;
    if (previous != null && day === previous) continue;
    run = previous != null && day === previous + 1 ? run + 1 : 1;
    previous = day;
    if (run > best) best = run;
  }
  return best;
}

const longestStreak: BadgeMetric = {
  id: "longest_streak",
  label: "Longest activity streak",
  unit: "day streak",
  unitOne: "day streak",
  description: "Most days in a row they've sent a message anywhere",
  levelUp: "Send a message every day to build a longer run. Any server counts.",
  category: "activity",
  icon: "flame",
  suggestedTiers: ladder([3, "Warming up"], [7, "One week"], [14, "Fortnight"], [30, "One month"], [100, "Hundred days"], [365, "Full year"]),
  async values(_client, userIds) {
    const values = new Map<string, number>();
    if (userIds.length === 0) return values;
    const rows = getDb().all<{ user_id: string; stat_date: string }>(
      sql`SELECT DISTINCT user_id, stat_date FROM guild_stats_user_daily
        WHERE messages > 0 AND user_id IN (${userList(userIds)}) ORDER BY user_id, stat_date`,
    );
    let current: string | null = null;
    let dates: string[] = [];
    const flush = () => {
      if (current != null) values.set(current, longestDailyRun(dates));
    };
    for (const row of rows) {
      if (row.user_id !== current) {
        flush();
        current = row.user_id;
        dates = [];
      }
      dates.push(row.stat_date);
    }
    flush();
    return values;
  },
};

const serversActive = sqlMetric(
  {
    id: "servers_active",
    label: "Servers active in",
    unit: "servers",
    unitOne: "server",
    description: "Servers they've sent messages in",
    levelUp: "Chat in another server that uses Dreamliner.",
    category: "activity",
    icon: "grid",
    suggestedTiers: ladder([2, "Explorer"], [5, "Traveller"], [10, "Frequent flyer"], [25, "Globetrotter"], [50, "Everywhere at once"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM guild_message_counts WHERE count > 0 AND user_id ${f} GROUP BY user_id`,
);

const commandsRun = sqlMetric(
  {
    id: "commands_run",
    label: "Commands run",
    unit: "commands",
    unitOne: "command",
    description: "Dreamliner commands they've used since tracking began",
    levelUp: "Use any Dreamliner command in any server.",
    category: "activity",
    icon: "command",
    suggestedTiers: ladder([10, "First steps"], [100, "Handy"], [500, "Power user"], [1_000, "Operator"], [5_000, "Command centre"], [10_000, "Autopilot"]),
  },
  (f) => sql`SELECT user_id, SUM(uses) AS value FROM wrapped_command_usage WHERE user_id ${f} GROUP BY user_id`,
);

const emojiUsed = sqlMetric(
  {
    id: "emoji_used",
    label: "Emoji used",
    unit: "emoji",
    unitOne: "emoji",
    description: "Emoji in their messages and reactions since tracking began",
    levelUp: "Use emoji in messages or add reactions in any server.",
    category: "activity",
    icon: "smile",
    suggestedTiers: ladder([50, "Expressive"], [500, "Animated"], [2_500, "Emoji fluent"], [10_000, "Reaction royalty"], [25_000, "Emoji encyclopaedia"]),
  },
  (f) => sql`SELECT user_id, SUM(message_count + reaction_count) AS value FROM wrapped_emoji_usage WHERE user_id ${f} GROUP BY user_id`,
);

// --- Music -----------------------------------------------------------------------------------

const tracksPlayed = sqlMetric(
  {
    id: "tracks_played",
    label: "Tracks played",
    unit: "tracks",
    unitOne: "track",
    description: "Songs they've played with Dreamliner's music player",
    levelUp: "Play a song with /music in any server.",
    category: "fun",
    icon: "music",
    suggestedTiers: ladder([10, "Opening act"], [100, "Playlist maker"], [500, "DJ"], [1_000, "Headliner"], [5_000, "Record collector"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM music_play_log WHERE user_id ${f} GROUP BY user_id`,
);

const musicMinutes = sqlMetric(
  {
    id: "music_minutes",
    label: "Music played",
    unit: "minutes of music",
    unitOne: "minute of music",
    description: "Total length of the songs they've played",
    levelUp: "Play songs with /music in any server.",
    category: "fun",
    icon: "music",
    suggestedTiers: ladder([60, "First hour"], [600, "Long player"], [3_000, "On repeat"], [10_000, "Soundtrack"], [30_000, "Radio station"]),
  },
  (f) => sql`SELECT user_id, SUM(duration_ms) / 60000 AS value FROM music_play_log WHERE user_id ${f} GROUP BY user_id`,
);

// --- Community -------------------------------------------------------------------------------

const votes = sqlMetric(
  {
    id: "topgg_votes",
    label: "Top.gg votes",
    unit: "votes",
    unitOne: "vote",
    description: "Times they've voted for Dreamliner",
    levelUp: "Vote for Dreamliner on Top.gg. You can vote every 12 hours.",
    category: "support",
    icon: "heart",
    suggestedTiers: ladder([1, "Supporter"], [10, "Regular voter"], [50, "Champion"], [100, "Patron"], [250, "Devoted"], [500, "Pillar"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM store_votes WHERE user_id ${f} GROUP BY user_id`,
);

const creditsEarned = sqlMetric(
  {
    id: "credits_earned",
    label: "Credits earned",
    unit: "credits",
    unitOne: "credit",
    description: "Store credits they've earned by voting",
    levelUp: "Vote for Dreamliner on Top.gg to earn credits.",
    category: "support",
    icon: "coin",
    suggestedTiers: ladder([10, "Saver"], [100, "Collector"], [500, "Investor"], [1_000, "Benefactor"], [5_000, "Treasurer"]),
  },
  (f) => sql`SELECT user_id, SUM(delta) AS value FROM store_credit_ledger
    WHERE currency = 'credits' AND kind = 'vote' AND user_id ${f} GROUP BY user_id`,
);

const suggestions = sqlMetric(
  {
    id: "suggestions",
    label: "Suggestions made",
    unit: "suggestions",
    unitOne: "suggestion",
    description: "Suggestions posted in any server",
    levelUp: "Share an idea with /suggest in any server that uses suggestions.",
    category: "community",
    icon: "bulb",
    suggestedTiers: ladder([1, "Idea"], [5, "Thinker"], [25, "Visionary"], [100, "Architect"]),
  },
  (f) => sql`SELECT author_id AS user_id, COUNT(*) AS value FROM suggestions WHERE author_id ${f} GROUP BY author_id`,
);

const suggestionsImplemented = sqlMetric(
  {
    id: "suggestions_implemented",
    label: "Suggestions implemented",
    unit: "suggestions implemented",
    unitOne: "suggestion implemented",
    description: "Their suggestions that a server went on to build",
    levelUp: "Share ideas with /suggest. This grows when staff mark one as implemented.",
    category: "community",
    icon: "bulb",
    suggestedTiers: ladder([1, "Made it happen"], [3, "Trusted voice"], [10, "Shaper"], [25, "Architect"]),
  },
  (f) => sql`SELECT author_id AS user_id, COUNT(*) AS value FROM suggestions
    WHERE display_status = 'implemented' AND anonymous = 0 AND author_id ${f} GROUP BY author_id`,
);

const reviews = sqlMetric(
  {
    id: "reviews",
    label: "Reviews written",
    unit: "reviews",
    unitOne: "review",
    description: "Server reviews they've written",
    levelUp: "Write a review for a server on its Dreamliner page.",
    category: "community",
    icon: "pen",
    suggestedTiers: ladder([1, "Critic"], [5, "Reviewer"], [15, "Guide"], [50, "Authority"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM reviews WHERE deleted_at IS NULL AND user_id ${f} GROUP BY user_id`,
);

const starsReceived = sqlMetric(
  {
    id: "stars_received",
    label: "Stars received",
    unit: "stars",
    unitOne: "star",
    description: "Stars on their messages that reached a starboard",
    levelUp: "Post things people want to star. Starboard posts in any server count.",
    category: "community",
    icon: "star",
    suggestedTiers: ladder([5, "Noticed"], [25, "Crowd pleaser"], [100, "Rising star"], [500, "Star"], [1_000, "Constellation"], [5_000, "Galaxy"]),
  },
  (f) => sql`SELECT author_id AS user_id, SUM(star_count) AS value FROM starboard_posts WHERE author_id ${f} GROUP BY author_id`,
);

const membersInvited = sqlMetric(
  {
    id: "members_invited",
    label: "Members invited",
    unit: "members invited",
    unitOne: "member invited",
    description: "Genuine joins from their invites in servers that track invites",
    levelUp: "Invite friends with your own invite link. Joins flagged as fake don't count.",
    category: "community",
    icon: "user_plus",
    suggestedTiers: ladder([1, "Host"], [5, "Welcomer"], [25, "Connector"], [100, "Ambassador"], [500, "Recruiter"]),
  },
  (f) => sql`SELECT inviter_id AS user_id, COUNT(*) AS value FROM invite_joins
    WHERE status = 'valid' AND counted = 1 AND inviter_id ${f} GROUP BY inviter_id`,
);

const giveawaysEntered = sqlMetric(
  {
    id: "giveaways_entered",
    label: "Giveaways entered",
    unit: "giveaways entered",
    unitOne: "giveaway entered",
    description: "Giveaways they've joined in any server",
    levelUp: "Enter giveaways run with Dreamliner in any server.",
    category: "fun",
    icon: "gift",
    suggestedTiers: ladder([1, "Hopeful"], [10, "Regular entrant"], [50, "Optimist"], [100, "Ever hopeful"], [500, "Ticket collector"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM giveaway_entries WHERE user_id ${f} GROUP BY user_id`,
);

const giveawaysWon = sqlMetric(
  {
    id: "giveaways_won",
    label: "Giveaways won",
    unit: "giveaways won",
    unitOne: "giveaway won",
    description: "Giveaways they've been drawn as a winner of",
    levelUp: "Enter giveaways in any server. Rerolled wins don't count.",
    category: "fun",
    icon: "gift",
    suggestedTiers: ladder([1, "Lucky"], [3, "Charmed"], [10, "Fortunate"], [25, "Golden ticket"]),
  },
  (f) => sql`SELECT user_id, COUNT(DISTINCT giveaway_id) AS value FROM giveaway_winners
    WHERE status != 'rerolled' AND user_id ${f} GROUP BY user_id`,
);

const birthdays = sqlMetric(
  {
    id: "birthdays_celebrated",
    label: "Birthdays celebrated",
    unit: "birthdays",
    unitOne: "birthday",
    description: "Years a server has celebrated their birthday with Dreamliner",
    levelUp: "Set your birthday with /birthday so servers can celebrate it each year.",
    category: "community",
    icon: "cake",
    suggestedTiers: ladder([1, "Celebrated"], [2, "Another year"], [3, "Tradition"], [5, "Cherished"]),
  },
  (f) => sql`SELECT user_id, COUNT(DISTINCT year) AS value FROM birthday_celebrations WHERE user_id ${f} GROUP BY user_id`,
);

const formsSubmitted = sqlMetric(
  {
    id: "forms_submitted",
    label: "Forms submitted",
    unit: "forms",
    unitOne: "form",
    description: "Applications and form responses they've sent (anonymous ones aren't counted)",
    levelUp: "Fill in a server's application or form.",
    category: "community",
    icon: "clipboard",
    suggestedTiers: ladder([1, "Applicant"], [5, "Participant"], [25, "Contributor"], [100, "Committed"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM applications WHERE anonymous = 0 AND user_id ${f} GROUP BY user_id`,
);

const applicationsAccepted = sqlMetric(
  {
    id: "applications_accepted",
    label: "Applications accepted",
    unit: "applications accepted",
    unitOne: "application accepted",
    description: "Applications a server has accepted",
    levelUp: "Apply for roles in servers that use Dreamliner applications.",
    category: "community",
    icon: "clipboard",
    suggestedTiers: ladder([1, "Welcome aboard"], [3, "Trusted"], [10, "In demand"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM applications
    WHERE status = 'accepted' AND form_kind = 'application' AND anonymous = 0 AND user_id ${f} GROUP BY user_id`,
);

const customCommands = sqlMetric(
  {
    id: "custom_commands_built",
    label: "Custom commands built",
    unit: "custom commands",
    unitOne: "custom command",
    description: "Custom commands they've built that are still in a server",
    levelUp: "Build a custom command for a server on the dashboard.",
    category: "community",
    icon: "wand",
    suggestedTiers: ladder([1, "Tinkerer"], [5, "Builder"], [15, "Engineer"], [50, "Architect"]),
  },
  (f) => sql`SELECT created_by AS user_id, COUNT(*) AS value FROM dream_commands WHERE created_by ${f} GROUP BY created_by`,
);

const clipsCreated = sqlMetric(
  {
    id: "clips_created",
    label: "Clips created",
    unit: "clips",
    unitOne: "clip",
    description: "Voice clips they've saved with /clip",
    levelUp: "Save a moment from a voice channel with /clip.",
    category: "fun",
    icon: "film",
    suggestedTiers: ladder([1, "Rolling"], [10, "Editor"], [50, "Director"], [200, "Archivist"]),
  },
  (f) => sql`SELECT owner_id AS user_id, COUNT(*) AS value FROM voice_clips WHERE owner_id ${f} GROUP BY owner_id`,
);

// --- Quizzes ---------------------------------------------------------------------------------

const quizzesCompleted = sqlMetric(
  {
    id: "quizzes_completed",
    label: "Quizzes completed",
    unit: "quizzes",
    unitOne: "quiz",
    description: "Quizzes they've finished in any server",
    levelUp: "Finish a quiz with /quiz in any server.",
    category: "fun",
    icon: "check",
    suggestedTiers: ladder([1, "Curious"], [10, "Quizzer"], [50, "Know-it-all"], [100, "Scholar"], [250, "Professor"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM quiz_attempts WHERE status = 'completed' AND user_id ${f} GROUP BY user_id`,
);

const perfectQuizzes = sqlMetric(
  {
    id: "perfect_quizzes",
    label: "Perfect quiz scores",
    unit: "perfect scores",
    unitOne: "perfect score",
    description: "Graded quizzes they've finished with every answer right",
    levelUp: "Get every question right on a graded quiz.",
    category: "fun",
    icon: "check",
    suggestedTiers: ladder([1, "Flawless"], [5, "Sharp"], [25, "Mastermind"], [100, "Genius"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM quiz_attempts
    WHERE status = 'completed' AND max_score > 0 AND score >= max_score AND user_id ${f} GROUP BY user_id`,
);

const triviaWins = sqlMetric(
  {
    id: "trivia_wins",
    label: "Live trivia wins",
    unit: "trivia wins",
    unitOne: "trivia win",
    description: "Live trivia games they finished top of the scoreboard in",
    levelUp: "Join a live trivia game and finish with the top score. Shared first place counts.",
    category: "fun",
    icon: "trophy",
    suggestedTiers: ladder([1, "Winner"], [5, "Contender"], [25, "Champion"], [100, "Grand champion"]),
  },
  (f) => sql`SELECT p.user_id AS user_id, COUNT(*) AS value
    FROM quiz_live_players p JOIN quiz_live_games g ON g.id = p.game_id AND g.status = 'finished'
    WHERE p.score > 0 AND p.user_id ${f}
      AND p.score = (SELECT MAX(q.score) FROM quiz_live_players q WHERE q.game_id = p.game_id)
    GROUP BY p.user_id`,
);

// --- Hangar ----------------------------------------------------------------------------------

const planeCards = sqlMetric(
  {
    id: "plane_cards",
    label: "Plane cards collected",
    unit: "cards",
    unitOne: "card",
    description: "Different plane cards in their collection",
    levelUp: "Open packs and trade in the Hangar to find planes you don't have yet.",
    category: "hangar",
    icon: "card",
    suggestedTiers: ladder([10, "Spotter"], [25, "Enthusiast"], [50, "Collector"], [100, "Curator"], [200, "Museum"]),
  },
  (f) => sql`SELECT owner_id AS user_id, COUNT(DISTINCT card_type_id) AS value FROM plane_card_copies WHERE owner_id ${f} GROUP BY owner_id`,
);

const cardsOwned = sqlMetric(
  {
    id: "cards_owned",
    label: "Plane cards owned",
    unit: "cards owned",
    unitOne: "card owned",
    description: "Every plane card copy in their Hangar, duplicates included",
    levelUp: "Open packs and claim boarding passes in the Hangar.",
    category: "hangar",
    icon: "card",
    suggestedTiers: ladder([10, "Stocked"], [50, "Full apron"], [100, "Fleet"], [250, "Airline"], [500, "Alliance"]),
  },
  (f) => sql`SELECT user_id, copies_count AS value FROM plane_card_user_state WHERE user_id ${f}`,
);

const packsOpened = sqlMetric(
  {
    id: "packs_opened",
    label: "Packs opened",
    unit: "packs",
    unitOne: "pack",
    description: "Hangar packs and boarding passes they've opened",
    levelUp: "Open a pack or claim a boarding pass in the Hangar.",
    category: "hangar",
    icon: "box",
    suggestedTiers: ladder([1, "First flight"], [10, "Unboxer"], [50, "Regular"], [100, "Seasoned"], [500, "Pack rat"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM plane_card_pack_openings WHERE user_id ${f} GROUP BY user_id`,
);

const tradesCompleted = sqlMetric(
  {
    id: "trades_completed",
    label: "Trades completed",
    unit: "trades",
    unitOne: "trade",
    description: "Hangar trades they've made with other pilots",
    levelUp: "Trade cards with another pilot in the Hangar.",
    category: "hangar",
    icon: "swap",
    suggestedTiers: ladder([1, "Dealer"], [10, "Trader"], [50, "Broker"], [100, "Market maker"]),
  },
  (f) => sql`SELECT from_user_id AS user_id, COUNT(*) AS value FROM plane_card_trades WHERE status = 'accepted' AND from_user_id ${f} GROUP BY from_user_id
    UNION ALL
    SELECT to_user_id AS user_id, COUNT(*) AS value FROM plane_card_trades WHERE status = 'accepted' AND to_user_id ${f} GROUP BY to_user_id`,
);

const fleetValue = sqlMetric(
  {
    id: "fleet_value",
    label: "Fleet Value",
    unit: "Fleet Value",
    unitOne: "Fleet Value",
    description: "Their Hangar collection score",
    levelUp: "Collect rarer cards and complete sets in the Hangar.",
    category: "hangar",
    icon: "plane",
    suggestedTiers: ladder([100, "Cadet"], [1_000, "First officer"], [5_000, "Captain"], [25_000, "Senior captain"], [100_000, "Fleet commander"]),
  },
  (f) => sql`SELECT user_id, fleet_value AS value FROM plane_card_user_state WHERE user_id ${f}`,
);

const setsCompleted = sqlMetric(
  {
    id: "sets_completed",
    label: "Card sets completed",
    unit: "sets",
    unitOne: "set",
    description: "Hangar sets they currently have complete",
    levelUp: "Collect every card in a Hangar set.",
    category: "hangar",
    icon: "layers",
    suggestedTiers: ladder([1, "Completionist"], [3, "Set builder"], [5, "Archivist"], [10, "Full house"]),
  },
  (f) => sql`SELECT user_id, sets_completed AS value FROM plane_card_user_state WHERE user_id ${f}`,
);

const flightsFlown = sqlMetric(
  {
    id: "flights_flown",
    label: "Flights flown",
    unit: "flights",
    unitOne: "flight",
    description: "Hangar flights they've completed",
    levelUp: "Send a plane on a flight in the Hangar and claim it when it lands.",
    category: "hangar",
    icon: "plane",
    suggestedTiers: ladder([1, "Take-off"], [10, "Cruising"], [50, "Long haul"], [100, "Frequent flyer"], [500, "Million miler"]),
  },
  (f) => sql`SELECT user_id, COUNT(*) AS value FROM plane_card_flights WHERE claimed_at IS NOT NULL AND user_id ${f} GROUP BY user_id`,
);

const mythicsOwned = sqlMetric(
  {
    id: "mythics_owned",
    label: "Mythic cards owned",
    unit: "Mythic cards",
    unitOne: "Mythic card",
    description: "Mythic plane cards in their collection",
    levelUp: "Open packs in the Hangar. Mythic cards are the rarest pulls.",
    category: "hangar",
    icon: "gem",
    suggestedTiers: ladder([1, "Mythic"], [3, "Rare air"], [5, "Legendary hangar"], [10, "Myth maker"]),
  },
  (f) => sql`SELECT user_id, mythics_owned AS value FROM plane_card_user_state WHERE user_id ${f}`,
);

// --- Account ---------------------------------------------------------------------------------

const dailyStreak = sqlMetric(
  {
    id: "daily_streak",
    label: "Daily streak",
    unit: "day streak",
    unitOne: "day streak",
    description: "Their current economy /daily streak",
    levelUp: "Claim /daily every day. Missing a day starts the streak again.",
    category: "account",
    icon: "flame",
    suggestedTiers: ladder([7, "One week"], [30, "One month"], [100, "Hundred days"], [365, "Full year"]),
  },
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
  unitOne: "day on Discord",
  description: "Days since their Discord account was created",
  levelUp: "This grows by itself, one day at a time.",
  category: "account",
  icon: "clock",
  suggestedTiers: ladder([365, "One year"], [730, "Two years"], [1_825, "Five years"], [3_650, "Ten years"]),
  async values(_client, userIds) {
    const values = new Map<string, number>();
    for (const userId of userIds) {
      const createdAt = snowflakeCreatedAt(userId);
      if (createdAt != null) values.set(userId, Math.max(0, Math.floor((Date.now() - createdAt) / 86_400_000)));
    }
    return values;
  },
};

/** Whole days from a YYYY-MM-DD date to now. */
export function daysSinceDate(date: string, now = Date.now()): number {
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 86_400_000)) : 0;
}

const dreamlinerDays: BadgeMetric = {
  id: "dreamliner_days",
  label: "Time with Dreamliner",
  unit: "days with Dreamliner",
  unitOne: "day with Dreamliner",
  description: "Days since Dreamliner first saw them chat or join voice",
  levelUp: "This grows by itself from the first day Dreamliner saw you.",
  category: "account",
  icon: "clock",
  suggestedTiers: ladder([30, "New arrival"], [180, "Six months"], [365, "One year"], [730, "Two years"], [1_095, "Three years"]),
  async values(_client, userIds) {
    const values = new Map<string, number>();
    if (userIds.length === 0) return values;
    const list = userList(userIds);
    const rows = getDb().all<{ user_id: string; first: string | null }>(
      sql`SELECT user_id, MIN(first) AS first FROM (
        SELECT user_id, MIN(stat_date) AS first FROM guild_stats_user_daily WHERE user_id IN (${list}) GROUP BY user_id
        UNION ALL
        SELECT user_id, MIN(stat_date) AS first FROM guild_stats_user_voice_daily WHERE user_id IN (${list}) GROUP BY user_id
      ) GROUP BY user_id`,
    );
    for (const row of rows) if (row.first) values.set(String(row.user_id), daysSinceDate(row.first));
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
  unitOne: "One server",
  description: "Servers they own with active Dreamliner One",
  levelUp: "Subscribe a server you own to Dreamliner One.",
  category: "support",
  icon: "bolt",
  suggestedTiers: ladder([1, "Subscriber"], [2, "Network"], [5, "Fleet owner"]),
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
  unitOne: "",
  description: "Not earned automatically; assign each tier by hand",
  levelUp: "The Dreamliner team awards this one.",
  category: "other",
  icon: "sparkle",
  suggestedTiers: [],
  async values() {
    return new Map();
  },
};

export const METRICS: BadgeMetric[] = [
  messages,
  voiceMinutes,
  voiceHours,
  activeDays,
  longestStreak,
  serversActive,
  commandsRun,
  emojiUsed,
  suggestions,
  suggestionsImplemented,
  reviews,
  starsReceived,
  membersInvited,
  birthdays,
  formsSubmitted,
  applicationsAccepted,
  customCommands,
  tracksPlayed,
  musicMinutes,
  giveawaysEntered,
  giveawaysWon,
  clipsCreated,
  quizzesCompleted,
  perfectQuizzes,
  triviaWins,
  planeCards,
  cardsOwned,
  packsOpened,
  tradesCompleted,
  fleetValue,
  setsCompleted,
  flightsFlown,
  mythicsOwned,
  votes,
  creditsEarned,
  oneServers,
  dailyStreak,
  accountAge,
  dreamlinerDays,
  manual,
];

export function getMetric(id: string): BadgeMetric | null {
  return METRICS.find((metric) => metric.id === id) ?? null;
}

// --- Caching ---------------------------------------------------------------------------------

/** Per-user values are cached briefly: leaderboards and profiles resolve the same users over and
 *  over, and a stat moving a few seconds late is fine for a badge. */
const VALUE_TTL_MS = 60_000;
const MAX_CACHED_VALUES = 50_000;
const valueCache = new Map<string, { at: number; value: number }>();

export async function cachedMetricValues(metric: BadgeMetric, client: Client, userIds: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const result = new Map<string, number>();
  const missing: string[] = [];
  for (const userId of userIds) {
    const hit = valueCache.get(`${metric.id}:${userId}`);
    if (hit && now - hit.at < VALUE_TTL_MS) result.set(userId, hit.value);
    else missing.push(userId);
  }
  if (missing.length > 0) {
    const fresh = await metric.values(client, missing);
    for (const userId of missing) {
      const value = fresh.get(userId) ?? 0;
      result.set(userId, value);
      valueCache.set(`${metric.id}:${userId}`, { at: now, value });
    }
    if (valueCache.size > MAX_CACHED_VALUES) {
      for (const [key, entry] of valueCache) {
        if (now - entry.at >= VALUE_TTL_MS || valueCache.size > MAX_CACHED_VALUES) valueCache.delete(key);
        if (valueCache.size <= MAX_CACHED_VALUES * 0.8) break;
      }
    }
  }
  return result;
}

/** Test hook. */
export function clearMetricValueCache(): void {
  valueCache.clear();
}

const TRACKED_TTL_MS = 10 * 60_000;
let trackedCache: { at: number; count: number } | null = null;

/** Everyone Dreamliner has seen send a message: the denominator for a tier's rarity. */
export function countTrackedUsers(): number {
  if (trackedCache && Date.now() - trackedCache.at < TRACKED_TTL_MS) return trackedCache.count;
  const row = getDb().get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM user_message_counts WHERE count > 0`);
  trackedCache = { at: Date.now(), count: Number(row?.n ?? 0) };
  return trackedCache.count;
}
