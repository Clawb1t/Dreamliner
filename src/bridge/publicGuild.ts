import type { Guild } from "discord.js";
import type { PublicStatsConfig } from "../config/schemas/guild.js";
import { configManager } from "../config/manager.js";
import {
  buildWebServerStats,
  parseWebStatsQuery,
  type WebStatsQuery,
} from "./webStats.js";

export type PublicStatsSections = PublicStatsConfig;

export const PUBLIC_STATS_SECTION_KEYS = [
  "overview",
  "activity",
  "membership",
  "engagement",
  "patterns",
  "leaders",
  "table",
] as const satisfies ReadonlyArray<keyof PublicStatsSections>;

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

export function hasAnyPublicStatsSection(sections: PublicStatsSections): boolean {
  return PUBLIC_STATS_SECTION_KEYS.some((key) => Boolean(sections[key]));
}

export function normalizePublicStatsSections(input: unknown): PublicStatsSections {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    overview: Boolean(src.overview),
    activity: Boolean(src.activity),
    membership: Boolean(src.membership),
    engagement: Boolean(src.engagement),
    patterns: Boolean(src.patterns),
    leaders: Boolean(src.leaders),
    table: Boolean(src.table),
  };
}

export async function buildPublicGuildHome(guild: Guild) {
  const config = await configManager.getEffectiveConfig(guild.id);
  let ownerName: string | null = null;
  let ownerDisplayName: string | null = null;
  let ownerAvatar: string | null = null;
  try {
    const owner =
      guild.members.cache.get(guild.ownerId) ??
      (await guild.fetchOwner({ cache: true }).catch(() => null));
    if (owner) {
      ownerName = owner.user.username;
      ownerDisplayName = owner.displayName;
      ownerAvatar = owner.user.displayAvatarURL({ size: 64 });
    }
  } catch {
    // Owner may be unavailable.
  }

  return {
    ok: true as const,
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      banner: guild.banner,
      memberCount: guild.memberCount,
      createdAt: guild.createdAt.toISOString(),
      ownerId: guild.ownerId,
      ownerName,
      ownerDisplayName,
      ownerAvatar,
    },
    theme: {
      accentColor: colorIntToHex(config.server_accent_color),
      overrideUserAccents: Boolean(config.leaderboard_override_user_accents),
    },
    publicStats: config.public_stats,
    leaderboardAlwaysPublic: true as const,
  };
}

function redactStatsForPublicSections<T extends Record<string, unknown>>(
  payload: T,
  sections: PublicStatsSections,
): T & { publicSections: PublicStatsSections } {
  const next = structuredClone(payload) as T & {
    publicSections: PublicStatsSections;
    overview?: {
      topMessagersWindow?: unknown[];
      topMessagersAllTime?: unknown[];
      topChannels?: unknown[];
      topCommandsWindow?: unknown[];
      topCommandsAllTime?: unknown[];
    };
    series?: {
      daily?: unknown[];
      commands?: unknown[];
      activeUsers?: unknown[];
      messagesPerActiveUser?: unknown[];
      weekday?: Record<string, unknown[]>;
      weekdayMessages?: unknown[];
      engagementMix?: unknown[];
      allTimeMix?: unknown[];
    };
  };
  next.publicSections = sections;

  if (!sections.leaders && next.overview) {
    next.overview.topMessagersWindow = [];
    next.overview.topMessagersAllTime = [];
    next.overview.topChannels = [];
    next.overview.topCommandsWindow = [];
    next.overview.topCommandsAllTime = [];
  }

  const needsDaily =
    sections.overview ||
    sections.activity ||
    sections.membership ||
    sections.engagement ||
    sections.table;
  if (!needsDaily && next.series) {
    next.series.daily = [];
    next.series.commands = [];
    next.series.activeUsers = [];
    next.series.messagesPerActiveUser = [];
  }

  if (!sections.patterns && next.series) {
    next.series.weekday = {
      messages: [],
      joins: [],
      leaves: [],
      engagement: [],
      activeUsers: [],
    };
    next.series.weekdayMessages = [];
  }

  if (!sections.engagement && next.series) {
    next.series.engagementMix = [];
    next.series.allTimeMix = [];
  }

  return next;
}

export async function buildWebPublicServerStats(guild: Guild, query: WebStatsQuery) {
  const config = await configManager.getEffectiveConfig(guild.id);
  const sections = config.public_stats;
  if (!hasAnyPublicStatsSection(sections)) {
    return {
      ok: false as const,
      error: "This server has not published any stats sections yet.",
      publicSections: sections,
      guild: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        memberCount: guild.memberCount,
      },
      theme: {
        accentColor: colorIntToHex(config.server_accent_color),
        overrideUserAccents: Boolean(config.leaderboard_override_user_accents),
      },
    };
  }

  const payload = await buildWebServerStats(guild, query);
  return {
    ok: true as const,
    ...redactStatsForPublicSections(payload, sections),
    theme: {
      accentColor: colorIntToHex(config.server_accent_color),
      overrideUserAccents: Boolean(config.leaderboard_override_user_accents),
    },
  };
}

export async function savePublicStatsSections(
  guildId: string,
  sectionsInput: unknown,
  updatedBy: string,
) {
  const sections = normalizePublicStatsSections(sectionsInput);
  const result = await configManager.patchTopLevelConfig(
    guildId,
    { public_stats: sections },
    updatedBy,
  );
  if (!result.success) {
    return { ok: false as const, errors: result.errors };
  }
  return { ok: true as const, publicStats: sections };
}

export { parseWebStatsQuery };
