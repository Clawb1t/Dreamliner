import type { Client } from "discord.js";
import { zImpersonationConfig, type ImpersonationConfig } from "../config/schemas/impersonation.js";
import { configManager } from "../config/manager.js";
import { fetchImageBuffer } from "../core/imageFetch.js";
import {
  addWatchlistEntry,
  listWatchlist,
  removeWatchlistEntry,
  ImpersonationWatchlistError,
  type WatchlistEntry,
} from "../plugins/impersonation/functions/watchlist.js";
import { listAlerts, setAlertStatus, type AlertStatus, type ImpersonationAlert } from "../plugins/impersonation/functions/alerts.js";
import { getIdentityHistory, type IdentityHistoryEntry } from "../plugins/impersonation/functions/history.js";
import { buildCandidateFromMember, findImpersonationMatch, type ImpersonationMatch } from "../plugins/impersonation/functions/detect.js";
import { hashAvatarUrl } from "../plugins/impersonation/functions/watchlist.js";
import { computeDHash } from "../plugins/automod/functions/imageHash.js";

export type WebImpersonationPayload = {
  enabled: boolean;
  config: ImpersonationConfig;
};

export async function getWebImpersonationState(guildId: string): Promise<WebImpersonationPayload> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const config = zImpersonationConfig.parse(guildConfig.plugins.impersonation?.config ?? {});
  return { enabled: guildConfig.plugins.impersonation?.enabled === true, config };
}

export async function saveWebImpersonation(
  guildId: string,
  userId: string,
  input: { enabled?: boolean; config?: unknown },
): Promise<WebImpersonationPayload> {
  if (input.config !== undefined) {
    const parsed = zImpersonationConfig.parse(input.config);
    const result = await configManager.patchPluginConfig(guildId, "impersonation", parsed, userId);
    if (!result.success) throw new Error(result.errors.join("\n"));
  }
  if (typeof input.enabled === "boolean") {
    const result = await configManager.setPluginEnabled(guildId, "impersonation", input.enabled, userId);
    if (!result.success) throw new Error(result.errors.join("\n"));
  }
  return getWebImpersonationState(guildId);
}

export async function listWebWatchlist(guildId: string): Promise<WatchlistEntry[]> {
  return listWatchlist(guildId);
}

export async function addWebWatchlistEntry(input: {
  guildId: string;
  userId: string;
  label: string;
  targetUserId?: string;
  name?: string;
  imageBase64?: string;
  imageUrl?: string;
  phash?: string;
}): Promise<WatchlistEntry> {
  let imageBuffer: Buffer | undefined;
  if (input.imageBase64) {
    const cleaned = input.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    imageBuffer = Buffer.from(cleaned, "base64");
    if (!imageBuffer.length) throw new ImpersonationWatchlistError("Empty image data.");
  } else if (input.imageUrl) {
    const buf = await fetchImageBuffer(input.imageUrl);
    if (!buf) throw new ImpersonationWatchlistError("Could not download that image URL.");
    imageBuffer = buf;
  }

  return addWatchlistEntry({
    guildId: input.guildId,
    label: input.label,
    addedBy: input.userId,
    targetUserId: input.targetUserId,
    name: input.name,
    imageBuffer,
    phash: input.phash,
  });
}

export async function removeWebWatchlistEntry(guildId: string, id: string): Promise<boolean> {
  return removeWatchlistEntry(guildId, id);
}

export async function listWebAlerts(
  guildId: string,
  opts: { status?: AlertStatus; limit?: number } = {},
): Promise<ImpersonationAlert[]> {
  return listAlerts(guildId, opts);
}

export async function resolveWebAlert(
  guildId: string,
  id: string,
  status: Exclude<AlertStatus, "open">,
  userId: string,
): Promise<ImpersonationAlert | null> {
  return setAlertStatus(guildId, id, status, userId);
}

export async function getWebIdentityHistory(guildId: string, userId: string): Promise<IdentityHistoryEntry[]> {
  return getIdentityHistory(guildId, userId);
}

export type WebImpersonationTestResult = {
  candidate: { username: string; displayName: string; avatarUrl: string | null };
  match: (Omit<ImpersonationMatch, "protectedIdentity"> & {
    label: string;
    matchedUserId: string | null;
    matchedAvatarUrl: string | null;
  }) | null;
};

/** Non-mutating: builds a candidate identity (either a real member, or a manual name/image)
 * and runs it through the same matching pipeline live detection uses, without creating an
 * alert or taking any action. Lets staff sanity-check thresholds/watchlist entries directly. */
export async function testWebImpersonation(
  client: Client,
  guildId: string,
  input: { targetUserId?: string; name?: string; imageBase64?: string; imageUrl?: string },
): Promise<WebImpersonationTestResult> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("Bot is not in that server.");
  const { config } = await getWebImpersonationState(guildId);

  let username: string;
  let displayName: string;
  let avatarUrl: string | null = null;
  let avatarHash: string | null = null;

  if (input.targetUserId) {
    const member = guild.members.cache.get(input.targetUserId) ?? (await guild.members.fetch(input.targetUserId).catch(() => null));
    if (!member) throw new Error("That member isn't in this server (or isn't cached).");
    const candidate = await buildCandidateFromMember(member);
    username = candidate.username;
    displayName = candidate.displayName;
    avatarHash = candidate.avatarHash;
    avatarUrl = member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 });
    const match = await findImpersonationMatch(guild, candidate, config);
    return {
      candidate: { username, displayName, avatarUrl },
      match: match
        ? {
            label: match.protectedIdentity.label,
            matchedUserId: match.protectedIdentity.userId,
            matchedAvatarUrl: match.protectedIdentity.avatarUrl,
            nameSimilarity: match.nameSimilarity,
            avatarDistance: match.avatarDistance,
            score: match.score,
          }
        : null,
    };
  }

  username = input.name?.trim() || "";
  displayName = username;
  if (!username) throw new Error("Provide a member to test, or a manual name.");

  let buffer: Buffer | null = null;
  if (input.imageBase64) {
    const cleaned = input.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    buffer = Buffer.from(cleaned, "base64");
  } else if (input.imageUrl) {
    buffer = await fetchImageBuffer(input.imageUrl);
  }
  if (buffer) {
    try {
      avatarHash = await computeDHash(buffer);
    } catch {
      avatarHash = null;
    }
  }

  const match = await findImpersonationMatch(guild, { userId: "manual-test", username, displayName, avatarHash }, config);
  return {
    candidate: { username, displayName, avatarUrl },
    match: match
      ? {
          label: match.protectedIdentity.label,
          matchedUserId: match.protectedIdentity.userId,
          matchedAvatarUrl: match.protectedIdentity.avatarUrl,
          nameSimilarity: match.nameSimilarity,
          avatarDistance: match.avatarDistance,
          score: match.score,
        }
      : null,
  };
}

export { hashAvatarUrl, ImpersonationWatchlistError };
