import type { Guild } from "discord.js";
import { DREAMLINER_ACCENT_HEX } from "../../../core/embeds.js";
import { formatSharePct, sharePctValue } from "./analysis.js";
import { formatStatsWindowLong, isAllTimeWindow, isValidStatsWindow } from "./daily.js";
import { getTopChannelsByDaily, getTopMessagers, getTopUsersByDaily, getTrackedDailyMessagesTotal, getTrackedMessagesTotal } from "./queries.js";
import { renderLeaderboardImage, type LeaderboardImageOptions, type LeaderboardRow } from "./charts.js";
import { animatedCardKey, cachedAnimatedCard, hasBackgroundFrames, recordTranslations, renderAnimatedLeaderboard } from "./animatedCards.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import { getEquippedCosmeticsForUsers } from "../../../core/cosmetics/equip.js";
import { leaderboardCosmetics } from "../../../core/cosmetics/types.js";
import { listHiddenFromLeaderboards } from "../../../core/privacy/ghostMode.js";

/** Each member row's leaderboard cosmetics (flair, name style, icon, frame, bar), in one lookup. */
function withCosmetics(rows: LeaderboardRow[], userIds: string[]): LeaderboardRow[] {
  let styles: Map<string, import("../../../core/cosmetics/types.js").CosmeticStyle>;
  try {
    styles = getEquippedCosmeticsForUsers(userIds);
  } catch {
    return rows;
  }
  return rows.map((row, index) => ({ ...row, cosmetics: leaderboardCosmetics(styles.get(userIds[index]!)) }));
}

export type LeaderboardImage = {
  buffer: Buffer;
  caption: string;
  /** When a listed member's background is animated: the leaderboard as a GIF (null if that fails). */
  animate?: () => Promise<Buffer | null>;
};

/** The still leaderboard, plus its GIF version when any listed row has an animated background. */
async function renderImage(guildId: string, options: LeaderboardImageOptions, t: Translator): Promise<{ buffer: Buffer; animate?: () => Promise<Buffer | null> }> {
  const recorder = recordTranslations(t);
  const buffer = await renderLeaderboardImage(options, recorder.t);
  const animated = options.rows.slice(0, 10).find((row) => hasBackgroundFrames(row.cosmetics?.background, "rank"));
  if (!animated) return { buffer };
  const translations = recorder.entries();
  const key = animatedCardKey("leaderboard", guildId, animated.cosmetics?.background, [options, translations]);
  return { buffer, animate: () => cachedAnimatedCard(key, () => renderAnimatedLeaderboard(options, translations)) };
}

function windowCaption(days: number, kind: string, t: Translator): string {
  if (!isValidStatsWindow(days)) return t("stats.captionKindDays", "{kind} · {days} days", { kind, days });
  return t("stats.captionKindWindow", "{kind} · {window}", { kind, window: formatStatsWindowLong(days, t).toLowerCase() });
}

/** Ranked users fetched per leaderboard image: Ghost Mode and unresolvable users are skipped and the
 *  next ones fill in. */
const USER_CANDIDATES = 25;
const USER_ROWS = 10;

async function resolveUserRow(
  guild: Guild,
  rank: number,
  userId: string,
  count: number,
  total: number,
): Promise<LeaderboardRow | null> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  const label = member?.displayName ?? user?.globalName ?? user?.username;
  // Deleted or unknown accounts are left off rather than shown as an ID.
  if (!label || /^deleted_user_[0-9a-f]+$/i.test(user?.username ?? "")) return null;
  return {
    rank,
    label,
    count,
    shareLabel: formatSharePct(count, total),
    sharePct: sharePctValue(count, total),
    avatarURL: user?.displayAvatarURL({ size: 128, extension: "png" }) ?? null,
  };
}

async function resolveChannelRow(
  guild: Guild,
  rank: number,
  channelId: string,
  count: number,
  total: number,
  t: Translator,
): Promise<LeaderboardRow> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const name = channel && "name" in channel ? channel.name : t("stats.unknownChannelFallback", "unknown");
  return {
    rank,
    label: `#${name}`,
    count,
    shareLabel: formatSharePct(count, total),
    sharePct: sharePctValue(count, total),
    avatarURL: null,
    fallbackInitial: name.charAt(0).toUpperCase() || "#",
  };
}

/**
 * The leaderboard's user rows: Ghost Mode users (and anyone hidden from leaderboards) left out,
 * unresolvable accounts skipped, the rest renumbered 1..n, filled to USER_ROWS from further down.
 */
async function userRows(guild: Guild, top: Array<{ userId: string; count: number }>, total: number): Promise<{ rows: LeaderboardRow[]; userIds: string[] }> {
  const hidden = listHiddenFromLeaderboards();
  const eligible = top.filter((entry) => !hidden.has(entry.userId));
  const rows: LeaderboardRow[] = [];
  const userIds: string[] = [];
  for (let i = 0; i < eligible.length && rows.length < USER_ROWS; i += USER_ROWS) {
    const batch = eligible.slice(i, i + USER_ROWS);
    const resolved = await Promise.all(batch.map((entry) => resolveUserRow(guild, 0, entry.userId, entry.count, total)));
    resolved.forEach((row, index) => {
      if (!row || rows.length >= USER_ROWS) return;
      rows.push({ ...row, rank: rows.length + 1 });
      userIds.push(batch[index]!.userId);
    });
  }
  return { rows, userIds };
}

export async function renderUsersLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<LeaderboardImage> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([
    isAllTimeWindow(days) ? getTopMessagers(guildId, USER_CANDIDATES) : getTopUsersByDaily(guildId, days, USER_CANDIDATES),
    getTrackedMessagesTotal(guildId, days),
  ]);
  const people = await userRows(guild, top, total);
  const rows = withCosmetics(people.rows, people.userIds);
  return {
    ...(await renderImage(guildId, { title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t)),
    caption: windowCaption(days, t("stats.leaderboardTopMessagers", "Top messagers"), t),
  };
}

export async function renderChannelsLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([
    getTopChannelsByDaily(guildId, days, 10),
    getTrackedDailyMessagesTotal(guildId, days),
  ]);
  const rows = await Promise.all(
    top.map((entry, i) => resolveChannelRow(guild, i + 1, entry.channelId, entry.count, total, t)),
  );
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t),
    caption: windowCaption(days, t("stats.leaderboardTopChannels", "Top channels"), t),
  };
}

export async function renderAllTimeUsersLeaderboard(
  guild: Guild,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<LeaderboardImage> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([getTopMessagers(guildId, USER_CANDIDATES), getTrackedMessagesTotal(guildId, 0)]);
  const people = await userRows(guild, top, total);
  const rows = withCosmetics(people.rows, people.userIds);
  return {
    ...(await renderImage(guildId, { title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t)),
    caption: t("stats.captionAllTimeTopMessagers", "All-time top messagers"),
  };
}
