/**
 * The public leaderboards' builders (global and per-server), plus the shared row resolution used
 * by the stats pages' top lists. Cached, persisted and served by leaderboardCache.ts.
 *
 * Every board is ranked from the database with headroom (CANDIDATE_FACTOR x the rows stored), then
 * walked in rank order resolving identities (identityStore.ts) until it has STORED_ROWS rows:
 * - users without a resolvable identity (deleted, unknown, unreachable) are left out and the rest
 *   renumbered, so no row ever shows a bare user ID;
 * - users in Ghost Mode (or hidden from leaderboards) are left out too, and again on every
 *   response (presentBoard), since Ghost Mode can switch on after a build.
 * Totals and "ranked" counts describe the underlying data, not just the shown rows: someone left
 * out because their account is gone still counted toward the server's messages. (Global boards do
 * subtract Ghost Mode users from their totals, so a near-empty board can't give their numbers away.)
 *
 * Global boards are live (the most recent build): the once-a-day freeze is gone. Profiles and the
 * other cross-server surfaces keep their own rules (core/privacy).
 */
import type { Client, Guild } from "discord.js";
import { leaderboardCosmetics, type LeaderboardCosmetics } from "../core/cosmetics/types.js";
import { formatSharePct, sharePctValue } from "../plugins/stats/functions/analysis.js";
import { getGlobalActiveMessagerCount, getGlobalTrackedMessagesTotal, getTopGlobalMessagers } from "../plugins/stats/functions/globalQueries.js";
import { getActiveMessagerCount, getTopMessagers, getTrackedMessagesTotal } from "../plugins/stats/functions/queries.js";
import { getActiveVoiceUserCount, getGlobalVoiceTotals, getGuildTotalVoiceMinutes, getTopGlobalVoiceUsers, getTopVoiceUsers } from "../plugins/stats/functions/voice.js";
import { crossServerAccessForMany, listHiddenFromLeaderboards } from "../core/privacy/ghostMode.js";
import { filterBadgesForAccess } from "../core/privacy/policy.js";
import { getLogger } from "../core/logger.js";
import { resolveIdentities, shownIdentity, type IdentityClient, type StoredIdentity } from "./identityStore.js";
import { BOARD_ROWS, BOARD_SPARE_ROWS, type BoardBuilder, type GlobalBoardId, type GuildBoardId } from "./leaderboardCache.js";

const log = getLogger("leaderboards");

/** Rows stored per board: what the site shows plus spares for serve-time Ghost Mode removals. */
export const STORED_ROWS = BOARD_ROWS + BOARD_SPARE_ROWS;
/** Ranked rows fetched per board, so unresolvable users can be skipped and the board still filled. */
const CANDIDATE_FACTOR = 3;
const CANDIDATE_ROWS = STORED_ROWS * CANDIDATE_FACTOR;
/** A background build gives up waiting on identity lookups after this (incomplete: previous copy stays). */
const BUILD_DEADLINE_MS = 45_000;

export type Candidate = { userId: string; count: number; seconds?: number };
type Picked = Candidate & { identity: StoredIdentity };
type Mode = { fetch: boolean; deadline?: number };

// --- Picking rows --------------------------------------------------------------------------------

/**
 * Walks `candidates` in rank order and keeps the first `target` with a resolved identity. Batches
 * are sized to what's still missing, so a board normally resolves only about as many users as it
 * shows. `complete` is false when some user above the cut had no answer yet (as opposed to a
 * definitive "gone"), so the caller knows not to replace a good copy with this one.
 */
export async function pickResolved(
  client: IdentityClient,
  candidates: readonly Candidate[],
  target: number,
  mode: Mode,
  hidden: ReadonlySet<string> = listHiddenFromLeaderboards(),
): Promise<{ picked: Picked[]; complete: boolean }> {
  const eligible = candidates.filter((row) => !hidden.has(row.userId));
  const picked: Picked[] = [];
  let complete = true;
  let cursor = 0;
  while (picked.length < target && cursor < eligible.length) {
    const need = target - picked.length;
    const batch = eligible.slice(cursor, cursor + Math.ceil(need * 1.25) + 2);
    cursor += batch.length;
    const lookup = await resolveIdentities(client, batch.map((row) => row.userId), mode);
    for (const row of batch) {
      if (picked.length >= target) break;
      const identity = lookup.found.get(row.userId);
      if (identity && shownIdentity(identity)) picked.push({ ...row, identity });
      else if (!lookup.gone.has(row.userId) && !identity) complete = false;
    }
  }
  return { picked, complete };
}

// --- Rendering rows ------------------------------------------------------------------------------

