import type { Guild } from "discord.js";
import { getEquippedCosmeticsForUsers } from "../../../core/cosmetics/equip.js";
import { leaderboardCosmetics, type CosmeticStyle } from "../../../core/cosmetics/types.js";
import { DREAMLINER_ACCENT_HEX } from "../../../core/embeds.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";
import { renderLeaderboardImage, type LeaderboardRow } from "../../stats/functions/charts.js";
import { getGuildCounts, type InviterCounts } from "./store.js";

export const LEADERBOARD_PAGE_SIZE = 10;

/** Each member row's leaderboard cosmetics (flair, name style, icon, frame, bar), in one lookup. */
function withCosmetics(rows: LeaderboardRow[], userIds: string[]): LeaderboardRow[] {
  let styles: Map<string, CosmeticStyle>;
  try {
    styles = getEquippedCosmeticsForUsers(userIds);
  } catch {
    return rows;
  }
  return rows.map((row, index) => ({ ...row, cosmetics: leaderboardCosmetics(styles.get(userIds[index]!)) }));
}

async function resolveUserRow(guild: Guild, rank: number, row: InviterCounts, pool: number, t: Translator): Promise<LeaderboardRow> {
  const member = await guild.members.fetch(row.userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(row.userId).catch(() => null));
  const count = Math.max(0, row.total);
  const share = pool > 0 ? (count / pool) * 100 : 0;
  return {
    rank,
    label: member?.displayName ?? user?.username ?? t("stats.unknownUserFallback", "User {suffix}", { suffix: row.userId.slice(-4) }),
    count,
    shareLabel: `${share >= 10 || share === 0 ? Math.round(share) : share.toFixed(1)}%`,
    sharePct: share,
    avatarURL: user?.displayAvatarURL({ size: 128, extension: "png" }) ?? null,
  };
}

export function leaderboardPageCount(guildId: string): number {
  return Math.max(1, Math.ceil(getGuildCounts(guildId).rows.length / LEADERBOARD_PAGE_SIZE));
}

/**
 * One page of the invite leaderboard as the same PNG the Stats plugin renders, with the row
 * captions swapped for invite wording. Null when nobody has invites yet.
 */
export async function renderInviteLeaderboard(
  guild: Guild,
  page: number,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer; page: number; pages: number } | null> {
  const { rows } = getGuildCounts(guild.id);
  if (rows.length === 0) return null;
  const pages = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((current - 1) * LEADERBOARD_PAGE_SIZE, current * LEADERBOARD_PAGE_SIZE);
  const pool = rows.reduce((sum, row) => sum + Math.max(0, row.total), 0);

  // The chart's per-row text is written for message counts; reword it for invites.
  const inviteT: Translator = (key, fallback, vars) => {
    if (key === "stats.messagesCount") return t("invite_tracker.leaderboardCount", "{count} invites", vars);
    if (key === "stats.ofServerTraffic") return t("invite_tracker.leaderboardShare", "of all invites", vars);
    return t(key, fallback, vars);
  };

  const resolved = await Promise.all(
    slice.map((row, i) => resolveUserRow(guild, (current - 1) * LEADERBOARD_PAGE_SIZE + i + 1, row, pool, inviteT)),
  );
  const buffer = await renderLeaderboardImage(
    {
      title: t("invite_tracker.leaderboardTitle", "Top inviters"),
      subtitle: t("invite_tracker.leaderboardSubtitle", "{guild} · page {page} of {pages}", {
        guild: guild.name,
        page: current,
        pages,
      }),
      rows: withCosmetics(resolved, slice.map((row) => row.userId)),
      accentColor: DREAMLINER_ACCENT_HEX,
    },
    inviteT,
  );
  return { buffer, page: current, pages };
}
