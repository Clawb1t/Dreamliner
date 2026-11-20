/**
 * Every place one person can see another person's activity, and how it is protected. The test
 * next to this file checks that each "gated" surface really goes through the cross-server gate,
 * that each "same-server" surface reads only its own server's data, and that no other
 * viewer-facing file reads the global per-user tables directly. Adding a surface: list it here.
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
   * platform: Dreamliner staff abuse tooling, intentionally ungated (documented in ghostMode.ts).
   */
  kind: "gated" | "same-server" | "own" | "platform";
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
  { name: "Global leaderboards, global stats page, all leaderboard badge rows, dashboard member stats", file: "bridge/webStats.ts", kind: "gated" },
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