async function leaderboardCosmeticsFor(userIds: string[]): Promise<Map<string, LeaderboardCosmetics | null>> {
  const out = new Map<string, LeaderboardCosmetics | null>();
  try {
    const { getEquippedCosmeticsForUsers } = await import("../core/cosmetics/equip.js");
    for (const [userId, style] of getEquippedCosmeticsForUsers(userIds)) out.set(userId, leaderboardCosmetics(style));
  } catch (error) {
    log.debug(`leaderboard cosmetics lookup failed: ${error instanceof Error ? error.message : error}`);
  }
  return out;
}

/** Server nicknames, remembered for a while so rebuilds don't re-request them. */
const nicknameMemo = new Map<string, { name: string | null; until: number }>();
const NICKNAME_TTL_MS = 15 * 60_000;

/**
 * Display names for `userIds` in `guild`: the gateway cache, then (full builds only) one gateway
 * member request for the rest. That's a single request per board, not one per row, and members who
 * left are remembered so they aren't asked about again on every rebuild.
 */
async function guildDisplayNames(guild: Guild, userIds: string[], fetch: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const unknown: string[] = [];
  for (const id of userIds) {
    const member = guild.members.cache.get(id);
    if (member) {
      out.set(id, member.displayName);
      continue;
    }
    const memo = nicknameMemo.get(`${guild.id}:${id}`);
    if (memo && memo.until > now) {
      if (memo.name) out.set(id, memo.name);
      continue;
    }
    unknown.push(id);
  }
  if (fetch && unknown.length > 0) {
    try {
      const found = await guild.members.fetch({ user: unknown.slice(0, 100), time: 10_000 });
      for (const id of unknown) {
        const member = found.get(id);
        nicknameMemo.set(`${guild.id}:${id}`, { name: member?.displayName ?? null, until: now + NICKNAME_TTL_MS });
        if (member) out.set(id, member.displayName);
      }
    } catch (error) {
      log.debug(`member lookup for ${guild.id} failed: ${error instanceof Error ? error.message : error}`);
    }
    if (nicknameMemo.size > 20_000) {
      for (const [key, value] of nicknameMemo) if (value.until <= now) nicknameMemo.delete(key);
    }
  }
  return out;
}

/** Leaderboard rows for picked users, in order, ranked 1..n. */
export async function renderRows(
  client: Client,
  picked: readonly Picked[],
  trafficTotal: number,
  options: { includeAccents?: boolean; displayNames?: Map<string, string> } = {},
) {
  const userIds = picked.map((row) => row.userId);
  const { getAccentColorsForUsers } = await import("./userProfiles.js");
  const { getDisplayedBadgesForUsers } = await import("./userBadges.js");
  const { getProgressionBadgesForUsers } = await import("../core/progressionBadges/index.js");
  const [cosmetics, accents, badgesByUser, progressionByUser] = await Promise.all([
    leaderboardCosmeticsFor(userIds),
    options.includeAccents === false ? Promise.resolve(new Map<string, string>()) : getAccentColorsForUsers(userIds),
    getDisplayedBadgesForUsers(userIds),
    getProgressionBadgesForUsers(client, userIds).catch(() => new Map()),
  ]);
  const access = crossServerAccessForMany(userIds);
  return picked.map((row, index) => {
    const shown = shownIdentity(row.identity, options.displayNames?.get(row.userId))!;
    return {
      rank: index + 1,
      id: row.userId,
      name: shown.name,
      username: shown.username,
      avatar: shown.avatar,
      bannerUrl: shown.bannerUrl,
      count: row.count,
      // Exact seconds on voice rows (null elsewhere), for a precise "Xh Ym".
      seconds: row.seconds ?? null,
      sharePct: sharePctValue(row.count, trafficTotal),
      shareLabel: formatSharePct(row.count, trafficTotal),
      accentColor: accents.get(row.userId) ?? null,
      badges: badgesByUser.get(row.userId) ?? [],
      // Badge tiers stay, their live cross-server progress numbers don't (policy.ts).
      progressionBadges: filterBadgesForAccess(progressionByUser.get(row.userId) ?? [], access.get(row.userId) ?? "snapshot"),
      cosmetics: cosmetics.get(row.userId) ?? null,
    };
  });
}

/**
 * The stats pages' top lists (dashboard and /stats): same identity and Ghost Mode rules as the
 * boards, resolved inline with a short wait (`waitMs`), since those payloads aren't kept like the
 * boards. Users still being looked up are left out of this answer and ready for the next one.
 */
