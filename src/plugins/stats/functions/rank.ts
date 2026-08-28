import type { Guild, User } from "discord.js";
import { renderRankCard, type RankCardRow } from "./charts.js";
import { formatSharePct, sharePctValue } from "./analysis.js";
import { getActiveMessagerCount, getTotalGuildMessages, getUserMessageCount, getUserMessageRank } from "./queries.js";
import {
  getGlobalActiveMessagerCount,
  getGlobalTrackedMessagesTotal,
  getGlobalUserMessageCount,
  getGlobalUserMessageRank,
} from "./globalQueries.js";
import { getUserProfile } from "../../../bridge/userProfiles.js";
import { listDisplayedUserBadges } from "../../../bridge/userBadges.js";

export type RankScope = "server" | "global";

export type RankResult = {
  buffer: Buffer;
  rank: number;
  totalRanked: number;
  count: number;
};

function displayName(member: import("discord.js").GuildMember | null, user: User): string {
  return member?.displayName ?? user.username;
}

export async function renderUserRankCard(
  scope: RankScope,
  guild: Guild,
  user: User,
): Promise<RankResult> {
  // Banners aren't included on cached User objects — a forced fetch is required to see one.
  const [member, bannerUser, profile, badges] = await Promise.all([
    guild.members.fetch(user.id).catch(() => null),
    guild.client.users.fetch(user.id, { force: true }).catch((err) => {
      console.warn(`[rank card] forced user fetch failed for ${user.id}:`, err);
      return null;
    }),
    getUserProfile(user.id),
    listDisplayedUserBadges(user.id),
  ]);
  const name = displayName(member, user);
  const avatarURL = user.displayAvatarURL({ size: 128, extension: "png" });
  const bannerURL = bannerUser?.bannerURL({ size: 512, extension: "png" }) ?? null;
  const rowBadges = badges.slice(0, 3).map((badge) => ({
    name: badge.name,
    icon: badge.icon,
    iconImageUrl: badge.iconImageUrl,
    colorHex: badge.colorHex,
  }));

  if (scope === "global") {
    const [count, total, activeUsers] = await Promise.all([
      getGlobalUserMessageCount(user.id),
      getGlobalTrackedMessagesTotal(),
      getGlobalActiveMessagerCount(),
    ]);
    const rank = count > 0 ? await getGlobalUserMessageRank(count) : activeUsers + 1;
    const row: RankCardRow = {
      rank,
      name,
      avatarURL,
      bannerURL,
      count,
      sharePct: sharePctValue(count, total),
      shareLabel: formatSharePct(count, total),
      accentColor: profile.accentColor,
      badges: rowBadges,
    };
    const buffer = await renderRankCard({ row });
    return { buffer, rank, totalRanked: Math.max(activeUsers, rank), count };
  }

  const [count, total, activeUsers] = await Promise.all([
    getUserMessageCount(guild.id, user.id),
    getTotalGuildMessages(guild.id),
    getActiveMessagerCount(guild.id),
  ]);
  const rank = count > 0 ? await getUserMessageRank(guild.id, user.id, count) : activeUsers + 1;
  const row: RankCardRow = {
    rank,
    name,
    avatarURL,
    bannerURL,
    count,
    sharePct: sharePctValue(count, total),
    shareLabel: formatSharePct(count, total),
    accentColor: profile.accentColor,
    badges: rowBadges,
  };
  const buffer = await renderRankCard({ row });
  return { buffer, rank, totalRanked: Math.max(activeUsers, rank), count };
}
