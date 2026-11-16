import type { Client, Guild } from "discord.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
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
import { withTeamRankProtection } from "../plugins/impersonation/functions/teamProtection.js";
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

/** An alert plus who the matched member actually is (the stored label is only why they're protected). */
export type WebImpersonationAlert = ImpersonationAlert & {
  /** Display name of the matched member, or null for watchlist matches / members we can't find. */
  matchedName: string | null;
  matchedUsername: string | null;
  /** The stored label: the protected role's name, "Server member", or the watchlist entry's label. */
  matchedReason: string;
};

async function withMatchedPeople(client: Client, guildId: string, alerts: ImpersonationAlert[]): Promise<WebImpersonationAlert[]> {
  const guild: Guild | undefined = client.guilds.cache.get(guildId);
  const ids = [...new Set(alerts.map((a) => a.matchedUserId).filter((id): id is string => Boolean(id)))];
  const people = new Map<string, { name: string; username: string; avatarUrl: string | null }>();
  await Promise.all(
    ids.map(async (id) => {
      const member = guild ? await fetchMemberCached(guild, id).catch(() => null) : null;
      if (member) {
        people.set(id, {
          name: member.displayName,
          username: member.user.username,
          avatarUrl: member.displayAvatarURL({ size: 128 }),
        });
        return;
      }
      const user = await fetchUserCached(client, id).catch(() => null);
      if (user) people.set(id, { name: user.globalName ?? user.username, username: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) });
    }),
  );
  return alerts.map((alert) => {
    const person = alert.matchedUserId ? people.get(alert.matchedUserId) : undefined;
    return {
      ...alert,
      matchedName: person?.name ?? null,
      matchedUsername: person?.username ?? null,
      matchedReason: alert.matchedLabel,
      matchedAvatarUrl: alert.matchedAvatarUrl ?? person?.avatarUrl ?? null,
    };
  });
}

export async function listWebAlerts(
  client: Client,
  guildId: string,
  opts: { status?: AlertStatus; limit?: number } = {},
): Promise<WebImpersonationAlert[]> {
  return withMatchedPeople(client, guildId, await listAlerts(guildId, opts));
}

export async function resolveWebAlert(
  client: Client,
  guildId: string,
  id: string,
  status: Exclude<AlertStatus, "open">,
  userId: string,
): Promise<WebImpersonationAlert | null> {
  const alert = await setAlertStatus(guildId, id, status, userId);
  return alert ? ((await withMatchedPeople(client, guildId, [alert]))[0] ?? null) : null;
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
    matchedName: string | null;
    matchedUsername: string | null;
  }) | null;
};

/** Non-mutating: builds a candidate identity (either a real member, or a manual name/image)
 * and runs it through the same matching pipeline live detection uses, without creating an
 * alert or taking any action. Lets staff sanity-check thresholds/watchlist entries directly. */
async function runWebImpersonationTest(
  client: Client,
  guildId: string,
  input: { targetUserId?: string; name?: string; imageBase64?: string; imageUrl?: string },
): Promise<WebImpersonationTestResult> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("Bot is not in that server.");
  const config = await withTeamRankProtection(guildId, (await getWebImpersonationState(guildId)).config);

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
            matchedName: null,
            matchedUsername: null,
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
          matchedName: null,
          matchedUsername: null,
          nameSimilarity: match.nameSimilarity,
          avatarDistance: match.avatarDistance,
          score: match.score,
        }
      : null,
  };
}

export async function testWebImpersonation(
  client: Client,
  guildId: string,
  input: { targetUserId?: string; name?: string; imageBase64?: string; imageUrl?: string },
): Promise<WebImpersonationTestResult> {
  const result = await runWebImpersonationTest(client, guildId, input);
  const match = result.match;
  if (!match?.matchedUserId) return result;
  const guild = client.guilds.cache.get(guildId);
  const member = guild ? await fetchMemberCached(guild, match.matchedUserId).catch(() => null) : null;
  return {
    ...result,
    match: {
      ...match,
      matchedName: member?.displayName ?? null,
      matchedUsername: member?.user.username ?? null,
      matchedAvatarUrl: match.matchedAvatarUrl ?? member?.displayAvatarURL({ size: 128 }) ?? null,
    },
  };
}

export { hashAvatarUrl, ImpersonationWatchlistError };
