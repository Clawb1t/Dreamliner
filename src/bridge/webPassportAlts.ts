import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { getPassportConfig, isPassportEnabled } from "../plugins/passport/functions/loadConfig.js";
import { findLikelyAlts, type AltConfidenceTier, type AltSignalType } from "../plugins/passport/functions/altMatching.js";
import {
  deletePassportNetworkSignals,
  dismissPassportAltPair,
} from "../plugins/passport/functions/altSignals.js";
import type { WebPerson } from "./webModeration.js";

export type WebAltCluster = {
  clusterId: string;
  confidenceTier: AltConfidenceTier;
  signalTypes: AltSignalType[];
  members: WebPerson[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export type WebPassportAltsPayload = {
  enabled: boolean;
  clusters: WebAltCluster[];
};

async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

/** Dashboard Alts tab: guild-scoped clusters of likely alt accounts, no IP/location included. */
export async function listWebPassportAlts(guild: Guild): Promise<WebPassportAltsPayload> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const enabled = isPassportEnabled(guildConfig) && getPassportConfig(guildConfig).alt_detection;
  if (!enabled) return { enabled: false, clusters: [] };

  const clusters = await findLikelyAlts(guild.id);
  const memberCache = new Map<string, WebPerson>();
  const resolved: WebAltCluster[] = [];

  for (const cluster of clusters) {
    const members = await Promise.all(
      cluster.memberIds.map(async (id) => {
        const cached = memberCache.get(id);
        if (cached) return cached;
        const person = await resolvePerson(guild, id);
        memberCache.set(id, person);
        return person;
      }),
    );
    resolved.push({
      clusterId: cluster.clusterId,
      confidenceTier: cluster.confidenceTier,
      signalTypes: cluster.signalTypes,
      members,
      firstSeenAt: cluster.firstSeenAt.toISOString(),
      lastSeenAt: cluster.lastSeenAt.toISOString(),
    });
  }

  return { enabled: true, clusters: resolved };
}

export async function dismissWebPassportAltPair(
  guildId: string,
  userIdA: string,
  userIdB: string,
  actorUserId: string,
): Promise<{ ok: boolean }> {
  await dismissPassportAltPair(guildId, userIdA, userIdB, actorUserId);
  return { ok: true };
}

/** Config page "delete collected data" control. */
export async function clearWebPassportAltData(guildId: string): Promise<{ ok: boolean }> {
  await deletePassportNetworkSignals(guildId);
  return { ok: true };
}