export async function resolveTopPeople(
  client: Client,
  entries: readonly Candidate[],
  trafficTotal: number,
  options: { limit: number; guild?: Guild; includeAccents?: boolean; waitMs?: number },
) {
  const { picked } = await pickResolved(client, entries, options.limit, { fetch: true, deadline: Date.now() + (options.waitMs ?? 2500) });
  const displayNames = options.guild ? await guildDisplayNames(options.guild, picked.map((row) => row.userId), false) : undefined;
  return renderRows(client, picked, trafficTotal, { includeAccents: options.includeAccents, displayNames });
}

// --- Plans ---------------------------------------------------------------------------------------

type Ranked<T> = {
  candidates: Candidate[];
  render: (picked: Picked[], mode: Mode) => Promise<T>;
};

/** Ranks once, then resolves either fully (background) or from known identities only (cold start). */
function plan<T>(client: IdentityClient, rank: () => Promise<Ranked<T>>): BoardBuilder<T> {
  return async () => {
    const ranked = await rank();
    const hidden = listHiddenFromLeaderboards();
    const run = async (mode: Mode) => {
      const { picked, complete } = await pickResolved(client, ranked.candidates, STORED_ROWS, mode, hidden);
      return { payload: await ranked.render(picked, mode), complete };
    };
    return {
      full: () => run({ fetch: true, deadline: Date.now() + BUILD_DEADLINE_MS }),
      quick: () => run({ fetch: false }),
    };
  };
}

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

/** Sum of `count` over hidden users among `rows` (global totals leave Ghost Mode users out). */
function hiddenShare(rows: readonly Candidate[], hidden: ReadonlySet<string>) {
  const among = rows.filter((row) => hidden.has(row.userId));
  return { sum: among.reduce((total, row) => total + row.count, 0), count: among.length };
}

// --- Global boards -------------------------------------------------------------------------------

export function globalBoardBuilder(client: Client, board: GlobalBoardId): BoardBuilder<unknown> {
  return plan<unknown>(client, async (): Promise<Ranked<unknown>> => {
    const hidden = listHiddenFromLeaderboards();
    if (board === "messages") {
      const [top, total, activeMessagers] = await Promise.all([
        getTopGlobalMessagers(CANDIDATE_ROWS),
        getGlobalTrackedMessagesTotal(),
        getGlobalActiveMessagerCount(),
      ]);
      const candidates = top.filter((row) => row.count > 0);
      return {
        candidates,
        render: async (picked) => ({
          scope: "global" as const,
          guild: { id: "global", name: "Dreamliner", icon: null as string | null, memberCount: client.guilds.cache.size },
          title: "Top messagers",
          subtitle: "Global all-time message leaderboard",
          windowLabel: "All time · all servers",
          totalMessages: total,
          activeMessagers: Math.max(0, activeMessagers - hidden.size),
          leaders: await renderRows(client, picked, total),
        }),
      };
    }

    let candidates: Candidate[] = [];
    let shareBase = 0;
    let total = 0;
    let ranked = 0;
    if (board === "voice") {
      const [top, totals] = await Promise.all([getTopGlobalVoiceUsers(CANDIDATE_ROWS), getGlobalVoiceTotals()]);
      candidates = top.map((row) => ({ userId: row.userId, count: row.minutes, seconds: row.seconds }));
      const gone = hiddenShare(candidates, hidden);
      shareBase = total = Math.max(0, totals.minutes - gone.sum);
      ranked = Math.max(0, totals.users - gone.count);
    } else if (board === "streaks") {
      const { topLiveGlobalDailyStreaks } = await import("../plugins/economy/functions/money.js");
      candidates = topLiveGlobalDailyStreaks(100).map((row) => ({ userId: row.userId, count: row.streak }));
      const visible = candidates.filter((row) => !hidden.has(row.userId));
      // Streaks don't add up to a meaningful whole: each row's ring is against the leader's.
      shareBase = total = visible[0]?.count ?? 0;
      ranked = visible.length;
    } else {
      const { leaderboard, globalFleetTotals } = await import("../plugins/economy/hangar/leaderboards.js");
      candidates = leaderboard("fleet_value", { limit: CANDIDATE_ROWS }).map((row) => ({ userId: row.userId, count: row.value }));
      const totals = globalFleetTotals();
      const gone = hiddenShare(candidates, hidden);
      shareBase = total = Math.max(0, totals.total - gone.sum);
      ranked = Math.max(0, totals.players - gone.count);
    }
    return {
      candidates,
      render: async (picked) => ({
        scope: "global" as const,
        board,
        total,
        ranked,
        leaders: await renderRows(client, picked, shareBase),
      }),
    };
  });
}

// --- Server boards -------------------------------------------------------------------------------

