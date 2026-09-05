import type { Guild, GuildMember } from "discord.js";
import type { ImpersonationConfig } from "../../../config/schemas/impersonation.js";
import { hammingDistance } from "../../automod/functions/imageHash.js";
import { nameSimilarityPercent } from "./similarity.js";
import { listWatchlist, hashAvatarUrl, type WatchlistEntry } from "./watchlist.js";
import type { AlertTrigger } from "./alerts.js";

/** A cheap safety cap on how many cached members "everyone" scope will compare against —
 * protects a huge server from turning one identity change into a multi-thousand-comparison
 * scan. "protected_only" (the default) never gets anywhere near this in practice. */
const MAX_COMPARISONS = 2_000;

export type IdentityCandidate = {
  userId: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
};

export type ProtectedIdentity = {
  label: string;
  userId: string | null;
  watchlistId: string | null;
  username: string;
  displayName: string;
  avatarHash: string | null;
  avatarUrl: string | null;
};

export type ImpersonationMatch = {
  protectedIdentity: ProtectedIdentity;
  nameSimilarity: number | null;
  avatarDistance: number | null;
  /** 0-100 combined confidence, used only to rank multiple candidate matches. */
  score: number;
};

export async function buildCandidateFromMember(member: GuildMember): Promise<IdentityCandidate> {
  const avatarUrl = member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 });
  return {
    userId: member.id,
    username: member.user.username,
    displayName: member.nickname ?? member.user.globalName ?? member.user.username,
    avatarHash: avatarUrl ? await hashAvatarUrl(avatarUrl) : null,
  };
}

function isProtectedByRole(member: GuildMember, protectedRoles: string[]): boolean {
  return protectedRoles.length > 0 && member.roles.cache.some((r) => protectedRoles.includes(r.id));
}

function isIgnored(member: GuildMember, ignoredRoles: string[]): boolean {
  return ignoredRoles.length > 0 && member.roles.cache.some((r) => ignoredRoles.includes(r.id));
}

/** Builds the list of identities a candidate gets compared against: role-protected members
 * (live, from the member cache) plus the guild's manual watchlist (resolving pinned members
 * live too, so an entry never goes stale). */
export async function getProtectedIdentities(
  guild: Guild,
  config: ImpersonationConfig,
  excludeUserId: string,
): Promise<ProtectedIdentity[]> {
  const out: ProtectedIdentity[] = [];
  const seenUserIds = new Set<string>();

  if (config.protected_roles.length) {
    for (const member of guild.members.cache.values()) {
      if (member.id === excludeUserId || member.user.bot) continue;
      if (!isProtectedByRole(member, config.protected_roles)) continue;
      seenUserIds.add(member.id);
      const avatarUrl = member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 });
      out.push({
        label: member.roles.cache.find((r) => config.protected_roles.includes(r.id))?.name ?? "Protected role",
        userId: member.id,
        watchlistId: null,
        username: member.user.username,
        displayName: member.nickname ?? member.user.globalName ?? member.user.username,
        avatarUrl: avatarUrl ?? null,
        avatarHash: avatarUrl ? await hashAvatarUrl(avatarUrl) : null,
      });
    }
  }

  const watchlist = await listWatchlist(guild.id);
  for (const entry of watchlist) {
    if (entry.targetUserId) {
      if (entry.targetUserId === excludeUserId || seenUserIds.has(entry.targetUserId)) continue;
      const member = guild.members.cache.get(entry.targetUserId);
      if (member) {
        const avatarUrl = member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 });
        out.push({
          label: entry.label,
          userId: member.id,
          watchlistId: entry.id,
          username: member.user.username,
          displayName: member.nickname ?? member.user.globalName ?? member.user.username,
          avatarUrl: avatarUrl ?? null,
          avatarHash: avatarUrl ? await hashAvatarUrl(avatarUrl) : null,
        });
        continue;
      }
      // Pinned member isn't cached (left, or just not seen yet) — fall through to whatever
      // manual name/avatar the entry also carries, if any, rather than dropping it silently.
    }
    if (!entry.name && !entry.avatarHash) continue;
    out.push(watchlistEntryToIdentity(entry));
  }

  return out;
}

