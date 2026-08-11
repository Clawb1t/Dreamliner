import { createHmac, timingSafeEqual } from "node:crypto";
import { getDashboardBridgeSecret, resolveSiteUrl } from "../bridge/env.js";

function shareSecret(): string | null {
  return getDashboardBridgeSecret() ?? process.env.AUTH_SECRET?.trim() ?? null;
}

function signGuildId(guildId: string, secret: string): string {
  return createHmac("sha256", secret).update(`lb:v1:${guildId}`).digest("base64url");
}

/** Same token format as the website public messager leaderboard share links. */
export function createLeaderboardShareToken(guildId: string): string | null {
  if (!/^\d{17,20}$/.test(guildId)) return null;
  const secret = shareSecret();
  if (!secret) return null;
  return `${guildId}.${signGuildId(guildId, secret)}`;
}

export function parseLeaderboardShareToken(token: string): string | null {
  const trimmed = token.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0) return null;
  const guildId = trimmed.slice(0, dot);
  const sig = trimmed.slice(dot + 1);
  if (!/^\d{17,20}$/.test(guildId) || !sig) return null;
  const secret = shareSecret();
  if (!secret) return null;
  try {
    const expected = signGuildId(guildId, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return guildId;
  } catch {
    return null;
  }
}

export function publicLeaderboardUrl(guildId: string): string | null {
  if (!/^\d{17,20}$/.test(guildId)) return null;
  return `${resolveSiteUrl()}/server/${guildId}/leaderboard`;
}
