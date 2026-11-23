/**
 * Every place one person can see another person's activity, and how it is protected. The test
 * next to this file checks that each "gated" surface really goes through the cross-server gate,
 * that each "same-server" surface reads only its own server's data, that each "leaderboard"
 * surface leaves Ghost Mode users out, and that no other viewer-facing file reads the global
 * per-user tables directly. Adding a surface: list it here.
 *
 * Leaderboards (any ranked list of people others can see, global or per-server, website or
 * Discord) show the most recent numbers, with no once-a-day freeze, and never list anyone in Ghost
 * Mode or hidden from leaderboards: that filter runs on every response, cached copies included
 * (listHiddenFromLeaderboards / presentBoard). A user's own rank card is unaffected.
 */
export type ProtectedSurface = {
  name: string;
  /** Source file, relative to src/. */
  file: string;
  /**
   * gated: shows activity from outside the current server; must call the gate (or a crossServer.ts
   *   reader built on it).
   * same-server: shows only the current server's own data, which stays live (normal leaderboard
   *   behaviour); must not touch the global tables.
   * own: only ever the signed-in user's own data.
   * leaderboard: a ranked list of people shown to others (same-server or global); must leave out
   *   Ghost Mode users via listHiddenFromLeaderboards (or presentBoard/pickResolved built on it).
   * platform: Dreamliner staff abuse tooling, intentionally ungated (documented in ghostMode.ts).
   */
  kind: "gated" | "same-server" | "leaderboard" | "own" | "platform";
};

export const PROTECTED_SURFACES: ProtectedSurface[] = [
  { name: "/rank scope:Global", file: "plugins/stats/functions/rank.ts", kind: "gated" },
  { name: "/profile card", file: "plugins/stats/functions/profileCard.ts", kind: "gated" },
  { name: "/stats user (All servers line)", file: "plugins/stats/functions/ui/buildPayload.ts", kind: "gated" },
  { name: "/info user (Messages global)", file: "plugins/utility/functions/info.ts", kind: "gated" },
  { name: "/balance currency:Global", file: "plugins/economy/commands.ts", kind: "gated" },
  { name: "/planes hangar, rank, sets, leaderboard", file: "plugins/economy/hangar/discord/commands.ts", kind: "gated" },
  { name: "Profile page (identity, stats, activity, hours, servers, cards, JSON API)", file: "bridge/userPublicProfile.ts", kind: "gated" },
  { name: "As seen in these servers", file: "bridge/userActivity.ts", kind: "gated" },
  { name: "Global stats page, dashboard member stats", file: "bridge/webStats.ts", kind: "gated" },
  { name: "Public leaderboards (global and per-server boards) and stats-page top lists", file: "bridge/leaderboards.ts", kind: "gated" },
  { name: "Public leaderboards (global and per-server boards) and stats-page top lists", file: "bridge/leaderboards.ts", kind: "leaderboard" },
  { name: "Leaderboard cache (serve-time Ghost Mode filter)", file: "bridge/leaderboardCache.ts", kind: "leaderboard" },
  { name: "/stats leaderboard images", file: "plugins/stats/functions/leaderboard.ts", kind: "leaderboard" },
  { name: "/stats top messagers lists", file: "plugins/stats/functions/ui/buildPayload.ts", kind: "leaderboard" },
  { name: "/rewards top", file: "plugins/activity_rewards/commands.ts", kind: "leaderboard" },
  { name: "/planes leaderboard", file: "plugins/economy/hangar/discord/commands.ts", kind: "leaderboard" },
  { name: "Hangar leaderboards (dashboard)", file: "bridge/webHangar.ts", kind: "leaderboard" },
  { name: "/locate", file: "plugins/locate_user/commands/locate.ts", kind: "same-server" },
  { name: "/seen", file: "plugins/locate_user/functions/lastSeen.ts", kind: "same-server" },
  { name: "Member 360", file: "bridge/webMemberHub.ts", kind: "same-server" },
  { name: "/names (name history)", file: "plugins/name_history/commands/names.ts", kind: "same-server" },
  { name: "Account stats (User Settings)", file: "bridge/userStats.ts", kind: "own" },
  { name: "Data export", file: "bridge/userDataExport.ts", kind: "own" },
  { name: "Dashboard economy member lookup (server staff)", file: "bridge/webEconomy.ts", kind: "gated" },
  { name: "Global Watchdog", file: "bridge/watchdogScoring.ts", kind: "platform" },
];

/** Tables holding one user's activity summed across every server. */
export const GLOBAL_ACTIVITY_TABLES = ["userMessageCounts", "userHourlyActivity", "economyGlobalAccounts"] as const;

/**
 * Files allowed to import those tables without being a listed surface: the gate itself, writers
 * (tracking), the economy/Hangar internals that maintain balances, erase/export, and benchmarks.
 */
export const GLOBAL_TABLE_INTERNALS = [
  "core/privacy/crossServer.ts",
  "db/schema.ts",
  "plugins/utility/functions/messageCounts.ts",
  "plugins/stats/functions/daily.ts",
  "plugins/stats/functions/globalQueries.ts",
  "plugins/economy/functions/money.ts",
  "plugins/economy/hangar/ledger.ts",
  "bridge/userProfiles.ts",
];
