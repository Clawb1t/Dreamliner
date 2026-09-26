/**
 * Switch (moving from another bot): which of the supported bots are in the server, their current
 * avatars for the dashboard, and carrying MEE6 Levels over into Activity Rewards.
 *
 * MEE6 levels come from MEE6's public leaderboard endpoint (undocumented, needs "public
 * leaderboard" on in MEE6). Dreamliner has no XP, so XP becomes message progress: MEE6 gives
 * 15-25 XP per counted message, so a member's XP / 20 is roughly how many counted messages they
 * sent, and each MEE6 level role becomes a message milestone at that level's XP / 20.
 */
import type { Client, Guild } from "discord.js";
import { SWITCH_SOURCES, type SwitchSource } from "../core/ai/switch.js";
import { seedMessageProgress } from "../plugins/activity_rewards/functions/store.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("bridge");

export type SwitchBotInfo = { id: string; name: string; avatarUrl: string | null; present: boolean };

async function botInfo(client: Client, source: SwitchSource, guild: Guild | null): Promise<SwitchBotInfo> {
  const { botId, name } = SWITCH_SOURCES[source];
  const member = guild ? await guild.members.fetch(botId).catch(() => null) : null;
  const user = member?.user ?? (await client.users.fetch(botId).catch(() => null));
  return {
    id: botId,
    name,
    // Null when Discord can't be asked; the website falls back to its own copy of the avatar.
    avatarUrl: user?.displayAvatarURL({ size: 256, extension: "png" }) ?? null,
    present: Boolean(member),
  };
}

/** Every Switch bot's live avatar (public, for the /switch page) and, with a guild, whether it's a member. */
export async function getSwitchBots(client: Client, guild: Guild | null): Promise<Record<string, SwitchBotInfo>> {
  const sources = Object.keys(SWITCH_SOURCES) as SwitchSource[];
  const infos = await Promise.all(sources.map((source) => botInfo(client, source, guild)));
  return Object.fromEntries(sources.map((source, i) => [source, infos[i]!]));
}

// ---------------------------------------------------------------------------------------------
// MEE6 levels
// ---------------------------------------------------------------------------------------------

const LEADERBOARD = "https://mee6.xyz/api/plugins/levels/leaderboard";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 1_200;
/** MEE6 is known to IP-ban heavy leaderboard scraping, so one full import per server per hour. */
const IMPORT_COOLDOWN_MS = 60 * 60_000;
const AVG_XP_PER_MESSAGE = 20;

type Mee6Player = { id: string; xp: number; level: number; message_count?: number };
type Mee6RoleReward = { rank: number; role: { id: string; name: string } };
type Mee6Page = { players?: Mee6Player[]; role_rewards?: Mee6RoleReward[]; xp_rate?: number };

