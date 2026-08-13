/** Staff review channel for dashboard bot avatar/banner requests. */
export const AVATAR_REVIEW_CHANNEL_ID = "1535040620266258493";

export const BOT_AVATAR_PREFIX = "dl:botavatar:";

export function botAvatarApproveCustomId(requestId: number): string {
  return `${BOT_AVATAR_PREFIX}a:${requestId}`;
}

export function botAvatarDenyCustomId(requestId: number): string {
  return `${BOT_AVATAR_PREFIX}d:${requestId}`;
}

export function parseBotAvatarCustomId(
  customId: string,
): { action: "approve" | "deny"; requestId: number } | null {
  if (!customId.startsWith(BOT_AVATAR_PREFIX)) return null;
  const rest = customId.slice(BOT_AVATAR_PREFIX.length);
  const match = /^(a|d):(\d+)$/.exec(rest);
  if (!match) return null;
  const requestId = Number(match[2]);
  if (!Number.isFinite(requestId) || requestId <= 0) return null;
  return {
    action: match[1] === "a" ? "approve" : "deny",
    requestId,
  };
}
