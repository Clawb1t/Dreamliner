/** Staff photo-log channel for dashboard bot avatar/banner changes. */
export const BOT_BRAND_LOG_CHANNEL_ID = "1535040620266258493";

/** @deprecated Prefer BOT_BRAND_LOG_CHANNEL_ID */
export const AVATAR_REVIEW_CHANNEL_ID = BOT_BRAND_LOG_CHANNEL_ID;

export const BOT_AVATAR_PREFIX = "dl:botavatar:";

export function botAvatarApproveCustomId(requestId: number): string {
  return `${BOT_AVATAR_PREFIX}a:${requestId}`;
}

export function botAvatarDenyCustomId(requestId: number): string {
  return `${BOT_AVATAR_PREFIX}d:${requestId}`;
}

/** Posted on photo-log messages so staff can pull a live avatar/banner back down. */
export function botBrandRemoveCustomId(requestId: number): string {
  return `${BOT_AVATAR_PREFIX}r:${requestId}`;
}

export function parseBotAvatarCustomId(
  customId: string,
): { action: "approve" | "deny" | "remove"; requestId: number } | null {
  if (!customId.startsWith(BOT_AVATAR_PREFIX)) return null;
  const rest = customId.slice(BOT_AVATAR_PREFIX.length);
  const match = /^(a|d|r):(\d+)$/.exec(rest);
  if (!match) return null;
  const requestId = Number(match[2]);
  if (!Number.isFinite(requestId) || requestId <= 0) return null;
  return {
    action: match[1] === "a" ? "approve" : match[1] === "d" ? "deny" : "remove",
    requestId,
  };
}