class Mee6Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchMee6Page(guildId: string, page: number): Promise<Mee6Page> {
  const res = await fetch(`${LEADERBOARD}/${guildId}?page=${page}&limit=${PAGE_SIZE}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; DreamlinerBot/1.0; +https://www.dreamliner.site)" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw new Mee6Error("Couldn't reach MEE6. Try again in a minute.", 502);
  if (res.status === 401 || res.status === 403) {
    throw new Mee6Error(
      "Your MEE6 leaderboard is private. In the MEE6 dashboard open Levels and turn on \"Make my server's leaderboard public\", then try again.",
      422,
    );
  }
  if (res.status === 404) throw new Mee6Error("MEE6 has no Levels data for this server.", 404);
  if (res.status === 429) throw new Mee6Error("MEE6 is rate limiting us. Try again in a few minutes.", 429);
  if (!res.ok) throw new Mee6Error(`MEE6 returned an error (${res.status}). Try again later.`, 502);
  return (await res.json()) as Mee6Page;
}

/** Total XP needed to reach `level` on MEE6's curve (each level L costs 5L^2 + 50L + 100). */
export function mee6XpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l += 1) total += 5 * l * l + 50 * l + 100;
  return total;
}

export function mee6XpToMessages(xp: number): number {
  return Math.max(0, Math.round(xp / AVG_XP_PER_MESSAGE));
}

export type Mee6LevelReward = {
  level: number;
  messages: number;
  roleId: string;
  roleName: string;
  roleExists: boolean;
};

export type Mee6LevelsPreview = {
  rewards: Mee6LevelReward[];
  /** Members on the first page (up to 1000); `morePages` says the leaderboard goes further. */
  firstPageMembers: number;
  morePages: boolean;
  xpRate: number;
  topLevel: number;
};

export type Mee6ImportJob = {
  state: "running" | "done" | "error";
  membersFetched: number;
  membersImported: number;
  error: string | null;
  startedAt: number;
};

function mapRewards(guild: Guild, page: Mee6Page): Mee6LevelReward[] {
  return (page.role_rewards ?? [])
    .filter((reward) => reward?.role?.id && Number.isFinite(reward.rank))
    .map((reward) => ({
      level: reward.rank,
      messages: Math.max(1, mee6XpToMessages(mee6XpForLevel(reward.rank))),
      roleId: reward.role.id,
      roleName: reward.role.name,
      roleExists: guild.roles.cache.has(reward.role.id),
    }))
    .sort((a, b) => a.level - b.level);
}

export async function previewMee6Levels(
  guild: Guild,
): Promise<{ ok: true; preview: Mee6LevelsPreview } | { ok: false; error: string; status: number }> {
  try {
    const page = await fetchMee6Page(guild.id, 0);
    const players = page.players ?? [];
    return {
      ok: true,
      preview: {
        rewards: mapRewards(guild, page),
        firstPageMembers: players.length,
        morePages: players.length >= PAGE_SIZE,
        xpRate: page.xp_rate ?? 1,
        topLevel: players[0]?.level ?? 0,
      },
    };
  } catch (error) {
    if (error instanceof Mee6Error) return { ok: false, error: error.message, status: error.status };
    log.error("[bridge] MEE6 preview failed:", error);
    return { ok: false, error: "Couldn't read MEE6 levels. Try again later.", status: 502 };
  }
}

const jobs = new Map<string, Mee6ImportJob>();
const lastImportAt = new Map<string, number>();

export function getMee6ImportJob(guildId: string): Mee6ImportJob | null {
  return jobs.get(guildId) ?? null;
}

/**
 * Starts copying every ranked member's MEE6 progress into Activity Rewards in the background
 * (large servers have many leaderboard pages, fetched slowly to stay under MEE6's limits). The
 * dashboard polls `getMee6ImportJob`. Progress only ever goes up, so re-running is safe.
 */
export function startMee6Import(guild: Guild): { ok: true; job: Mee6ImportJob } | { ok: false; error: string; status: number } {
  const running = jobs.get(guild.id);
  if (running?.state === "running") return { ok: true, job: running };
  const last = lastImportAt.get(guild.id) ?? 0;
  if (Date.now() - last < IMPORT_COOLDOWN_MS) {
    const minutes = Math.ceil((IMPORT_COOLDOWN_MS - (Date.now() - last)) / 60_000);
    return { ok: false, error: `Levels were imported recently. You can run it again in ${minutes} minutes.`, status: 429 };
  }

  const job: Mee6ImportJob = { state: "running", membersFetched: 0, membersImported: 0, error: null, startedAt: Date.now() };
  jobs.set(guild.id, job);
  lastImportAt.set(guild.id, Date.now());

  void (async () => {
    const totals = new Map<string, number>();
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (page > 0) await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
        const data = await fetchMee6Page(guild.id, page);
        const players = data.players ?? [];
        for (const player of players) {
          const messages = mee6XpToMessages(player.xp);
          if (player.id && messages > 0) totals.set(player.id, messages);
        }
        job.membersFetched = totals.size;
        if (players.length < PAGE_SIZE) break;
      }
      job.membersImported = seedMessageProgress(guild.id, totals);
      job.state = "done";
    } catch (error) {
      job.state = "error";
      job.error = error instanceof Mee6Error ? error.message : "The import stopped partway. Try again later.";
      // Keep whatever was fetched before the failure; progress never goes down, so a retry is safe.
      if (totals.size) job.membersImported = seedMessageProgress(guild.id, totals);
      if (!(error instanceof Mee6Error)) log.error("[bridge] MEE6 import failed:", error);
    }
  })();

  return { ok: true, job };
}