export function guildBoardBuilder(guild: Guild, board: GuildBoardId): BoardBuilder<unknown> {
  const client = guild.client;
  return plan<unknown>(client, async (): Promise<Ranked<unknown>> => {
    const { configManager } = await import("../config/manager.js");
    const { getDreamlinerOnePublicStatusWithRefresh } = await import("./dreamlinerOne.js");
    const [guildConfig, oneStatus] = await Promise.all([
      configManager.getEffectiveConfig(guild.id),
      getDreamlinerOnePublicStatusWithRefresh(guild.id),
    ]);
    const overrideUserAccents = Boolean(guildConfig.leaderboard_override_user_accents);
    const common = {
      scope: "server" as const,
      guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
      theme: { accentColor: colorIntToHex(guildConfig.server_accent_color), overrideUserAccents },
      oneActive: oneStatus.active,
      oneActiveSince: oneStatus.since,
    };
    const rows = async (picked: Picked[], mode: Mode, shareBase: number) =>
      renderRows(client, picked, shareBase, {
        includeAccents: !overrideUserAccents,
        displayNames: await guildDisplayNames(guild, picked.map((row) => row.userId), mode.fetch),
      });

    if (board === "messages") {
      const [top, total, activeMessagers] = await Promise.all([
        getTopMessagers(guild.id, CANDIDATE_ROWS),
        getTrackedMessagesTotal(guild.id, 0),
        getActiveMessagerCount(guild.id),
      ]);
      return {
        candidates: top,
        render: async (picked, mode) => ({
          ...common,
          title: "Top messagers",
          subtitle: "All-time message leaderboard",
          windowLabel: "All time",
          totalMessages: total,
          activeMessagers,
          leaders: await rows(picked, mode, total),
        }),
      };
    }
    if (board === "voice") {
      const [top, totalVoiceMinutes, activeVoiceMembers] = await Promise.all([
        getTopVoiceUsers(guild.id, 0, CANDIDATE_ROWS),
        getGuildTotalVoiceMinutes(guild.id),
        getActiveVoiceUserCount(guild.id),
      ]);
      return {
        candidates: top.map((row) => ({ userId: row.userId, count: row.minutes, seconds: row.seconds })),
        render: async (picked, mode) => ({
          ...common,
          title: "Top voice members",
          subtitle: "All-time voice leaderboard",
          windowLabel: "All time",
          totalVoiceMinutes,
          activeVoiceMembers,
          leaders: await rows(picked, mode, totalVoiceMinutes),
        }),
      };
    }

    // Streaks and Fleet Value belong to the economy plugin: with it off the board is unavailable.
    const { pluginEnabled } = await import("../core/pluginCommand.js");
    const available = pluginEnabled(guildConfig, "economy");
    let candidates: Candidate[] = [];
    let shareBase = 0;
    let total = 0;
    let ranked = 0;
    let pilotRanks: Map<string, { key: string; label: string; color: string }> | null = null;
    if (available && board === "streaks") {
      const { topLiveServerDailyStreaks } = await import("../plugins/economy/functions/money.js");
      const { rows: top, live } = topLiveServerDailyStreaks(guild.id, 100);
      candidates = top.map((row) => ({ userId: row.userId, count: row.streak }));
      shareBase = total = top[0]?.streak ?? 0;
      ranked = live;
    } else if (available && board === "fleet") {
      const { hangarMembersOf } = await import("../plugins/economy/hangar/guildMembers.js");
      const { leaderboard, globalFleetTotals } = await import("../plugins/economy/hangar/leaderboards.js");
      const { pilotRankView } = await import("../plugins/economy/hangar/score.js");
      const memberIds = await hangarMembersOf(guild);
      const top = leaderboard("fleet_value", { limit: CANDIDATE_ROWS, memberIds });
      const totals = globalFleetTotals(memberIds);
      candidates = top.map((row) => ({ userId: row.userId, count: row.value }));
      shareBase = total = totals.total;
      ranked = totals.players;
      pilotRanks = new Map(
        top.map((row) => {
          const rank = pilotRankView(row.value);
          return [row.userId, { key: rank.key, label: rank.label, color: rank.color }];
        }),
      );
    }
    return {
      candidates,
      render: async (picked, mode) => {
        const people = await rows(picked, mode, shareBase);
        return {
          ...common,
          board,
          available,
          total,
          ranked,
          leaders: pilotRanks ? people.map((row) => ({ ...row, pilotRank: pilotRanks.get(row.id) ?? null })) : people,
        };
      },
    };
  });
}

/** Tests only. */
export function resetNicknameMemo(): void {
  nicknameMemo.clear();
}