function watchlistEntryToIdentity(entry: WatchlistEntry): ProtectedIdentity {
  return {
    label: entry.label,
    userId: null,
    watchlistId: entry.id,
    username: entry.name,
    displayName: entry.name,
    avatarUrl: null,
    avatarHash: entry.avatarHash,
  };
}

/** "everyone" scope: every other non-bot cached member counts as a protected identity too
 * (on top of roles/watchlist), capped at MAX_COMPARISONS for safety on large servers. */
function addEveryoneScope(
  guild: Guild,
  excludeUserId: string,
  existing: ProtectedIdentity[],
): ProtectedIdentity[] {
  const already = new Set(existing.map((p) => p.userId).filter(Boolean));
  const extra: ProtectedIdentity[] = [];
  for (const member of guild.members.cache.values()) {
    if (extra.length >= MAX_COMPARISONS) break;
    if (member.id === excludeUserId || member.user.bot || already.has(member.id)) continue;
    extra.push({
      label: "Server member",
      userId: member.id,
      watchlistId: null,
      username: member.user.username,
      displayName: member.nickname ?? member.user.globalName ?? member.user.username,
      avatarUrl: member.avatarURL({ size: 128 }) ?? member.user.avatarURL({ size: 128 }) ?? null,
      avatarHash: null, // hashed lazily below only for members that pass the cheap name check first
    });
  }
  return [...existing, ...extra];
}

function scoreOf(nameSimilarity: number | null, avatarDistance: number | null): number {
  const nameScore = nameSimilarity ?? 0;
  const avatarScore = avatarDistance === null ? 0 : Math.max(0, 100 - (avatarDistance / 64) * 100);
  return Math.max(nameScore, avatarScore);
}

/** Compares one identity candidate against every protected identity and returns the single
 * best match that clears either the name-similarity or avatar-distance threshold, if any. */
export async function findImpersonationMatch(
  guild: Guild,
  candidate: IdentityCandidate,
  config: ImpersonationConfig,
): Promise<ImpersonationMatch | null> {
  let pool = await getProtectedIdentities(guild, config, candidate.userId);
  if (config.compare_scope === "everyone") {
    pool = addEveryoneScope(guild, candidate.userId, pool);
  }

  let best: ImpersonationMatch | null = null;
  for (const identity of pool) {
    if (identity.userId && identity.userId === candidate.userId) continue;

    const nameSimilarity = Math.max(
      nameSimilarityPercent(candidate.username, identity.username),
      nameSimilarityPercent(candidate.displayName, identity.displayName),
      nameSimilarityPercent(candidate.username, identity.displayName),
      nameSimilarityPercent(candidate.displayName, identity.username),
    );

    // Only pay for an avatar hash (and the "everyone" pool's lazy hashing) once the name is
    // at least in the neighborhood — avoids hashing every avatar in a large "everyone" scan.
    let avatarDistance: number | null = null;
    if (candidate.avatarHash && nameSimilarity >= Math.max(40, config.name_similarity_threshold - 30)) {
      let targetHash = identity.avatarHash;
      if (!targetHash && identity.avatarUrl) targetHash = await hashAvatarUrl(identity.avatarUrl);
      if (targetHash) avatarDistance = hammingDistance(candidate.avatarHash, targetHash);
    } else if (candidate.avatarHash && identity.avatarHash) {
      avatarDistance = hammingDistance(candidate.avatarHash, identity.avatarHash);
    }

    const nameMatches = nameSimilarity >= config.name_similarity_threshold;
    const avatarMatches = avatarDistance !== null && avatarDistance <= config.avatar_max_distance;
    if (!nameMatches && !avatarMatches) continue;

    const score = scoreOf(nameSimilarity, avatarDistance);
    if (!best || score > best.score) {
      best = {
        protectedIdentity: identity,
        nameSimilarity: nameMatches ? nameSimilarity : null,
        avatarDistance: avatarMatches ? avatarDistance : null,
        score,
      };
    }
  }
  return best;
}

export { isProtectedByRole, isIgnored };
export type { AlertTrigger };
