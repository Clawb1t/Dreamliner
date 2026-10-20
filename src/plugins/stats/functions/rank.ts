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
import { getProgressionBadges, loadBadgeImage } from "../../../core/progressionBadges/index.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import { retryAsync } from "../../../core/retry.js";
import { getEquippedStyle } from "../../../core/cosmetics/equip.js";
import { getLogger } from "../../../core/logger.js";
import { animatedCardKey, cachedAnimatedCard, hasBackgroundFrames, recordTranslations, renderAnimatedRankCard } from "./animatedCards.js";
const log = getLogger("stats");

export type RankScope = "server" | "global";

export type RankResult = {
  buffer: Buffer;
  rank: number;
  totalRanked: number;
  count: number;
  /** When the equipped background is animated: renders the card as a GIF (null if that fails). */
  animate?: () => Promise<Buffer | null>;
};

/** The still card, plus its GIF version when the member's background has animation frames. */
async function renderCard(userId: string, row: RankCardRow, t: Translator): Promise<{ buffer: Buffer; animate?: () => Promise<Buffer | null> }> {
  const recorder = recordTranslations(t);
  const buffer = await renderRankCard({ row }, recorder.t);
  const background = row.cosmetics?.background;
  if (!hasBackgroundFrames(background, "rank")) return { buffer };
  const translations = recorder.entries();
  const key = animatedCardKey("rank", userId, background, [row, translations]);
  return { buffer, animate: () => cachedAnimatedCard(key, () => renderAnimatedRankCard(row, translations)) };
}

// The banner is decoration: never let a slow Discord fetch hold the whole reply hostage.
const BANNER_FETCH_BUDGET_MS = 5_000;

function withinBudget<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function progressionIconBuffers(
  badges: Array<{ id: string; imageKey: string }>,
): Promise<Array<{ image: Buffer; accentTint?: boolean }>> {
  const images = await Promise.all(badges.map((badge) => loadBadgeImage(badge.imageKey).catch(() => null)));
  // Art that has gone missing since the badge list was read is just left off the card. The
  // Dreamliner One bolt is drawn in the user's accent, like on the site (and /profile).
  return badges.flatMap((badge, index) => {
    const image = images[index];
    return image ? [{ image: image.buffer, accentTint: badge.id === "dreamliner_one" }] : [];
  });
}

function safeCosmetics(userId: string) {
  try {
    return getEquippedStyle(userId);
  } catch (err) {
    log.debug(`[rank card] cosmetics lookup failed for ${userId}:`, err);
    return null;
  }
}

function displayName(member: import("discord.js").GuildMember | null, user: User): string {
  return member?.displayName ?? user.username;
}

export async function renderUserRankCard(
  scope: RankScope,
  guild: Guild,
  user: User,
  t: Translator = defaultTranslator,
): Promise<RankResult> {
  // Banners aren't included on cached User objects — a forced fetch is required to see one.
  // Retried a few times: a single rate limit or network blip here used to mean the card just
  // rendered with no banner, since there was nothing to fall back to and nothing that retried.
  const [member, bannerUser, profile, badges, progression] = await Promise.all([
    withinBudget(guild.members.fetch(user.id).catch(() => null), BANNER_FETCH_BUDGET_MS),
    withinBudget(
      retryAsync(() => guild.client.users.fetch(user.id, { force: true }), {
        onError: (err, attempt) => log.debug(`[rank card] forced user fetch failed for ${user.id} (attempt ${attempt}):`, err),
      }),
      BANNER_FETCH_BUDGET_MS,
    ),
    getUserProfile(user.id),
    listDisplayedUserBadges(user.id),
    getProgressionBadges(guild.client, user.id).catch(() => []),
  ]);
  const name = displayName(member, user);
  // Sized for the 4x card: the avatar draws at 256px and the banner spans 1840px.
  const avatarURL = user.displayAvatarURL({ size: 512, extension: "png" });
  const bannerURL = bannerUser?.bannerURL({ size: 2048, extension: "png" }) ?? null;
  const rowBadges = badges.slice(0, 3).map((badge) => ({
    name: badge.name,
    icon: badge.icon,
    iconImageUrl: badge.iconImageUrl,
    colorHex: badge.colorHex,
  }));
  const progressionIcons = await progressionIconBuffers(progression);
  const cosmetics = safeCosmetics(user.id);

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
      fallbackName: user.username,
      avatarURL,
      bannerURL,
      count,
      sharePct: sharePctValue(count, total),
      shareLabel: formatSharePct(count, total),
      accentColor: profile.accentColor,
      badges: rowBadges,
      progressionIcons,
      cosmetics,
    };
    const { buffer, animate } = await renderCard(user.id, row, t);
    return { buffer, rank, totalRanked: Math.max(activeUsers, rank), count, animate };
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
    fallbackName: user.username,
    avatarURL,
    bannerURL,
    count,
    sharePct: sharePctValue(count, total),
    shareLabel: formatSharePct(count, total),
    accentColor: profile.accentColor,
    badges: rowBadges,
    progressionIcons,
    cosmetics,
  };
  const { buffer, animate } = await renderCard(user.id, row, t);
  return { buffer, rank, totalRanked: Math.max(activeUsers, rank), count, animate };
}
